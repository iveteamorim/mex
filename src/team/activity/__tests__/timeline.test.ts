import { describe, expect, it } from "vitest";
import { MexPortError } from "../../contracts/shared.js";
import type { StoredActivityEvent } from "../../contracts/workflow.js";
import type { LegacyTimelineEntry } from "../legacy.js";
import { buildTimelinePage } from "../timeline.js";

const activity = (id: string, timestamp: string, revision = "a".repeat(64)): StoredActivityEvent => ({
  schemaVersion: 1,
  id,
  timestamp,
  actor: { kind: "member", memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  action: "member.updated",
  subjects: [{ kind: "file", path: ".mex/team/members/member.md" }],
  repoState: { branch: "main", head: "1".repeat(40), dirty: false, observedAt: timestamp },
  sourcePath: `.mex/events/activity/2026-08/${id}.md`,
  revision,
});

const legacy = (id: string, timestamp: string): LegacyTimelineEntry => ({
  source: "legacy",
  id,
  timestamp,
  actor: null,
  repoState: null,
  sourcePath: ".mex/events/decisions.jsonl",
  sourceLine: 1,
  kind: "note",
  message: "legacy",
  files: [],
  cwd: ".",
});

describe("buildTimelinePage", () => {
  it("uses deterministic equal-timestamp ordering and bounded cursors", () => {
    const events = [
      activity("event_01ARZ3NDEKTSV4RRFFQ69G5FAC", "2026-08-23T01:00:00.000Z"),
      activity("event_01ARZ3NDEKTSV4RRFFQ69G5FAB", "2026-08-23T01:00:00.000Z"),
    ];
    const older = legacy("legacy_z", "2026-08-22T01:00:00.000Z");

    const first = buildTimelinePage(events, [older], [], { limit: 2 });
    expect(first.items.map((entry) => entry.id)).toEqual([
      "event_01ARZ3NDEKTSV4RRFFQ69G5FAB",
      "event_01ARZ3NDEKTSV4RRFFQ69G5FAC",
    ]);
    expect(first.truncated).toBe(true);

    const second = buildTimelinePage(events, [older], [], {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((entry) => entry.id)).toEqual(["legacy_z"]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects malformed and stale cursors", () => {
    expect(() => buildTimelinePage([], [], [], { cursor: "not-a-cursor" })).toThrow(MexPortError);
    expect(() => buildTimelinePage([], [], [], { cursor: "a".repeat(4_097) })).toThrow(MexPortError);
    const first = buildTimelinePage([
      activity("event_01ARZ3NDEKTSV4RRFFQ69G5FAB", "2026-08-23T01:00:00.000Z"),
      activity("event_01ARZ3NDEKTSV4RRFFQ69G5FAC", "2026-08-22T01:00:00.000Z"),
    ], [], [], { limit: 1 });
    expect(() => buildTimelinePage([
      activity("event_01ARZ3NDEKTSV4RRFFQ69G5FAB", "2026-08-23T01:00:00.000Z", "b".repeat(64)),
      activity("event_01ARZ3NDEKTSV4RRFFQ69G5FAC", "2026-08-22T01:00:00.000Z"),
    ], [], [], { cursor: first.nextCursor ?? undefined })).toThrowError(
      expect.objectContaining({ problem: expect.objectContaining({ code: "REVISION_CONFLICT" }) }),
    );
  });

  it("filters by source and timestamp without fabricating legacy actors", () => {
    const page = buildTimelinePage(
      [activity("event_01ARZ3NDEKTSV4RRFFQ69G5FAB", "2026-08-23T01:00:00.000Z")],
      [legacy("legacy_z", "2026-08-22T01:00:00.000Z")],
      [],
      { source: "legacy", since: "2026-08-22T00:00:00.000Z" },
    );
    expect(page.items).toEqual([expect.objectContaining({ source: "legacy", actor: null })]);
  });

  it("reports source safety truncation independently from pagination", () => {
    const page = buildTimelinePage([], [], [], { limit: 25 }, true);
    expect(page).toMatchObject({
      items: [],
      nextCursor: null,
      truncated: false,
      sourceTruncated: true,
    });
  });
});
