/**
 * The properties that are not about any one operation.
 *
 * A bug in this phase does not produce a wrong answer — it produces a corrupted
 * document a user may not notice for weeks. So the tests here are the ones that
 * would catch that: a crash between two renames, a metadata write against the
 * dialect nothing could write before, a CRLF file that must not be silently
 * normalized, a symlink out of the scaffold, and a log that must never carry
 * anybody's prose.
 */

import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseWikiMarkdown } from "../../markdown/codec.js";
import type { EntityId } from "../../model/ids.js";
import { applyOperation, applyPlannedOperation, WikiWriteRecoveryError } from "../apply.js";
import { planOperation } from "../plan.js";
import { applyPlannedOperationBatch, planOperationBatch } from "../batch.js";
import { previewHashOf, previewPlan } from "../preview.js";
import {
  acceptedOperations,
  appendAudit,
  auditRecord,
  OPERATION_LOG_MAX_BYTES,
  OPERATION_LOG_MAX_ENTRIES,
  OperationLogPathError,
  operationLogPath,
  readAuditLog,
  recordFor,
  restoreOperationLogExact,
} from "../audit.js";
import { assertWritablePath, checkContainment, resolveThroughSymlinks, WritePathError } from "../paths.js";
import { GATEWAY, JWT, PATTERN, codesOf, envelope, makeScaffold, type Scaffold } from "./helpers.js";

const scaffolds: Scaffold[] = [];
const CREATED_COLLISION = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJX" as EntityId;
function scaffold(files?: Record<string, string>): Scaffold {
  const made = makeScaffold(files);
  scaffolds.push(made);
  return made;
}
afterEach(() => {
  while (scaffolds.length > 0) scaffolds.pop()!.dispose();
});

describe("a crash between two renames", () => {
  /**
   * The `move-entry` envelope, and the hook that kills the process after the
   * first file lands.
   *
   * There is no portable way to `SIGKILL` a process mid-apply inside a test
   * runner, so the kill is injected at the seam: `onFileWritten` throws after
   * the first rename, which leaves precisely the on-disk state a real crash
   * would leave, and the recovery path then runs against real bytes.
   */
  function moveEnvelope(target: Scaffold): Record<string, unknown> {
    return envelope(
      target,
      "move-entry",
      { file: "patterns/problem-documents.md", insertAt: { at: "end-of-file" } },
      { entityId: GATEWAY, opId: "op-crashing-move" },
    );
  }

  it("leaves the entity present, never nowhere", () => {
    const target = scaffold();
    const env = moveEnvelope(target);

    expect(() =>
      applyOperation(env, {
        scaffoldRoot: target.root,
        onFileWritten: () => {
          throw new Error("SIGKILL");
        },
      }),
    ).toThrow("SIGKILL");

    // **The constraint, and the only one that is absolute:** the entity is
    // still somewhere. Writing gains before losses means the crash residue is a
    // duplicate id — visible, deterministically shadowed by MIN(entity_key),
    // and completable — rather than a vanished entity, which no probability
    // makes acceptable.
    const source = target.read("context/architecture.md");
    const destination = target.read("patterns/problem-documents.md");
    expect(destination).toContain(GATEWAY);
    expect(source).toContain(GATEWAY);

    // Both claimants parse: the residue is a state the index is built to hold
    // and report, not a broken file.
    for (const [path, text] of [["context/architecture.md", source], ["patterns/problem-documents.md", destination]] as const) {
      expect(parseWikiMarkdown({ path, text }).diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    }

    // And the log says what was in flight: an intent with no completion.
    const record = recordFor(readAuditLog(target.root), "op-crashing-move");
    expect(record.intent).not.toBeNull();
    expect(record.complete).toBeNull();
  });

  it("converges when the same opId is replayed", () => {
    const target = scaffold();
    const env = moveEnvelope(target);
    expect(() =>
      applyOperation(env, {
        scaffoldRoot: target.root,
        onFileWritten: () => {
          throw new Error("SIGKILL");
        },
      }),
    ).toThrow();

    // Replay finishes the move rather than starting a second one.
    const resumed = applyOperation(env, { scaffoldRoot: target.root });
    expect(resumed.ok ? [] : codesOf(resumed.diagnostics)).toEqual([]);

    const source = target.read("context/architecture.md");
    const destination = target.read("patterns/problem-documents.md");
    expect(source).not.toContain(GATEWAY);
    // Exactly once in the destination — a resume that re-inserted would leave
    // two copies in one file, which is the failure a naive retry produces.
    expect(destination.split(GATEWAY)).toHaveLength(2);
    expect(parseWikiMarkdown({ path: "patterns/problem-documents.md", text: destination }).diagnostics).toEqual([]);

    // And it converges: replaying again changes nothing at all.
    const settled = target.files();
    const again = applyOperation(env, { scaffoldRoot: target.root });
    expect(again.ok).toBe(true);
    expect(again.replayed).toBe(true);
    expect(target.files()).toEqual(settled);
    expect(acceptedOperations(readAuditLog(target.root)).filter((entry) => entry.opId === "op-crashing-move")).toHaveLength(1);
  });

  it("rejects a third claimant instead of treating saturated ambiguity as exact move recovery", () => {
    const compatibility = scaffold();
    const compatibilityEnvelope = moveEnvelope(compatibility);
    expect(() => applyOperation(compatibilityEnvelope, {
      scaffoldRoot: compatibility.root,
      onFileWritten: () => { throw new Error("SIGKILL"); },
    })).toThrow("SIGKILL");
    writeFileSync(
      join(compatibility.root, "z-third-claimant.md"),
      compatibility.read("context/architecture.md"),
      "utf8",
    );
    const compatibilityBefore = compatibility.files();
    const compatibilityResume = applyOperation(compatibilityEnvelope, {
      scaffoldRoot: compatibility.root,
    });
    expect(compatibilityResume.ok).toBe(false);
    expect(codesOf(compatibilityResume.diagnostics)).toContain("CONTENT_HASH_CONFLICT");
    expect(compatibility.files()).toEqual(compatibilityBefore);

    const planned = scaffold();
    const batch = planOperationBatch([moveEnvelope(planned)], { scaffoldRoot: planned.root });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(() => applyPlannedOperationBatch(batch.plan, {
      scaffoldRoot: planned.root,
      expectedPreviewRevision: batch.plan.previewRevision,
      onFileWritten: () => { throw new Error("SIGKILL"); },
    })).toThrow("SIGKILL");
    writeFileSync(
      join(planned.root, "z-third-claimant.md"),
      planned.read("context/architecture.md"),
      "utf8",
    );
    const plannedBefore = planned.files();
    const plannedResume = applyPlannedOperationBatch(batch.plan, {
      scaffoldRoot: planned.root,
      expectedPreviewRevision: batch.plan.previewRevision,
    });
    expect(plannedResume.ok).toBe(false);
    expect(codesOf(plannedResume.diagnostics)).toContain("CONTENT_HASH_CONFLICT");
    expect(planned.files()).toEqual(plannedBefore);
  });

  it("does not mint a second entity when an interrupted create is replayed", () => {
    // The crash window §11.3's shape cannot see: for `create-entry` there is no
    // precondition that can catch a repeat, so a replay after a write that
    // landed but was never recorded would mint a *second* entity with a *new*
    // id. Silent knowledge duplication, from a correctly-implemented spec.
    const target = scaffold();
    const env = envelope(
      target,
      "create-entry",
      {
        file: "context/architecture.md",
        insertAt: { at: "end-of-file" },
        type: "convention",
        title: "Name services after their domain",
        body: "Not after the team.",
        headingDepth: 2,
      },
      { opId: "op-crashing-create" },
    );

    expect(() =>
      applyOperation(env, {
        scaffoldRoot: target.root,
        onFileWritten: () => {
          throw new Error("SIGKILL");
        },
      }),
    ).toThrow();

    const afterCrash = parseWikiMarkdown({
      path: "context/architecture.md",
      text: target.read("context/architecture.md"),
    });
    expect(afterCrash.entities).toHaveLength(4);
    const mintedId = recordFor(readAuditLog(target.root), "op-crashing-create").intent!.createdIds[0]!;

    const resumed = applyOperation(env, { scaffoldRoot: target.root });
    expect(resumed.ok).toBe(true);

    const afterResume = parseWikiMarkdown({
      path: "context/architecture.md",
      text: target.read("context/architecture.md"),
    });
    // Still four entities, and the one it minted keeps the id the intent line
    // recorded — which is what the intent line exists to carry.
    expect(afterResume.entities).toHaveLength(4);
    expect(afterResume.entities.map((entry) => entry.entity.id)).toContain(mintedId);
    expect(acceptedOperations(readAuditLog(target.root))).toHaveLength(1);
  });
});

describe("replay, and the log as its only oracle", () => {
  it("survives deleting wiki.db, because the log is not in it", async () => {
    const { rebuildWikiIndex } = await import("../../index/rebuild.js");
    const { bindIndexDirectory, removeIndexFiles } = await import("../../index/dbfile.js");
    const target = scaffold();
    const indexPath = join(target.root, "wiki.db");
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath });

    const env = envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT });
    expect(applyOperation(env, { scaffoldRoot: target.root, indexPath }).ok).toBe(true);
    const after = target.files();

    // The index is disposable by invariant. If idempotency lived in it, this
    // line would destroy the guarantee.
    removeIndexFiles(indexPath, bindIndexDirectory(indexPath, target.root));
    expect(existsSync(indexPath)).toBe(false);

    const replayed = applyOperation(env, { scaffoldRoot: target.root, indexPath });
    expect(replayed.replayed).toBe(true);
    expect(target.files()).toEqual(after);
  });

  it("refuses the same opId carrying a different payload", () => {
    const target = scaffold();
    const first = envelope(target, "set-property", { property: "status", value: "deprecated" }, {
      entityId: JWT,
      opId: "op-reused",
    });
    expect(applyOperation(first, { scaffoldRoot: target.root }).ok).toBe(true);
    const after = target.files();

    const second = envelope(target, "set-property", { property: "status", value: "archived" }, {
      entityId: JWT,
      opId: "op-reused",
    });
    const result = applyOperation(second, { scaffoldRoot: target.root });

    // A validation failure, not a no-op. Silently accepting it would make the
    // audit log a work of fiction: one line describing two different changes.
    expect(result.ok).toBe(false);
    expect(result.replayed).toBe(false);
    expect(codesOf(result.diagnostics)).toContain("INVALID_OPERATION_ENVELOPE");
    expect(target.files()).toEqual(after);
  });

  it("degrades a malformed log line to a diagnostic and touches no Markdown", () => {
    const target = scaffold();
    expect(
      applyOperation(envelope(target, "archive-entry", {}, { entityId: PATTERN }), { scaffoldRoot: target.root }).ok,
    ).toBe(true);

    // A line nobody can parse, in the middle of the file.
    const path = operationLogPath(target.root);
    writeFileSync(path, `${readFileSync(path, "utf-8")}{"v":1,"phase":"comp\n`, "utf-8");
    const before = target.files();

    const log = readAuditLog(target.root);
    expect(codesOf(log.diagnostics)).toEqual(["MALFORMED_OPERATION_LOG"]);
    // The readable lines are still readable: one bad line does not take out the
    // run, which is what the code's remediation text promises.
    expect(log.entries.length).toBeGreaterThan(0);

    const applied = applyOperation(
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT }),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);
    expect(codesOf(applied.diagnostics)).toContain("MALFORMED_OPERATION_LOG");
    expect(target.read("patterns/problem-documents.md")).toBe(before["patterns/problem-documents.md"]);
  });
});

describe("the audit log's privacy boundary", () => {
  it("enforces one shared byte budget before reads or appends", () => {
    const target = scaffold();
    mkdirSync(join(target.root, "events"), { recursive: true });
    const path = operationLogPath(target.root);
    const bounded = " ".repeat(OPERATION_LOG_MAX_BYTES);
    writeFileSync(path, bounded, "utf8");
    expect(() => appendAudit(target.root, {
      v: 1,
      phase: "intent",
      opId: "op-audit-budget",
      type: "update-entry",
      entityIds: [JWT],
      createdIds: [],
      actor: { kind: "system", id: "audit-budget-test" },
      timestamp: "2026-08-27T00:00:00.000Z",
      files: ["context/architecture.md"],
      payloadHash: "a".repeat(64),
      revisions: [{ entityId: JWT as never, before: 1, after: 2 }],
    })).toThrow(OperationLogPathError);
    expect(readFileSync(path, "utf8")).toBe(bounded);

    writeFileSync(path, `${bounded}x`, "utf8");
    expect(readAuditLog(target.root).diagnostics.map((entry) => entry.code))
      .toContain("MALFORMED_OPERATION_LOG");
    expect(() => planOperation(
      envelope(target, "update-entry", { summary: "Never planned." }, { entityId: JWT }),
      { scaffoldRoot: target.root },
    )).toThrow(OperationLogPathError);
    expect(readFileSync(path, "utf8")).toBe(`${bounded}x`);

    const tooManyEntries = "{}\n".repeat(OPERATION_LOG_MAX_ENTRIES + 1);
    writeFileSync(path, tooManyEntries, "utf8");
    expect(readAuditLog(target.root).diagnostics.map((entry) => entry.code))
      .toContain("MALFORMED_OPERATION_LOG");
  });

  it("rejects symlinked directories and deterministic ancestor/leaf retarget races", () => {
    const makeEntry = (target: Scaffold, opId: string) => {
      const planned = planOperation(
        envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT, opId }),
        { scaffoldRoot: target.root },
      );
      expect(planned.ok).toBe(true);
      if (!planned.ok) throw new Error("expected a valid audit fixture plan");
      return auditRecord(planned.plan, "intent");
    };

    const directoryTarget = scaffold();
    const directoryOutside = resolve(directoryTarget.root, "..", `audit-dir-${Date.now()}`);
    mkdirSync(directoryOutside);
    symlinkSync(directoryOutside, join(directoryTarget.root, "events"), "dir");
    expect(() => appendAudit(directoryTarget.root, makeEntry(directoryTarget, "op-audit-dir")))
      .toThrow(OperationLogPathError);
    expect(existsSync(join(directoryOutside, "operations.jsonl"))).toBe(false);
    rmSync(directoryOutside, { recursive: true, force: true });

    const ancestorTarget = scaffold();
    const ancestorOutside = resolve(ancestorTarget.root, "..", `audit-ancestor-${Date.now()}`);
    mkdirSync(join(ancestorTarget.root, "events"));
    mkdirSync(ancestorOutside);
    expect(() => appendAudit(ancestorTarget.root, makeEntry(ancestorTarget, "op-audit-ancestor"), {
      beforeOpen: () => {
        renameSync(join(ancestorTarget.root, "events"), join(ancestorTarget.root, "events-original"));
        symlinkSync(ancestorOutside, join(ancestorTarget.root, "events"), "dir");
      },
    })).toThrow(OperationLogPathError);
    expect(existsSync(join(ancestorOutside, "operations.jsonl"))).toBe(false);
    rmSync(ancestorOutside, { recursive: true, force: true });

    const leafTarget = scaffold();
    const first = makeEntry(leafTarget, "op-audit-leaf-first");
    appendAudit(leafTarget.root, first);
    const leafOutside = resolve(leafTarget.root, "..", `audit-leaf-${Date.now()}.jsonl`);
    writeFileSync(leafOutside, "outside stays exact\n", "utf8");
    expect(() => appendAudit(leafTarget.root, makeEntry(leafTarget, "op-audit-leaf-second"), {
      beforeOpen: () => {
        renameSync(operationLogPath(leafTarget.root), `${operationLogPath(leafTarget.root)}.original`);
        symlinkSync(leafOutside, operationLogPath(leafTarget.root), "file");
      },
    })).toThrow(OperationLogPathError);
    expect(readFileSync(leafOutside, "utf8")).toBe("outside stays exact\n");
    expect(readAuditLog(leafTarget.root).diagnostics.map((entry) => entry.code)).toContain("MALFORMED_OPERATION_LOG");
    rmSync(leafOutside, { force: true });
  });

  it("carries no body, prompt or transcript", () => {
    const target = scaffold();
    const secret = "PROPRIETARY-PROSE-THAT-MUST-NOT-BE-LOGGED";
    const applied = applyOperation(
      envelope(
        target,
        "create-entry",
        {
          file: "context/architecture.md",
          insertAt: { at: "end-of-file" },
          type: "convention",
          title: "A convention",
          body: `${secret} and more of it.`,
          headingDepth: 2,
        },
        { reason: "recording a convention" },
      ),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);

    // The body reached the Markdown — otherwise its absence from the log proves
    // nothing, since nothing was written anywhere.
    expect(target.read("context/architecture.md")).toContain(secret);

    const raw = readFileSync(operationLogPath(target.root), "utf-8");
    expect(raw).not.toContain(secret);
    // The concise reason is explicitly permitted by §11.4 and is there.
    expect(raw).toContain("recording a convention");

    // Field by field, so a body arriving under some future key name is caught
    // rather than only the one string being checked for.
    for (const entry of readAuditLog(target.root).entries) {
      expect(Object.keys(entry).sort()).toEqual(
        ["actor", "createdIds", "entityIds", "files", "opId", "payloadHash", "phase", "reason", "revisions", "timestamp", "type", "v"].sort(),
      );
    }
  });

  it("fabricates nothing for a hand-edited file", () => {
    const target = scaffold();
    // A human edits Markdown directly, as they always may.
    target.write("context/architecture.md", target.read("context/architecture.md").replace("status: promoted", "status: deprecated"));

    // The edit is valid and is ingested normally...
    const parsed = parseWikiMarkdown({ path: "context/architecture.md", text: target.read("context/architecture.md") });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entities.some((entry) => entry.entity.status === "deprecated")).toBe(true);

    // ...and no actor, no operation and no audit record were invented for it.
    expect(existsSync(operationLogPath(target.root))).toBe(false);
    expect(readAuditLog(target.root).entries).toEqual([]);
  });
});

describe("a block-level entity is written scoped", () => {
  it("leaves the comment's other keys, key order and inline comments byte-identical", () => {
    const withComment = `# Patterns

Prose above.

<!-- mex:entity
id: ${PATTERN}
type: pattern
# this note explains the status and must survive
status: promoted
revision: 1
topics: []
-->
## Return problem documents

Every handler returns a problem document.

Prose below.
`;
    const target = scaffold({ "patterns/problem-documents.md": withComment });
    const applied = applyOperation(
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: PATTERN }),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);

    const after = target.read("patterns/problem-documents.md");
    expect(after).toContain("# this note explains the status and must survive");
    // Key order preserved, which a whole-map re-render does not do.
    expect([...after.matchAll(/^(\w+):/gm)].map((match) => match[1])).toEqual(["id", "type", "status", "revision", "topics"]);
    // Only two lines differ, and both are the ones the operation names.
    const changed = after.split("\n").filter((line, index) => line !== withComment.split("\n")[index]);
    expect(changed.sort()).toEqual(["revision: 2", "status: deprecated"]);
  });

  it("does the same for a file-level entity, without disturbing sibling frontmatter keys", () => {
    const target = scaffold();
    const before = target.read("context/architecture.md");
    const arch = parseWikiMarkdown({ path: "context/architecture.md", text: before }).entities[0]!.entity;
    expect(arch.location.metadataStart).toBeGreaterThan(0);

    const applied = applyOperation(
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: arch.id }),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);

    const after = target.read("context/architecture.md");
    expect(after).toContain("# keep this note; a whole-map rewrite would eat it");
    // The frontmatter block's own keys, in order. Scoped to the block, since
    // the file also carries block entities whose comment YAML is column-zero.
    const frontmatter = after.slice(0, after.indexOf(String.fromCharCode(10) + "---", 4));
    expect([...frontmatter.matchAll(/^(\w+):/gm)].map((match) => match[1])).toEqual([
      "name",
      "description",
      "mex",
      "last_updated",
    ]);
    const changed = after.split("\n").filter((line, index) => line !== before.split("\n")[index]);
    expect(changed.sort()).toEqual(["  revision: 2", "  status: deprecated"]);
  });
});

describe("a CRLF file keeps its line endings", () => {
  const CRLF_MD = `<!-- mex:entity\r\nid: ${PATTERN}\r\ntype: pattern\r\nstatus: promoted\r\nrevision: 1\r\n-->\r\n## Return problem documents\r\n\r\nEvery handler returns a problem document.\r\n\r\nProse below.\r\n`;

  /** Every operation this file can carry, run one after another on one file. */
  it("survives set-property, update-entry, add-relation, add-source and create-entry", () => {
    const target = scaffold({ "patterns/problem-documents.md": CRLF_MD });
    const path = "patterns/problem-documents.md";
    expect(target.read(path)).not.toMatch(/[^\r]\n/);

    const steps: [string, unknown, string | undefined][] = [
      ["set-property", { property: "status", value: "deprecated" }, PATTERN],
      ["update-entry", { body: "Every handler returns a problem document, with a type URI." }, PATTERN],
      ["add-relation", { relation: { type: "depends_on", target: JWT } }, PATTERN],
      ["add-source", { source: { type: "commit", commit: "a1b2c3d4e5f6789012345678901234567890abcd" } }, PATTERN],
      [
        "create-entry",
        {
          file: path,
          insertAt: { at: "end-of-file" },
          type: "convention",
          title: "Name error codes",
          body: "Use a stable slug.",
          headingDepth: 2,
        },
        undefined,
      ],
    ];

    for (const [type, payload, entityId] of steps) {
      const applied = applyOperation(
        envelope(target, type, payload, entityId === undefined ? {} : { entityId }),
        { scaffoldRoot: target.root },
      );
      expect(applied.ok ? [] : codesOf(applied.diagnostics), `${type} should apply`).toEqual([]);

      const text = target.read(path);
      // **No lone LF anywhere.** A single normalized line ending here is the
      // whole-file corruption HARD 2 is about: a scope check performed against
      // normalized text passes while every terminator in the file is rewritten.
      expect(text, `${type} introduced a lone LF`).not.toMatch(/[^\r]\n/);
      expect(text).not.toMatch(/\r\r/);
    }

    // And the result is still readable, with both entities present.
    const parsed = parseWikiMarkdown({ path, text: target.read(path) });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entities).toHaveLength(2);
  });

  it("keeps a CRLF file's precondition acceptable, which is why hashes are normalized", () => {
    // D6: the precondition hash is over LF-normalized text, so the hash minted
    // from a CRLF checkout matches the one an LF checkout would mint. If that
    // were not so, an operation planned on Windows would be rejected on Linux.
    const crlf = scaffold({ "patterns/problem-documents.md": CRLF_MD });
    const lf = scaffold({ "patterns/problem-documents.md": CRLF_MD.replace(/\r\n/g, "\n") });
    expect(crlf.entity(PATTERN).location.entityContentHash).toBe(lf.entity(PATTERN).location.entityContentHash);
  });
});

describe("path containment", () => {
  it("resolves a path that does not exist yet, through its nearest existing ancestor", () => {
    const target = scaffold();
    const resolved = resolveThroughSymlinks(join(target.root, "context", "brand-new", "file.md"));
    expect(resolved.endsWith(join("brand-new", "file.md"))).toBe(true);
    // `realpathSync` throws ENOENT on a path that does not exist, and
    // `create-entry` writes new files by definition — so the read side's
    // approach of realpath-ing the leaf cannot be reused as-is.
    expect(() => resolveThroughSymlinks(join(target.root, "nope", "nope", "nope.md"))).not.toThrow();
  });

  it("rejects a lexical escape without touching the filesystem", () => {
    const target = scaffold();
    const result = checkContainment(target.root, "../outside.md");
    expect(result.diagnostic?.code).toBe("PATH_OUTSIDE_SCAFFOLD");
    expect(result.diagnostic?.severity).toBe("error");
  });

  it("rejects a symlink whose target is outside the scaffold, with the read side's code", () => {
    const target = scaffold();
    const outside = resolve(target.root, "..", `escape-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.md"), "# Not yours\n", "utf-8");

    let linked = true;
    try {
      symlinkSync(join(outside, "secret.md"), join(target.root, "context", "linked.md"), "file");
    } catch {
      // Windows refuses symlinks without developer mode. The *rule* is still
      // asserted below through the same function the read side calls, so the
      // check does not silently disappear on this machine — the same reasoning
      // P3 used for the discovery walk.
      linked = false;
    }

    if (linked) {
      const result = checkContainment(target.root, "context/linked.md");
      expect(result.diagnostic?.code).toBe("PATH_OUTSIDE_SCAFFOLD");

      const planned = planOperation(
        envelope(target, "create-entry", {
          file: "context/linked.md",
          insertAt: { at: "end-of-file" },
          type: "convention",
          title: "Should not land",
          body: "Nowhere.",
          headingDepth: 2,
        }),
        { scaffoldRoot: target.root },
      );
      expect(planned.ok).toBe(false);
      expect(codesOf(planned.diagnostics)).toContain("PATH_OUTSIDE_SCAFFOLD");
      expect(readFileSync(join(outside, "secret.md"), "utf-8")).toBe("# Not yours\n");
    }

    // Unconditionally: the same function the read side uses gives the same
    // answer for a path outside the root.
    expect(checkContainment(target.root, join("..", "escape", "secret.md")).diagnostic?.code).toBe(
      "PATH_OUTSIDE_SCAFFOLD",
    );
  });

  it("fails closed on anything that is not Markdown or its temp file", () => {
    const target = scaffold();
    expect(() => assertWritablePath(target.root, join(target.root, "context", "note.md"))).not.toThrow();
    expect(() => assertWritablePath(target.root, join(target.root, "context", "note.md.tmp-a1b2c3"))).not.toThrow();
    // The guard behind the lint exemption, doing the job the lint cannot.
    expect(() => assertWritablePath(target.root, join(target.root, "config.json"))).toThrow(WritePathError);
    expect(() => assertWritablePath(target.root, join(target.root, "wiki.db"))).toThrow(WritePathError);
    expect(() => assertWritablePath(target.root, resolve(target.root, "..", "elsewhere.md"))).toThrow(WritePathError);
    // Not `*.md`: discovery walks for Markdown, so a temp file named `.md`
    // would be indexed half-written by a concurrent rebuild.
    expect(() => assertWritablePath(target.root, join(target.root, "context", "note.tmp.md"))).not.toThrow();
  });
});

describe("the re-parse check, which the scope check cannot replace", () => {
  it("refuses a body that would smuggle an entity in", () => {
    // The attack the scope check is structurally blind to. Every byte written
    // here is **inside** the declared body range, so `checkOnlyRangesChanged`
    // is satisfied — and the file now holds an entity the operation never
    // named, with an id its actor chose. Only re-parsing the produced text and
    // comparing the entity set catches it.
    const target = scaffold();
    const smuggled = [
      "Terminates TLS.",
      "",
      "<!-- mex:entity",
      "id: mx_01M0SR8CQEWXGWE0M6ZAX4KBJE",
      "type: decision",
      "status: promoted",
      "revision: 1",
      "-->",
      "## A decision nobody approved",
      "",
      "Smuggled in through a body.",
    ].join(String.fromCharCode(10));

    const before = target.files();
    const planned = planOperation(
      envelope(target, "update-entry", { body: smuggled }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root },
    );

    expect(planned.ok).toBe(false);
    expect(codesOf(planned.diagnostics)).toContain("WRITE_SCOPE_VIOLATION");
    expect(planned.ok ? "" : planned.diagnostics[0]!.message).toContain("would introduce entity");

    // And apply refuses it too, rather than only the planner.
    const applied = applyOperation(
      envelope(target, "update-entry", { body: smuggled }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(false);
    expect(target.files()).toEqual(before);
  });

  it("refuses a body that would swallow the entity after it", () => {
    // The other direction, and the more likely accident: a body ending inside
    // what would become the next entity's metadata. Again every byte is inside
    // the declared range; again only the re-parse sees that an entity the
    // operation did not name has gone.
    const target = scaffold();
    const before = target.files();
    const swallowing = ["Terminates TLS.", "", "<!-- mex:entity", "id: not-closed"].join(String.fromCharCode(10));

    const planned = planOperation(
      envelope(target, "update-entry", { body: swallowing }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root },
    );
    expect(planned.ok).toBe(false);
    expect(codesOf(planned.diagnostics)).toContain("WRITE_SCOPE_VIOLATION");
    expect(target.files()).toEqual(before);
  });

  it("still allows a body that merely mentions the marker in prose", () => {
    // The check must not be a ban on the string. A fenced code block holding
    // the marker is content — the codec has said so since P2b — and refusing it
    // would make the engine unable to document itself.
    const target = scaffold();
    const documenting = [
      "Terminates TLS. Metadata looks like this:",
      "",
      "```markdown",
      "<!-- mex:entity",
      "id: mx_01M0SR8CQEWXGWE0M6ZAX4KBJE",
      "-->",
      "```",
    ].join(String.fromCharCode(10));

    const applied = applyOperation(
      envelope(target, "update-entry", { body: documenting }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok ? [] : codesOf(applied.diagnostics)).toEqual([]);
    expect(target.read("context/architecture.md")).toContain("```markdown");
    expect(
      parseWikiMarkdown({ path: "context/architecture.md", text: target.read("context/architecture.md") }).entities,
    ).toHaveLength(3);
  });
});

describe("preconditions and the preview binding", () => {
  it("requires a content hash for an operation that mutates an existing entity", () => {
    const target = scaffold();
    const unconditional = {
      opId: "op-unconditional",
      type: "update-entry",
      entityId: JWT,
      actor: { kind: "agent" as const, id: "p5-tests" },
      timestamp: "2026-08-24T10:00:00.000Z",
      payload: { body: "Overwritten without asking." },
    };

    // §11.1 makes the precondition optional; combined with replay that makes an
    // unconditional update a loaded gun, so the pipeline requires it.
    const rejected = planOperation(unconditional, { scaffoldRoot: target.root });
    expect(rejected.ok).toBe(false);
    expect(codesOf(rejected.diagnostics)).toContain("INVALID_OPERATION_ENVELOPE");

    // A deliberate unconditional write is expressed, not implied. P6's
    // migration is the caller this exists for.
    const allowed = planOperation(unconditional, { scaffoldRoot: target.root, unconditional: true });
    expect(allowed.ok).toBe(true);
  });

  it("refuses to apply a preview against a tree that has since moved", () => {
    const target = scaffold();
    const env = envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT });
    const planned = planOperation(env, { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const previewHash = previewPlan(planned.plan).previewHash;

    // Someone edits a *different* entity in the same file between review and
    // apply. The subject's own precondition still holds, so this is exactly the
    // case a hash over the whole tree exists to catch and a per-entity
    // precondition cannot.
    target.write(
      "context/architecture.md",
      target.read("context/architecture.md").replace("Terminates TLS", "Terminates TLS (edited)"),
    );
    const before = target.files();

    const bound = applyOperation(env, { scaffoldRoot: target.root, previewHash });
    expect(bound.ok).toBe(false);
    expect(codesOf(bound.diagnostics)).toContain("CONTENT_HASH_CONFLICT");
    expect(target.files()).toEqual(before);

    // Unbound, the same apply succeeds and carries the concurrent edit through,
    // because it re-plans against the tree as it now is.
    const unbound = applyOperation(env, { scaffoldRoot: target.root });
    expect(unbound.ok).toBe(true);
    expect(target.read("context/architecture.md")).toContain("Terminates TLS (edited)");
    expect(target.entity(JWT).status).toBe("deprecated");
  });

  it("covers the base version of every file, not only the proposal", () => {
    // A hash over the proposed bytes alone would be the same for two trees that
    // happen to reach the same result from different starting points — so an
    // approval could be applied to a tree it was never reviewed against, which
    // is the one thing the hash exists to prevent.
    const target = scaffold();
    const env = envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT });
    const first = planOperation(env, { scaffoldRoot: target.root });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const hashes = first.plan.files.map((file) => file.baseFileHash);
    expect(hashes.every((hash) => hash.length === 64)).toBe(true);
    expect(previewPlan(first.plan).previewHash).not.toBe(
      previewHashOf({ ...first.plan, files: first.plan.files.map((file) => ({ ...file, baseFileHash: "0".repeat(64) })) }),
    );
  });

  it("is bound to the payload as well as the tree", () => {
    const target = scaffold();
    const stableOpId = "op-stable-preview";
    const first = planOperation(
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT, opId: stableOpId }),
      { scaffoldRoot: target.root },
    );
    const second = planOperation(
      envelope(target, "set-property", { property: "status", value: "archived" }, { entityId: JWT }),
      { scaffoldRoot: target.root },
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(previewPlan(first.plan).previewHash).not.toBe(previewPlan(second.plan).previewHash);

    // And stable: the same plan over the same tree hashes the same, or the
    // first spurious mismatch teaches everyone to bypass the check.
    const again = planOperation(
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT, opId: stableOpId }),
      { scaffoldRoot: target.root },
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(previewPlan(again.plan).previewHash).toBe(previewPlan(first.plan).previewHash);
  });
});

describe("the executable preview plan", () => {
  it("reserves generated ids by complete claimant absence through apply and recovery", () => {
    const request = (target: Scaffold, opId: string) => envelope(
      target,
      "create-entry",
      {
        file: "context/architecture.md",
        insertAt: { at: "end-of-file" },
        type: "convention",
        title: "Generated ids stay unique",
        body: "The complete claimant corpus is the authority.",
        headingDepth: 2,
      },
      { opId },
    );
    const foreignClaimant = `<!-- mex:entity
id: ${CREATED_COLLISION}
type: convention
status: promoted
revision: 1
-->
## Foreign claimant

This claimant was not part of the reviewed create.
`;

    const fresh = scaffold();
    const freshPlan = planOperation(request(fresh, "op-created-id-fresh"), {
      scaffoldRoot: fresh.root,
      generateId: () => CREATED_COLLISION,
    });
    expect(freshPlan.ok).toBe(true);
    if (!freshPlan.ok) return;
    expect(freshPlan.plan.createdIds).toEqual([CREATED_COLLISION]);
    expect(parseWikiMarkdown({ path: "z-foreign-created-id.md", text: foreignClaimant })
      .entities.map((entry) => entry.entity.id)).toContain(CREATED_COLLISION);
    writeFileSync(join(fresh.root, "z-foreign-created-id.md"), foreignClaimant, "utf8");
    const freshBefore = fresh.files();
    const freshResult = applyPlannedOperation(freshPlan.plan, {
      scaffoldRoot: fresh.root,
      expectedPreviewHash: previewHashOf(freshPlan.plan),
    });
    expect(freshResult.ok).toBe(false);
    expect(codesOf(freshResult.diagnostics)).toContain("CONTENT_HASH_CONFLICT");
    expect(fresh.files()).toEqual(freshBefore);
    expect(existsSync(operationLogPath(fresh.root))).toBe(false);

    const recovery = scaffold();
    const recoveryPlan = planOperation(request(recovery, "op-created-id-recovery"), {
      scaffoldRoot: recovery.root,
      generateId: () => CREATED_COLLISION,
    });
    expect(recoveryPlan.ok).toBe(true);
    if (!recoveryPlan.ok) return;
    expect(() => applyPlannedOperation(recoveryPlan.plan, {
      scaffoldRoot: recovery.root,
      expectedPreviewHash: previewHashOf(recoveryPlan.plan),
      onFileWritten: () => { throw new Error("SIGKILL"); },
    })).toThrow("SIGKILL");
    writeFileSync(join(recovery.root, "z-foreign-created-id.md"), foreignClaimant, "utf8");
    const recoveryBefore = recovery.files();
    const auditBefore = readFileSync(operationLogPath(recovery.root), "utf8");
    const recoveryResult = applyPlannedOperation(recoveryPlan.plan, {
      scaffoldRoot: recovery.root,
      expectedPreviewHash: previewHashOf(recoveryPlan.plan),
    });
    expect(recoveryResult.ok).toBe(false);
    expect(codesOf(recoveryResult.diagnostics)).toContain("CONTENT_HASH_CONFLICT");
    expect(recovery.files()).toEqual(recoveryBefore);
    expect(readFileSync(operationLogPath(recovery.root), "utf8")).toBe(auditBefore);
  });

  it("holds the shared cross-process writer lease across revalidation and every write", async () => {
    const { acquireWikiMaintenanceLease, WikiMaintenanceLockedError } = await import("../../index/dbfile.js");
    const target = scaffold();
    const planned = planOperation(
      envelope(
        target,
        "set-property",
        { property: "status", value: "deprecated" },
        { entityId: JWT, opId: "op-lease-boundary" },
      ),
      { scaffoldRoot: target.root },
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    let contentionObserved = false;

    const result = applyPlannedOperation(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewHash: previewHashOf(planned.plan),
      onFileWritten: () => {
        try {
          const competing = acquireWikiMaintenanceLease(join(target.root, "wiki.db"), "rebuild", target.root);
          competing.release();
        } catch (error) {
          contentionObserved = error instanceof WikiMaintenanceLockedError;
        }
      },
    });

    expect(result.ok).toBe(true);
    expect(contentionObserved).toBe(true);
    expect(existsSync(join(target.root, "wiki.db.lock"))).toBe(false);
  });

  it("applies the exact reviewed Markdown and ledger bytes without re-planning", () => {
    const target = scaffold();
    const env = envelope(
      target,
      "create-entry",
      {
        file: "context/architecture.md",
        insertAt: { at: "end-of-file" },
        type: "convention",
        title: "Keep exact plans",
        body: "Apply what was reviewed.",
        headingDepth: 2,
      },
      { opId: "op-exact-plan" },
    );
    const planned = planOperation(env, { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const revision = previewHashOf(planned.plan);
    const result = applyPlannedOperation(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewHash: revision,
    });

    expect(result.ok).toBe(true);
    expect(result.createdIds).toEqual(planned.plan.createdIds);
    for (const file of planned.plan.files) expect(target.read(file.path)).toBe(file.proposedText);
    expect(readFileSync(operationLogPath(target.root), "utf8")).toBe(planned.plan.audit.proposedText);

    const after = target.files();
    const replay = applyPlannedOperation(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewHash: revision,
    });
    expect(replay.ok).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.createdIds).toEqual(planned.plan.createdIds);
    expect(target.files()).toEqual(after);
  });

  it("rejects changed base bytes before appending intent or touching Markdown", () => {
    const target = scaffold();
    const env = envelope(
      target,
      "set-property",
      { property: "status", value: "deprecated" },
      { entityId: JWT, opId: "op-stale-exact-plan" },
    );
    const planned = planOperation(env, { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    target.write(
      "context/architecture.md",
      target.read("context/architecture.md").replace("Terminates TLS", "Terminates TLS (edited)"),
    );
    const before = target.files();

    const result = applyPlannedOperation(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewHash: previewHashOf(planned.plan),
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result.diagnostics)).toContain("CONTENT_HASH_CONFLICT");
    expect(target.files()).toEqual(before);
    expect(recordFor(readAuditLog(target.root), planned.plan.opId).intent).toBeNull();
  });

  it("rejects a plan whose reviewed audit bytes do not equal its exact records", () => {
    const target = scaffold();
    const planned = planOperation(
      envelope(
        target,
        "set-property",
        { property: "status", value: "deprecated" },
        { entityId: JWT, opId: "op-tampered-audit-plan" },
      ),
      { scaffoldRoot: target.root },
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const tampered = {
      ...planned.plan,
      audit: { ...planned.plan.audit, proposedText: `${planned.plan.audit.proposedText}{"arbitrary":"line"}\n` },
    };
    const before = target.files();

    const result = applyPlannedOperation(tampered, {
      scaffoldRoot: target.root,
      expectedPreviewHash: previewHashOf(tampered),
    });

    expect(result.ok).toBe(false);
    expect(codesOf(result.diagnostics)).toContain("INVALID_OPERATION_ENVELOPE");
    expect(target.files()).toEqual(before);
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("validates the expected preview revision before honoring replay", () => {
    const target = scaffold();
    const env = envelope(
      target,
      "set-property",
      { property: "status", value: "deprecated" },
      { entityId: JWT, opId: "op-replay-preview" },
    );
    const planned = planOperation(env, { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const revision = previewHashOf(planned.plan);
    expect(applyPlannedOperation(planned.plan, { scaffoldRoot: target.root, expectedPreviewHash: revision }).ok).toBe(true);
    const after = target.files();
    const invalid = applyPlannedOperation(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewHash: "0".repeat(64),
    });
    expect(invalid.ok).toBe(false);
    expect(codesOf(invalid.diagnostics)).toContain("INVALID_OPERATION_ENVELOPE");
    expect(target.files()).toEqual(after);
  });
});

describe("atomic executable batches", () => {
  it("plans over one virtual overlay and rejects a later invalid item without writing the valid prefix", () => {
    const target = scaffold();
    const before = target.files();
    const first = envelope(
      target,
      "update-entry",
      { summary: "This virtual edit must never land." },
      { entityId: JWT, opId: "op-batch-valid" },
    );
    const second = envelope(
      target,
      "add-relation",
      { relation: { type: "depends_on", target: "mx_01J0000000000000000000000Z" } },
      { entityId: JWT, opId: "op-batch-invalid" },
    );

    const planned = planOperationBatch([first, second], { scaffoldRoot: target.root });

    expect(planned.ok).toBe(false);
    expect(target.files()).toEqual(before);
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("applies a valid sequence exactly once without replanning", () => {
    const target = scaffold();
    const planned = planOperationBatch([
      envelope(target, "update-entry", { summary: "Reviewed summary." }, { entityId: JWT, opId: "op-batch-one" }),
      envelope(target, "update-entry", { body: "Reviewed body." }, { entityId: JWT, opId: "op-batch-two" }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const applied = applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
    });
    expect(applied.ok).toBe(true);
    expect(target.read("context/architecture.md")).toContain("Reviewed summary.");
    expect(target.read("context/architecture.md")).toContain("Reviewed body.");

    const after = target.files();
    const replay = applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
    });
    expect(replay.ok).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(target.files()).toEqual(after);
  });

  it("restores exact Markdown and ledger bytes when the completion append fails", () => {
    const target = scaffold();
    const before = target.files();
    const planned = planOperationBatch([
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT, opId: "op-batch-audit-fail" }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      beforeAuditAppend: (phase) => {
        if (phase === "complete") throw new Error("completion append failed");
      },
    })).toThrow("completion append failed");
    expect(target.files()).toEqual(before);
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("restores exact bytes when a completion line lands but its fsync path fails", () => {
    const target = scaffold();
    const before = target.files();
    const planned = planOperationBatch([
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT, opId: "op-batch-audit-fsync" }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      afterAuditWrite: (phase) => {
        if (phase === "complete") throw new Error("fsync failed after bytes landed");
      },
    })).toThrow();
    expect(target.files()).toEqual(before);
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("refuses a foreign ledger append between preflight and intent without erasing it", () => {
    const target = scaffold();
    const before = target.files();
    const planned = planOperationBatch([
      envelope(target, "set-property", { property: "status", value: "deprecated" }, {
        entityId: JWT,
        opId: "op-foreign-ledger",
      }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const foreign = "{\"foreign\":true}\n";

    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      beforeAuditAppend: (phase) => {
        if (phase !== "intent") return;
        mkdirSync(join(target.root, "events"), { recursive: true });
        writeFileSync(operationLogPath(target.root), foreign, "utf8");
      },
    })).toThrow(WikiWriteRecoveryError);

    expect(target.files()).toEqual(before);
    expect(readFileSync(operationLogPath(target.root), "utf8")).toBe(foreign);
  });

  it("restores a multi-file prefix when the later rename fails", () => {
    const target = scaffold();
    const before = target.files();
    const planned = planOperationBatch([
      envelope(
        target,
        "move-entry",
        { file: "patterns/problem-documents.md", insertAt: { at: "end-of-file" } },
        { entityId: GATEWAY, opId: "op-batch-file-fail" },
      ),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    let renames = 0;

    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      beforeFileRename: () => {
        renames += 1;
        if (renames === 2) throw new Error("second rename failed");
      },
    })).toThrow("second rename failed");
    expect(target.files()).toEqual(before);
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("rolls back exact canonical bytes when durability fails after rename", () => {
    const target = scaffold();
    const before = target.files();
    const planned = planOperationBatch([
      envelope(target, "set-property", { property: "status", value: "deprecated" }, {
        entityId: JWT,
        opId: "op-post-rename-failure",
      }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      afterFileRename: () => { throw new Error("directory fsync failed after rename"); },
    })).toThrow("directory fsync failed after rename");
    expect(target.files()).toEqual(before);
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("rejects a regular-file replacement of the exact reviewed temp generation", () => {
    const target = scaffold();
    const before = target.files();
    const planned = planOperationBatch([
      envelope(target, "set-property", { property: "status", value: "deprecated" }, {
        entityId: JWT,
        opId: "op-temp-regular-replacement",
      }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      beforeFileRename: (path) => {
        const directory = resolve(target.root, path, "..");
        const name = readdirSync(directory).find((entry) => entry.includes(".tmp-"));
        if (name === undefined) throw new Error("expected owned temp");
        const temp = join(directory, name);
        renameSync(temp, `${temp}.displaced`);
        writeFileSync(temp, "unreviewed replacement bytes", "utf8");
      },
    })).toThrow(WritePathError);

    expect(target.files()).toEqual(before);
    expect(Object.values(target.files()).join("\n")).not.toContain("unreviewed replacement bytes");
  });

  it("does not accept or erase a foreign append after the final audit write", () => {
    const target = scaffold();
    const before = target.files();
    const planned = planOperationBatch([
      envelope(target, "set-property", { property: "status", value: "deprecated" }, {
        entityId: JWT,
        opId: "op-final-ledger-race",
      }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const foreign = "{\"foreignAfterWrite\":true}\n";

    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      afterAuditWrite: (phase) => {
        if (phase === "complete") appendFileSync(operationLogPath(target.root), foreign, "utf8");
      },
    })).toThrow(WikiWriteRecoveryError);
    expect(target.files()).toEqual(before);
    expect(readFileSync(operationLogPath(target.root), "utf8")).toContain(foreign.trim());
  });

  it("rechecks the exact final ledger after the sequence commit hook", () => {
    const target = scaffold();
    const before = target.files();
    const planned = planOperationBatch([
      envelope(target, "set-property", { property: "status", value: "deprecated" }, {
        entityId: JWT,
        opId: "op-final-ledger-postcondition",
      }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const foreign = "{\"foreignBeforeCommit\":true}\n";

    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      beforeSequenceCommit: () => appendFileSync(operationLogPath(target.root), foreign, "utf8"),
    })).toThrow(WikiWriteRecoveryError);
    expect(target.files()).toEqual(before);
    expect(readFileSync(operationLogPath(target.root), "utf8")).toContain(foreign.trim());
  });

  it("rejects a regular-file replacement of the bound rollback ledger temp", () => {
    const target = scaffold();
    const path = operationLogPath(target.root);
    mkdirSync(join(target.root, "events"), { recursive: true });
    const current = "{\"current\":true}\n";
    const original = "{\"original\":true}\n";
    writeFileSync(path, current, "utf8");

    expect(() => restoreOperationLogExact(target.root, current, { exists: true, text: original }, {
      beforeRename: (temp) => {
        renameSync(temp, `${temp}.displaced`);
        writeFileSync(temp, original, "utf8");
      },
    })).toThrow(OperationLogPathError);
    expect(readFileSync(path, "utf8")).toBe(current);
  });

  it("refuses a target-parent retarget before temp creation without writing through the symlink", () => {
    const target = scaffold();
    const outside = `${target.root}-outside`;
    const moved = join(target.root, "context-bound");
    mkdirSync(outside, { recursive: true });
    const original = target.read("context/architecture.md");
    const planned = planOperationBatch([
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT, opId: "op-parent-retarget" }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    try {
      expect(() => applyPlannedOperationBatch(planned.plan, {
        scaffoldRoot: target.root,
        expectedPreviewRevision: planned.plan.previewRevision,
        beforeFileOpen: () => {
          renameSync(join(target.root, "context"), moved);
          symlinkSync(outside, join(target.root, "context"), "dir");
        },
      })).toThrow();
      expect(readFileSync(join(moved, "architecture.md"), "utf8")).toBe(original);
      expect(existsSync(join(outside, "architecture.md"))).toBe(false);
      expect(existsSync(operationLogPath(target.root))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not rewind a durable completed prefix when a resumed later operation fails", () => {
    const target = scaffold();
    const planned = planOperationBatch([
      envelope(target, "update-entry", { summary: "Durable prefix." }, { entityId: JWT, opId: "op-prefix-one" }),
      envelope(target, "update-entry", { body: "Later body." }, { entityId: JWT, opId: "op-prefix-two" }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const first = planned.plan.operations[0]!;
    expect(applyPlannedOperation(first, {
      scaffoldRoot: target.root,
      expectedPreviewHash: previewHashOf(first),
    }).ok).toBe(true);
    const invocationStart = target.files();
    const ledgerStart = readFileSync(operationLogPath(target.root), "utf8");

    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      beforeAuditAppend: (phase, opId) => {
        if (phase === "complete" && opId === "op-prefix-two") throw new Error("later completion failed");
      },
    })).toThrow("later completion failed");
    expect(target.files()).toEqual(invocationStart);
    expect(readFileSync(operationLogPath(target.root), "utf8")).toBe(ledgerStart);
  });

  it("does not erase an in-flight crash prefix when its resumed completion fails ordinarily", () => {
    const target = scaffold();
    const planned = planOperationBatch([
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT, opId: "op-inflight-prefix" }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      onFileWritten: () => { throw new Error("SIGKILL"); },
    })).toThrow("SIGKILL");
    const invocationStart = target.files();
    const ledgerStart = readFileSync(operationLogPath(target.root), "utf8");

    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      beforeAuditAppend: (phase) => {
        if (phase === "complete") throw new Error("resume completion failed");
      },
    })).toThrow("resume completion failed");
    expect(target.files()).toEqual(invocationStart);
    expect(readFileSync(operationLogPath(target.root), "utf8")).toBe(ledgerStart);
  });

  it("resumes an exact move suffix after a completed same-entity prefix", () => {
    const target = scaffold();
    const planned = planOperationBatch([
      envelope(target, "update-entry", { summary: "Completed prefix." }, {
        entityId: GATEWAY,
        opId: "op-same-entity-prefix",
      }),
      envelope(target, "move-entry", {
        file: "patterns/problem-documents.md",
        insertAt: { at: "end-of-file" },
      }, {
        entityId: GATEWAY,
        opId: "op-same-entity-move",
      }),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const first = planned.plan.operations[0]!;
    expect(applyPlannedOperation(first, {
      scaffoldRoot: target.root,
      expectedPreviewHash: previewHashOf(first),
    }).ok).toBe(true);

    expect(() => applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
      onFileWritten: () => { throw new Error("SIGKILL"); },
    })).toThrow("SIGKILL");

    const resumed = applyPlannedOperationBatch(planned.plan, {
      scaffoldRoot: target.root,
      expectedPreviewRevision: planned.plan.previewRevision,
    });
    expect(resumed.ok).toBe(true);
    expect(target.read("context/architecture.md")).not.toContain(GATEWAY);
    expect(target.read("patterns/problem-documents.md").split(GATEWAY)).toHaveLength(2);
  });

  it("refuses to overwrite an external post-write edit and retains exact recovery artifacts", () => {
    const target = scaffold();
    const planned = planOperationBatch([
      envelope(
        target,
        "move-entry",
        { file: "patterns/problem-documents.md", insertAt: { at: "end-of-file" } },
        { entityId: GATEWAY, opId: "op-recovery-artifact" },
      ),
    ], { scaffoldRoot: target.root });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    let renames = 0;
    let externallyEdited = false;
    let caught: unknown;
    try {
      applyPlannedOperationBatch(planned.plan, {
        scaffoldRoot: target.root,
        expectedPreviewRevision: planned.plan.previewRevision,
        onFileWritten: (path) => {
          if (externallyEdited) return;
          externallyEdited = true;
          const absolute = join(target.root, path);
          writeFileSync(absolute, `${readFileSync(absolute, "utf8")}external edit\n`, "utf8");
        },
        beforeFileRename: () => {
          renames += 1;
          if (renames === 2) throw new Error("later write failed");
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WikiWriteRecoveryError);
    const recovery = caught as WikiWriteRecoveryError;
    expect(recovery.recoveryPaths.length).toBeGreaterThan(0);
    for (const path of recovery.recoveryPaths) expect(readFileSync(join(target.root, path), "utf8").length).toBeGreaterThan(0);
    expect(Object.values(target.files()).join("\n")).toContain("external edit");
  });
});

describe("the index is a hint, not the authority", () => {
  it("finds an entity with no index at all", () => {
    const target = scaffold();
    expect(existsSync(join(target.root, "wiki.db"))).toBe(false);
    const applied = applyOperation(
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT }),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);
    expect(target.entity(JWT).status).toBe("deprecated");
  });

  it("finds it through a stale index that names the wrong file", async () => {
    const { rebuildWikiIndex } = await import("../../index/rebuild.js");
    const target = scaffold();
    const indexPath = join(target.root, "wiki.db");
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath });

    // The entity moves on disk and the index is deliberately not refreshed, so
    // its hint now points at a file that no longer holds it.
    const moved = applyOperation(
      envelope(target, "move-entry", { file: "patterns/problem-documents.md", insertAt: { at: "end-of-file" } }, {
        entityId: GATEWAY,
      }),
      { scaffoldRoot: target.root },
    );
    expect(moved.ok).toBe(true);
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath, exclude: ["patterns/**"] });

    // The stale hint falls through to the walk, and the operation still lands
    // on the right entity, in the right file.
    const applied = applyOperation(
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root, indexPath },
    );
    expect(applied.ok ? [] : codesOf(applied.diagnostics)).toEqual([]);
    expect(applied.changedFiles).toEqual(["patterns/problem-documents.md"]);
    expect(target.entity(GATEWAY, "patterns/problem-documents.md").status).toBe("deprecated");
  });
});
