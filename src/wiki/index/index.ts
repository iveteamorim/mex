/**
 * The disposable index: build it, publish it, refresh it, open it, dump it.
 *
 * Nothing here writes a byte into the scaffold. `dbfile.ts` is the one module
 * that touches the filesystem at all, and it refuses any path that is not a
 * database file.
 */

export * from "./schema.js";
export * from "./open.js";
export * from "./discover.js";
export * from "./dump.js";
export * from "./rebuild.js";
export * from "./refresh.js";
export * from "./maintenance.js";
export { entityKeyOf, canonicalJson, detectRangeOverlaps, ftsBodyFor } from "./write.js";
export { sweepPendingIndexes } from "./publish.js";
export {
  acquireWikiMaintenanceLease,
  assertIndexPath,
  bindIndexDirectory,
  indexExists,
  IndexPublishRecoveryError,
  IndexPathError,
  removeIndexFiles,
  WikiMaintenanceLockedError,
} from "./dbfile.js";
export type { IndexDirectoryBinding, WikiMaintenanceKind, WikiMaintenanceLease } from "./dbfile.js";
