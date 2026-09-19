import { describe, expect, it } from "vitest";
import { MexPortError, type MexErrorCode } from "../../contracts/shared.js";
import {
  exitCodeForTeamEnvelope,
  renderTeamEnvelope,
  teamEnvelope,
  teamProblemEnvelope,
  TEAM_CLI_EXIT,
} from "../envelope.js";

describe("Team CLI envelope", () => {
  it("renders one deterministic schema v1 shape without ANSI", () => {
    const envelope = teamEnvelope({
      command: "member.current",
      mode: "read",
      data: { z: 1, a: { y: true, b: false } },
      diagnostics: [
        { code: "Z_LAST", severity: "info", message: "later" },
        { code: "A_FIRST", severity: "warning", message: "first" },
      ],
    });

    expect(renderTeamEnvelope(envelope)).toBe(
      '{"command":"member.current","data":{"a":{"b":false,"y":true},"z":1},"diagnostics":[{"code":"A_FIRST","message":"first","severity":"warning"},{"code":"Z_LAST","message":"later","severity":"info"}],"mode":"read","ok":true,"problem":null,"schemaVersion":1}',
    );
    expect(renderTeamEnvelope(envelope)).not.toContain("\u001b");
    expect(exitCodeForTeamEnvelope(envelope)).toBe(TEAM_CLI_EXIT.ok);
  });

  it.each([
    ["VALIDATION_FAILED", TEAM_CLI_EXIT.validation],
    ["INVALID_REQUEST", TEAM_CLI_EXIT.usage],
    ["NOT_FOUND", TEAM_CLI_EXIT.unavailable],
    ["MIGRATION_REQUIRED", TEAM_CLI_EXIT.unavailable],
    ["REVISION_CONFLICT", TEAM_CLI_EXIT.conflict],
    ["OPERATION_INTERRUPTED", TEAM_CLI_EXIT.conflict],
    ["PATH_OUTSIDE_PROJECT", TEAM_CLI_EXIT.refused],
    ["UNAUTHORIZED", TEAM_CLI_EXIT.refused],
  ] satisfies readonly (readonly [MexErrorCode, number])[])(
    "maps %s to its typed exit",
    (code, expected) => {
      const envelope = teamProblemEnvelope(
        "member.show",
        "read",
        new MexPortError({
          title: "Expected problem",
          status: 400,
          code,
          detail: "bounded safe detail",
        }),
      );
      expect(exitCodeForTeamEnvelope(envelope)).toBe(expected);
    },
  );

  it("redacts unknown thrown errors", () => {
    const envelope = teamProblemEnvelope(
      "activity.list",
      "read",
      new Error("secret path and raw stack"),
    );
    expect(envelope.problem).toEqual({
      title: "Team command failed",
      status: 500,
      code: "INTERNAL_ERROR",
      detail: "The Team command could not be completed.",
    });
    expect(renderTeamEnvelope(envelope)).not.toContain("secret");
  });

  it("sorts Unicode diagnostics by deterministic code-unit order", () => {
    const envelope = teamEnvelope({
      command: "member.list",
      mode: "read",
      data: null,
      diagnostics: [
        { code: "\u00c4", severity: "warning", message: "latin" },
        { code: "Z", severity: "warning", message: "ascii" },
        { code: "\u03a9", severity: "warning", message: "greek" },
      ],
    });

    expect(envelope.diagnostics.map((entry) => entry.code)).toEqual(["Z", "\u00c4", "\u03a9"]);
  });
});
