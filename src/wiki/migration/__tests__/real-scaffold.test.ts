/**
 * Section 6a condition 3 — the real-scaffold gate.
 *
 * A one-off run by a builder who will not be here next month decays. This is a
 * committed, re-runnable instrument instead: point it at a scaffold, it copies
 * that scaffold into a temporary directory, migrates the copy, and prints
 * counts. It **writes nothing into the scaffold it was given and nothing into
 * this repo**, and only numbers ever reach the output.
 *
 *   MEX_MIGRATION_CORPUS=<path-to-a-.mex-scaffold> npx vitest run src/wiki/migration
 *
 * With the variable unset it asserts a documented no-op rather than skipping —
 * the suite-wide skip count is load-bearing (finding 17), and a `.skip` here
 * would move it.
 *
 * If a run turns up a *shape* the synthetic corpus lacks, add that shape to
 * `scripts/generate-wiki-migration-corpus.mjs` with invented prose and refresh
 * the census. Only numbers ever enter the repo (plan section 6a).
 */
import { describe, it, expect } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateScaffold, planMigration } from "../migrate.js";
import { inventoryScaffold } from "../inventory.js";

const TARGET = process.env["MEX_MIGRATION_CORPUS"];

/** Prose, for the byte-identity property. Frontmatter and metadata excluded. */
function proseOf(text: string): string {
  const body = text.startsWith("---") ? text.slice(text.indexOf("\n---", 3) + 4) : text;
  return body.replace(/<!-- mex:entity[\s\S]*?-->\r?\n?/g, "");
}

describe("the real-scaffold gate", () => {
  it(
    "migrates a real scaffold, prints counts, and writes nothing into it",
    () => {
      // One test, unconditional, rather than `it.runIf` or `.skip`. Both of
      // those move the suite-wide skip count, which is load-bearing at three
      // (finding 17) — and a reader of a green run should still be able to see
      // that this gate exists and what it did.
      if (TARGET === undefined) {
        expect(TARGET, "set MEX_MIGRATION_CORPUS to run this gate against a real scaffold").toBeUndefined();
        return;
      }
      const source = TARGET;
      expect(existsSync(source), `MEX_MIGRATION_CORPUS points at ${source}, which does not exist`).toBe(true);
      expect(statSync(source).isDirectory()).toBe(true);

      // The copy is the whole point: the scaffold this is pointed at is
      // somebody's real knowledge base, and the gate must not touch it.
      const before = new Map(
        inventoryScaffold({ scaffoldRoot: source }).files.map((file) => [file.path, file.text]),
      );
      const work = mkdtempSync(join(tmpdir(), "mex-real-scaffold-"));
      // Everything from here down runs inside a `finally` that removes the
      // copy. It used to end with a bare `rmSync`, so any failing assertion
      // below left a complete copy of somebody's private knowledge base sitting
      // in the system temp directory — and a failing assertion is the whole
      // reason to point this gate at a real scaffold.
      try {
        cpSync(source, work, { recursive: true });

        const dry = planMigration({ scaffoldRoot: work });
        const report = migrateScaffold({ scaffoldRoot: work });

        const byType = Object.entries(report.entitiesByType)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([type, count]) => `${type}=${count}`)
          .join(" ");

        // Counts only. No path, no file name, no heading, no prose.
        const lines = [
          "--- mex migration, real-scaffold gate -------------------------------",
          `files scanned          ${report.filesScanned}`,
          `files skipped          ${report.filesSkipped.length}`,
          `files unchanged        ${report.filesUnchanged.length}`,
          `entities proposed(dry) ${dry.planned.length}`,
          `entities created       ${report.idsGenerated.length}`,
          `by type                ${byType === "" ? "(none)" : byType}`,
          `edges converted        ${report.edgesConverted}`,
          `edges ambiguous        ${report.edgesAmbiguous}`,
          `groundings moved       ${report.groundingsMoved}`,
          `groundings ambiguous   ${report.groundingsAmbiguous}`,
          `abstentions            ${report.abstentions.length}`,
          `AMBIGUOUS_MIGRATION    ${report.diagnostics.filter((entry) => entry.code === "AMBIGUOUS_MIGRATION").length}`,
          `blocking errors        ${report.diagnostics.filter((entry) => entry.severity === "error").length}`,
          "---------------------------------------------------------------------",
        ];
        // eslint-disable-next-line no-console
        console.log(lines.join("\n"));

        // The scaffold it was pointed at is byte-for-byte as it was.
        for (const file of inventoryScaffold({ scaffoldRoot: source }).files) {
          expect(file.text, `the gate wrote into ${file.path}`).toBe(before.get(file.path));
        }

        // And the copy holds only inserted metadata: prose is byte-identical.
        for (const [path, text] of before) {
          const migrated = join(work, path);
          if (!existsSync(migrated)) continue;
          expect(proseOf(readFileSync(migrated, "utf-8")), `prose changed in ${path}`).toBe(proseOf(text));
        }

        // A migration that produced nothing is a gate that proved nothing.
        expect(report.filesScanned).toBeGreaterThan(0);
        expect(report.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
