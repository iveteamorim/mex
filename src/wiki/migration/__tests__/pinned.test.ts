import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireWikiMaintenanceLease, WikiMaintenanceLockedError } from "../../index/dbfile.js";
import { operationLogPath } from "../../operations/audit.js";
import { inventoryScaffold } from "../inventory.js";
import { applyPinnedMigration, planPinnedMigration } from "../migrate.js";
import type { EntityId } from "../../model/ids.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function scaffold(): { root: string; path: string; initial: string } {
  const root = mkdtempSync(join(tmpdir(), "mex-pinned-migration-"));
  roots.push(root);
  const path = join(root, "context", "architecture.md");
  const initial = `---
name: architecture
description: "System shape"
---

# Architecture

Introductory prose remains byte-identical.

## Ingest

This section has enough substantive prose for the deterministic classifier to
adopt it as knowledge. A second sentence makes that intent unambiguous, while
the migration itself remains metadata-only and preserves every word here.
`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, initial, "utf8");
  return { root, path, initial };
}

describe("pinned exact-byte migration", () => {
  it("previews the complete executable corpus and ledger without writing or exposing ids in the report", () => {
    const target = scaffold();
    const plan = planPinnedMigration({ scaffoldRoot: target.root });

    expect(plan.valid).toBe(true);
    expect(plan.operations.length).toBeGreaterThan(0);
    expect(plan.artifacts.some((entry) => entry.path === "context/architecture.md")).toBe(true);
    expect(plan.audit.path).toBe("events/operations.jsonl");
    expect(plan.audit.proposedText).toContain('"phase":"intent"');
    expect(plan.audit.proposedText).toContain('"phase":"complete"');
    expect(plan.report.idsGenerated).toEqual([]);
    expect(JSON.stringify(plan.report)).not.toMatch(/mx_[0-9A-HJKMNP-TV-Z]{26}/);
    expect(readFileSync(target.path, "utf8")).toBe(target.initial);
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("rejects an intervening corpus edit before any reviewed byte is applied", () => {
    const target = scaffold();
    const plan = planPinnedMigration({ scaffoldRoot: target.root });
    const edited = target.initial.replace("Introductory prose", "Concurrently edited prose");
    writeFileSync(target.path, edited, "utf8");

    const result = applyPinnedMigration(plan, plan.previewRevision, { scaffoldRoot: target.root });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("CONTENT_HASH_CONFLICT");
    expect(readFileSync(target.path, "utf8")).toBe(edited);
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("rejects any tampering with the opaque plan, including its change projection", () => {
    const target = scaffold();
    const plan = planPinnedMigration({ scaffoldRoot: target.root });
    const tampered = {
      ...plan,
      artifacts: plan.artifacts.map((entry, index) => index === 0
        ? { ...entry, proposedText: `${entry.proposedText}\nInjected after preview.\n` }
        : entry),
    };

    const result = applyPinnedMigration(tampered, plan.previewRevision, { scaffoldRoot: target.root });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("CONTENT_HASH_CONFLICT");
    expect(readFileSync(target.path, "utf8")).toBe(target.initial);
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("applies the stored bytes and ids once, then replays without replanning or reminting", () => {
    const target = scaffold();
    const plan = planPinnedMigration({ scaffoldRoot: target.root });
    const plannedIds = plan.operations.flatMap((operation) => operation.createdIds).sort();
    let leaseWasHeld = false;

    const applied = applyPinnedMigration(plan, plan.previewRevision, {
      scaffoldRoot: target.root,
      onFileWritten: () => {
        try {
          const competing = acquireWikiMaintenanceLease(join(target.root, "wiki.db"), "refresh", target.root);
          competing.release();
        } catch (error) {
          leaseWasHeld = error instanceof WikiMaintenanceLockedError;
        }
      },
    });

    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(true);
    expect(leaseWasHeld).toBe(true);
    for (const artifact of plan.artifacts) {
      expect(readFileSync(artifact.absolutePath, "utf8")).toBe(artifact.proposedText);
    }
    const actualIds = inventoryScaffold({ scaffoldRoot: target.root }).files
      .flatMap((file) => file.parsed.entities.map((entry) => entry.entity.id))
      .sort();
    expect(actualIds).toEqual(plannedIds);

    const beforeReplay = plan.artifacts.map((entry) => readFileSync(entry.absolutePath, "utf8"));
    const replayed = applyPinnedMigration(plan, plan.previewRevision, { scaffoldRoot: target.root });
    expect(replayed.ok).toBe(true);
    expect(replayed.replayed).toBe(true);
    expect(plan.artifacts.map((entry) => readFileSync(entry.absolutePath, "utf8"))).toEqual(beforeReplay);
    expect(inventoryScaffold({ scaffoldRoot: target.root }).files
      .flatMap((file) => file.parsed.entities.map((entry) => entry.entity.id))
      .sort()).toEqual(plannedIds);
  });

  it("honors the shared writer lease before migration reads or writes", () => {
    const target = scaffold();
    const plan = planPinnedMigration({ scaffoldRoot: target.root });
    const lease = acquireWikiMaintenanceLease(join(target.root, "wiki.db"), "operation", target.root);
    try {
      expect(() => applyPinnedMigration(plan, plan.previewRevision, { scaffoldRoot: target.root }))
        .toThrow(WikiMaintenanceLockedError);
      expect(readFileSync(target.path, "utf8")).toBe(target.initial);
      expect(existsSync(operationLogPath(target.root))).toBe(false);
    } finally {
      lease.release();
    }
  });

  it("revalidates untouched corpus bytes inside rollback scope before success", () => {
    const target = scaffold();
    const untouched = join(target.root, "notes", "untouched.md");
    mkdirSync(dirname(untouched), { recursive: true });
    writeFileSync(untouched, "# Untouched\n\nOriginal external state.\n", "utf8");
    const plan = planPinnedMigration({ scaffoldRoot: target.root });
    let edited = false;

    expect(() => applyPinnedMigration(plan, plan.previewRevision, {
      scaffoldRoot: target.root,
      onFileWritten: () => {
        if (edited) return;
        edited = true;
        writeFileSync(untouched, "# Untouched\n\nConcurrent external state.\n", "utf8");
      },
    })).toThrow("corpus changed");

    expect(readFileSync(target.path, "utf8")).toBe(target.initial);
    expect(readFileSync(untouched, "utf8")).toContain("Concurrent external state");
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("rolls back the whole invocation when a later migration operation fails ordinarily", () => {
    const target = scaffold();
    const plan = planPinnedMigration({ scaffoldRoot: target.root });
    expect(plan.operations.length).toBeGreaterThan(1);
    const later = plan.operations[1]!.opId;

    expect(() => applyPinnedMigration(plan, plan.previewRevision, {
      scaffoldRoot: target.root,
      beforeAuditAppend: (phase, opId) => {
        if (phase === "complete" && opId === later) throw new Error("later migration operation failed");
      },
    })).toThrow("later migration operation failed");

    expect(readFileSync(target.path, "utf8")).toBe(target.initial);
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("limits reviewed operations to explicit paths while binding the full observed corpus", () => {
    const target = scaffold();
    const other = join(target.root, "context", "conventions.md");
    writeFileSync(other, "# Conventions\n\n## Naming\n\nOne two three four five six seven eight nine ten.\nAnother substantial sentence remains exactly as authored here.\nA third line makes this section structurally adoptable.\n", "utf8");
    const beforeOther = readFileSync(other, "utf8");

    const plan = planPinnedMigration({
      scaffoldRoot: target.root,
      paths: ["context/architecture.md"],
    });

    expect(plan.selection.paths).toEqual(["context/architecture.md"]);
    expect(plan.report.filesScanned).toBe(1);
    expect(plan.operations.every((operation) => operation.files.every((file) => file.path === "context/architecture.md")))
      .toBe(true);
    expect(plan.corpus.map((entry) => entry.path)).toContain("context/conventions.md");
    expect(applyPinnedMigration(plan, plan.previewRevision, { scaffoldRoot: target.root }).ok).toBe(true);
    expect(readFileSync(other, "utf8")).toBe(beforeOther);
  });

  it("resolves legacy topic labels into reviewed canonical topic membership", () => {
    const target = scaffold();
    const topicId = "mx_01KRMEXM00JAAVJPQVVRX8N56V" as EntityId;
    const topic = join(target.root, "topics", "authentication.md");
    mkdirSync(dirname(topic), { recursive: true });
    writeFileSync(topic, `<!-- mex:entity\nid: ${topicId}\ntype: topic\nstatus: promoted\nrevision: 1\n-->\n## Authentication\n\nTopic prose.\n`, "utf8");
    writeFileSync(
      target.path,
      target.initial.replace("description: \"System shape\"\n", "description: \"System shape\"\ntopics: [authentication]\n"),
      "utf8",
    );

    const plain = planPinnedMigration({ scaffoldRoot: target.root });
    const mapped = planPinnedMigration({
      scaffoldRoot: target.root,
      topicMappings: { authentication: topicId },
    });

    expect(mapped.selection.topicMappings).toEqual({ authentication: topicId });
    expect(mapped.previewRevision).not.toBe(plain.previewRevision);
    expect(plain.report.diagnostics.map((entry) => entry.code)).toContain("AMBIGUOUS_MIGRATION");
    const proposed = mapped.corpus.find((entry) => entry.path === "context/architecture.md")!.proposedText;
    expect(proposed).toContain(`topics:\n    - ${topicId}`);
    expect(proposed).not.toContain("topics: [authentication]");
    expect(applyPinnedMigration(mapped, mapped.previewRevision, {
      scaffoldRoot: target.root,
      topicMappings: { authentication: topicId },
    }).ok).toBe(true);
    expect(readFileSync(target.path, "utf8")).toBe(proposed);
  });
});
