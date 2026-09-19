import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TeamIdentityActivityPreviewEnvelope } from "../../contracts/workflow.js";
import { renderTeamEnvelope, teamEnvelope } from "../envelope.js";
import {
  readBoundedJsonFile,
  readTeamCommandFile,
  readTeamPreviewFile,
} from "../request-file.js";

const MEMBER_ID = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REVISION = "a".repeat(64);

describe("Team CLI request files", () => {
  it("accepts an exact authority-free mutation request", () => {
    const path = fixtureFile("request.json", memberAddRequest());
    expect(readTeamCommandFile(path, "member.add")).toEqual(memberAddRequest());
  });

  it.each([
    ["member.update", {
      operationId: "member-update-001",
      action: { kind: "member.update", memberId: MEMBER_ID, patch: { displayName: "Ada Byron" } },
      expectedRevisions: [memberExpectation()],
    }],
    ["member.deactivate", {
      operationId: "member-deactivate-001",
      action: { kind: "member.deactivate", memberId: MEMBER_ID },
      expectedRevisions: [memberExpectation()],
    }],
    ["member.reactivate", {
      operationId: "member-reactivate-001",
      action: { kind: "member.reactivate", memberId: MEMBER_ID },
      expectedRevisions: [memberExpectation()],
    }],
    ["member.select", {
      operationId: "member-select-001",
      action: { kind: "member.select", memberId: MEMBER_ID },
      expectedRevisions: [
        memberExpectation(),
        {
          target: { kind: "local", namespace: "member-selection", id: "current" },
          revision: null,
        },
      ],
    }],
    ["member.clear", {
      operationId: "member-clear-001",
      action: { kind: "member.clear" },
      expectedRevisions: [{
        target: { kind: "local", namespace: "member-selection", id: "current" },
        revision: REVISION,
      }],
    }],
    ["activity.record", {
      operationId: "activity-record-001",
      action: {
        kind: "activity.record",
        activity: {
          action: "review.completed",
          subjects: [{ kind: "file", path: "src/index.ts" }],
          workstream: { id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "workstream" },
        },
      },
      expectedRevisions: [],
    }],
  ] as const)("strictly parses %s", (kind, request) => {
    const path = fixtureFile(`${kind}.json`, request);
    expect(readTeamCommandFile(path, kind === "member.clear" ? "member.select" : kind)).toEqual(request);
  });

  it("rejects caller authority and extra fields", () => {
    const path = fixtureFile("forged.json", {
      ...memberAddRequest(),
      actor: { kind: "unknown" },
    });
    expect(() => readTeamCommandFile(path, "member.add")).toThrow(
      "missing, unsupported, or extra fields",
    );
  });

  it("reserves member deactivation for its dedicated action", () => {
    const path = fixtureFile("member-active.json", {
      ...memberAddRequest(),
      action: {
        kind: "member.add",
        member: { displayName: "Ada", gitAliases: [], active: false },
      },
    });
    expect(() => readTeamCommandFile(path, "member.add")).toThrow(
      "member input contains missing, unsupported, or extra fields",
    );
  });

  it("rejects final-component symlinks and non-regular files", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-team-cli-file-"));
    const target = join(root, "target.json");
    writeFileSync(target, JSON.stringify(memberAddRequest()));
    const link = join(root, "link.json");
    symlinkSync(target, link);
    expect(() => readBoundedJsonFile(link)).toThrow("must not be a symbolic link");

    const directory = join(root, "directory");
    mkdirSync(directory);
    expect(() => readBoundedJsonFile(directory)).toThrow("must be a regular file");
  });

  it("rejects request files over 64 KiB", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-team-cli-large-"));
    const path = join(root, "large.json");
    writeFileSync(path, "x".repeat(64 * 1024 + 1));
    expect(() => readBoundedJsonFile(path)).toThrow("exceeds 65536 bytes");
  });

  it("consumes the complete successful preview envelope and rejects fragments", () => {
    const preview = previewFixture();
    const full = teamEnvelope({
      command: "member.add",
      mode: "preview",
      data: preview,
      diagnostics: preview.preview.diagnostics,
      valid: true,
    });
    const path = fixtureRaw("preview.json", renderTeamEnvelope(full));
    expect(readTeamPreviewFile(path, "member.add")).toEqual(preview);

    const fragment = fixtureFile("fragment.json", preview);
    expect(() => readTeamPreviewFile(fragment, "member.add")).toThrow(
      "Team preview envelope contains missing",
    );
  });

  it("rejects altered command identity and outer diagnostics", () => {
    const preview = previewFixture();
    const wrongCommand = fixtureRaw("wrong-command.json", renderTeamEnvelope(teamEnvelope({
      command: "member.update",
      mode: "preview",
      data: preview,
      diagnostics: [],
    })));
    expect(() => readTeamPreviewFile(wrongCommand, "member.add")).toThrow(
      "successful schema v1 preview for this exact command",
    );

    const mismatched = fixtureFile("mismatched.json", {
      schemaVersion: 1,
      command: "member.add",
      mode: "preview",
      ok: true,
      data: preview,
      diagnostics: [{ code: "ALTERED", severity: "warning", message: "altered" }],
      problem: null,
    });
    expect(() => readTeamPreviewFile(mismatched, "member.add")).toThrow(
      "diagnostics do not match",
    );
  });
});

function memberAddRequest() {
  return {
    operationId: "member-add-001",
    action: {
      kind: "member.add",
      member: {
        displayName: "Ada Lovelace",
        gitAliases: [{ name: "Ada", email: "ada@example.com" }],
      },
    },
    expectedRevisions: [],
  } as const;
}

function previewFixture(): TeamIdentityActivityPreviewEnvelope {
  return {
    schemaVersion: 1,
    request: memberAddRequest(),
    preview: {
      valid: true,
      scope: "canonical",
      changes: [],
      localChanges: [],
      diagnostics: [],
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: { kind: "unknown" },
        occurredAt: "2026-08-27T00:00:00.000Z",
        repoState: {
          branch: "codex/team-identity-workbench",
          head: "b".repeat(40),
          dirty: false,
          observedAt: "2026-08-27T00:00:00.000Z",
        },
      },
      purposeIds: [{ purpose: "member", id: MEMBER_ID }],
      requestRevision: REVISION,
      presentationRevision: "b".repeat(64),
      previewRevision: "c".repeat(64),
    },
  };
}

function memberExpectation() {
  return {
    target: {
      kind: "artifact" as const,
      path: `.mex/team/members/${MEMBER_ID}.md`,
    },
    revision: REVISION,
  };
}

function fixtureFile(name: string, value: unknown): string {
  return fixtureRaw(name, JSON.stringify(value));
}

function fixtureRaw(name: string, value: string): string {
  const root = mkdtempSync(join(tmpdir(), "mex-team-cli-request-"));
  const path = join(root, name);
  writeFileSync(path, value);
  return path;
}
