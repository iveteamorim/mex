/**
 * The contract every wiki command is answered through.
 *
 * The assertions that matter here are the ones about pairs that must not
 * occur — `ok: false` with a zero exit, an error diagnostic with a success
 * status — because those are the shapes a caller writes a script against and
 * then trusts. They are asserted over every code in the registry rather than
 * over a handful of examples, so a code added later cannot quietly land in the
 * "no mapping, therefore success" gap.
 */

import { describe, it, expect } from "vitest";
import {
  WIKI_CLI_SCHEMA_VERSION,
  WIKI_EXIT,
  envelopeFor,
  exitCodeFor,
  renderEnvelope,
  toEnvelopeDiagnostic,
} from "../envelope.js";
import { WIKI_DIAGNOSTIC_CODES, diagnostic } from "../../model/diagnostic.js";

describe("the wiki envelope", () => {
  it("carries §15.2's four fields and nothing else", () => {
    const envelope = envelopeFor({ entities: [] });
    expect(Object.keys(envelope).sort()).toEqual(["data", "diagnostics", "ok", "schemaVersion"]);
    expect(envelope.schemaVersion).toBe(WIKI_CLI_SCHEMA_VERSION);
    expect(WIKI_CLI_SCHEMA_VERSION).toBe(1);
  });

  it("is ok exactly when no diagnostic is an error", () => {
    expect(envelopeFor(null).ok).toBe(true);
    expect(envelopeFor(null, [diagnostic("GROUNDING_STALE", "drifted")]).ok).toBe(true);
    expect(envelopeFor(null, [diagnostic("WIKI_INDEX_MISSING", "gone")]).ok).toBe(false);
  });

  it("carries every §14.4 field a diagnostic has, including remediation from the registry", () => {
    const entry = diagnostic("DUPLICATE_ENTITY_ID", "two files claim it", {
      file: "context/architecture.md",
      entityId: "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD",
      location: { startLine: 12, startOffset: 400 },
    });
    const projected = toEnvelopeDiagnostic(entry);
    expect(projected.file).toBe("context/architecture.md");
    expect(projected.entityId).toBe("mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD");
    expect(projected.location).toEqual({ startLine: 12, startOffset: 400 });
    expect(projected.remediation).toBeTruthy();
    expect(projected.severity).toBe("error");
  });

  it("omits the fields a diagnostic does not have, rather than emitting nulls", () => {
    const projected = toEnvelopeDiagnostic(diagnostic("ORPHANED_ENTITY", "nothing points at it"));
    expect(projected).not.toHaveProperty("entityId");
    expect(projected).not.toHaveProperty("location");
    expect(Object.hasOwn(projected, "file")).toBe(false);
  });

  it("sorts diagnostics worst-first, so two runs print the same bytes", () => {
    const envelope = envelopeFor(null, [
      diagnostic("GROUNDING_STALE", "b", { file: "b.md" }),
      diagnostic("WIKI_INDEX_MISSING", "a", { file: "z.md" }),
    ]);
    expect(envelope.diagnostics.map((entry) => entry.code)).toEqual([
      "WIKI_INDEX_MISSING",
      "GROUNDING_STALE",
    ]);
  });
});

describe("exit codes", () => {
  it("never pairs a failed envelope with a zero exit, for any code in the registry", () => {
    expect(WIKI_DIAGNOSTIC_CODES.length).toBeGreaterThan(40);
    let failures = 0;
    for (const code of WIKI_DIAGNOSTIC_CODES) {
      // Forced to error severity: the question is what a *failing* envelope
      // exits with, and roughly half the registry defaults to warning or info.
      const envelope = envelopeFor(null, [diagnostic(code, "planted", { severity: "error" })]);
      expect(envelope.ok).toBe(false);
      expect(exitCodeFor(envelope)).not.toBe(WIKI_EXIT.ok);
      failures += 1;
    }
    expect(failures).toBe(WIKI_DIAGNOSTIC_CODES.length);
  });

  it("never pairs a successful envelope with a non-zero exit, warnings included", () => {
    for (const code of WIKI_DIAGNOSTIC_CODES) {
      const envelope = envelopeFor(null, [diagnostic(code, "planted", { severity: "warning" })]);
      expect(envelope.ok).toBe(true);
      expect(exitCodeFor(envelope)).toBe(WIKI_EXIT.ok);
    }
  });

  it("distinguishes the four failure kinds a caller has to act on differently", () => {
    const of = (code: Parameters<typeof diagnostic>[0]) =>
      exitCodeFor(envelopeFor(null, [diagnostic(code, "x", { severity: "error" })]));
    expect(of("WIKI_INDEX_MISSING")).toBe(WIKI_EXIT.index);
    expect(of("REVISION_CONFLICT")).toBe(WIKI_EXIT.precondition);
    expect(of("WRITE_SCOPE_VIOLATION")).toBe(WIKI_EXIT.refused);
    expect(of("INVALID_OPERATION_ENVELOPE")).toBe(WIKI_EXIT.usage);
    expect(of("ORPHANED_ENTITY")).toBe(WIKI_EXIT.diagnostics);
    expect(new Set([WIKI_EXIT.index, WIKI_EXIT.precondition, WIKI_EXIT.refused, WIKI_EXIT.usage]).size).toBe(4);
  });

  it("reports the most actionable failure when several are present", () => {
    const envelope = envelopeFor(null, [
      diagnostic("WIKI_INDEX_MISSING", "no index", { severity: "error" }),
      diagnostic("WRITE_SCOPE_VIOLATION", "refused", { severity: "error" }),
    ]);
    expect(exitCodeFor(envelope)).toBe(WIKI_EXIT.refused);
  });
});

describe("the JSON rendering", () => {
  it("emits no escape byte, even when a message carries one", () => {
    // A diagnostic message can quote file content, and file content can hold
    // anything. The rule is that the *envelope* never colours; a caller's own
    // bytes are its own business, but they must not arrive as live escapes.
    // Built rather than written: a source file may not carry a literal control
    // byte, and a comment demonstrating one is a way of writing one.
    const escape = String.fromCharCode(0x1b);
    const coloured = `${escape}[31mred${escape}[0m`;
    const line = renderEnvelope(envelopeFor({ note: coloured }, [diagnostic("WIKI_PARSE_ERROR", coloured)]));
    expect(line.includes(escape)).toBe(false);
    // Not lost, either — escaped, so a caller reading the JSON gets the bytes
    // back without a terminal ever acting on them.
    expect(JSON.parse(line).data.note).toBe(coloured);
    expect(JSON.parse(line).ok).toBe(false);
  });

  it("round-trips, so an agent parses what the command meant", () => {
    const envelope = envelopeFor({ items: [1, 2, 3], truncated: true });
    expect(JSON.parse(renderEnvelope(envelope))).toEqual(envelope);
  });
});
