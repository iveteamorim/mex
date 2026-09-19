import { describe, expect, it } from "vitest";
import {
  TEAM_OWNED_READ_ONLY_PATHS,
  isTeamOwnedReadOnlyPath,
  isReadOnlyPath,
  readOnlyDiagnostic,
} from "../paths.js";

describe("TeamWorkflowPort path ownership", () => {
  it("hard-reserves every canonical team path even with no configured read-only globs", () => {
    expect(TEAM_OWNED_READ_ONLY_PATHS).toEqual([
      "team/**",
      "workstreams/**",
      "inbox/**",
      "relays/**",
      "playbooks/**",
      "events/activity/**",
    ]);
    for (const path of [
      "team/members/member_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
      "workstreams/ws_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
      "inbox/proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
      "relays/relay_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
      "playbooks/playbook_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
      "playbooks/runs/run_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
      "events/activity/2026-08/event_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
    ]) {
      expect(isReadOnlyPath(path, []), path).toBe(true);
      expect(readOnlyDiagnostic(path)).toMatchObject({
        code: "WRITE_SCOPE_VIOLATION",
        file: path,
        message: expect.stringContaining("owned by TeamWorkflowPort"),
      });
    }
  });

  it("cannot be disabled by replacing wiki.readOnly and still honors added project globs", () => {
    expect(isReadOnlyPath("workstreams/example.md", ["context/**"])).toBe(true);
    expect(isReadOnlyPath("context/private.md", ["context/**"])).toBe(true);
    expect(isReadOnlyPath("context/public.md", [])).toBe(false);
    expect(isReadOnlyPath("team-notes/example.md", [])).toBe(false);
    expect(isReadOnlyPath("events/activity-log.md", [])).toBe(false);
  });

  it("closes case-alias bypasses on case-insensitive filesystems", () => {
    expect(isReadOnlyPath("TEAM/members/example.md", [])).toBe(true);
    expect(isReadOnlyPath("Events/Activity/2026-08/example.md", [])).toBe(true);
  });

  it("classifies exact prefixes across case and path separators", () => {
    expect(isTeamOwnedReadOnlyPath("inbox/proposal.md")).toBe(true);
    expect(isTeamOwnedReadOnlyPath("INBOX/proposal.md")).toBe(true);
    expect(isTeamOwnedReadOnlyPath("events\\activity\\2026-08\\event.md")).toBe(true);
    expect(isTeamOwnedReadOnlyPath("inbox")).toBe(false);
    expect(isTeamOwnedReadOnlyPath("inbox-notes/proposal.md")).toBe(false);
    expect(isTeamOwnedReadOnlyPath("events/activity-log.md")).toBe(false);
  });
});
