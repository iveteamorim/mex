/**
 * The one place that asks whether this Node can run the wiki index at all.
 *
 * The index answers searches through the `wiki_fts` virtual table, and
 * `node:sqlite` embeds whatever SQLite the running Node binary was compiled
 * with. FTS5 is a compile-time option Node neither documents nor guarantees, so
 * a perfectly valid index file can be unreadable on a different Node build of
 * the same version — switching versions with a version manager is enough
 * (issue #110).
 *
 * Both the build path and the read paths need this, and they report failures
 * differently — a diagnostic here, a typed read error there — so what is shared
 * is the probe and the mapping, not the reporting. Reaching for the graph's
 * `assertFts5Available` rather than writing a second probe is deliberate: one
 * definition of "can this SQLite do FTS5" means one answer.
 */

import { assertFts5Available } from "../../graph/db/sqlite.js";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";

/**
 * `null` when FTS5 works, otherwise the diagnostic to report.
 *
 * Deliberately not `WIKI_INDEX_REBUILD_REQUIRED`: nothing is wrong with the
 * store, and no rebuild on this Node could improve matters, so pointing the
 * user at `mex wiki rebuild-index` would send them round a loop.
 *
 * @param probe Injected by tests, which have no FTS5-less Node to reproduce
 *              this on. Production callers take the default.
 */
export function fts5UnavailableDiagnostic(
  path: string,
  probe: () => void = assertFts5Available,
): WikiDiagnostic | null {
  try {
    probe();
    return null;
  } catch (error) {
    return diagnostic(
      "WIKI_INDEX_FTS5_UNAVAILABLE",
      error instanceof Error ? error.message : String(error),
      { file: path },
    );
  }
}
