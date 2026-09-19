import {
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireWikiMaintenanceLease,
  assertIndexPath,
  bindIndexDirectory,
  IndexPathError,
  WikiMaintenanceLockedError,
} from "../../index/dbfile.js";
import { readContainedSource, WikiSourceReadError } from "../../index/source-read.js";
import {
  appendAudit,
  OperationLogPathError,
  operationLogPath,
  readOperationLogExact,
  restoreOperationLogExact,
  type AuditEntry,
} from "../audit.js";
import { applyPlannedOperationBatch, planOperationBatch } from "../batch.js";
import { envelope, JWT, makeScaffold } from "./helpers.js";

type Identity = { dev: bigint; ino: bigint };
const fsModel = vi.hoisted(() => ({
  identities: new Map<string, Identity>(),
  descriptors: new Map<number, { path: string; identity?: Identity }>(),
  afterOpen: undefined as undefined | ((path: string, flags: string | number) => void),
  afterRead: undefined as undefined | ((path: string) => void),
  beforeWrite: undefined as undefined | ((path: string, fd: number) => void),
}));

// Keep real files, descriptors, bytes and stat methods. Only model their opaque
// device/inode IDs: numeric stats lose the low bit, exactly as on a large-ID
// filesystem. An opened descriptor retains its captured ID after a path swap.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const pathModule = await import("node:path");
  function key(path: unknown): string {
    const value = String(path);
    try { return actual.realpathSync(value); } catch {
      return pathModule.join(actual.realpathSync(pathModule.dirname(value)), pathModule.basename(value));
    }
  }
  function identified<T extends { dev: number | bigint; ino: number | bigint } | undefined>(stats: T, identity?: Identity): T {
    if (stats === undefined || identity === undefined) return stats;
    return Object.assign(Object.create(stats), {
      dev: typeof stats.dev === "bigint" ? identity.dev : Number(identity.dev),
      ino: typeof stats.ino === "bigint" ? identity.ino : Number(identity.ino),
    });
  }
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const stats = actual.lstatSync(...args);
      return identified(stats, fsModel.identities.get(key(args[0])));
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      const path = key(args[0]);
      fsModel.descriptors.set(fd, { path, identity: fsModel.identities.get(path) });
      fsModel.afterOpen?.(path, args[1]);
      return fd;
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => identified(
      actual.fstatSync(...args), fsModel.descriptors.get(args[0])?.identity,
    ),
    closeSync: (fd: number) => {
      fsModel.descriptors.delete(fd);
      return actual.closeSync(fd);
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const read = actual.readSync(...args);
      const path = fsModel.descriptors.get(args[0])?.path;
      if (path !== undefined) fsModel.afterRead?.(path);
      return read;
    },
    // Also cover the previous owner reader so these regressions distinguish
    // identity safety from merely adopting the new bounded read loop.
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const result = actual.readFileSync(...args);
      const path = typeof args[0] === "number" ? fsModel.descriptors.get(args[0])?.path : undefined;
      if (path !== undefined) fsModel.afterRead?.(path);
      return result;
    },
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      const path = fsModel.descriptors.get(args[0])?.path;
      if (path !== undefined) fsModel.beforeWrite?.(path, args[0]);
      return actual.writeSync(...args);
    },
  };
});

const HIGH = 9_007_199_254_740_992n;
const IDENTITY = { dev: HIGH, ino: HIGH };
const roots: string[] = [];
const ENTRY: AuditEntry = {
  v: 1, phase: "complete", opId: "op_identity_probe", type: "create-entry",
  entityIds: [], createdIds: [], actor: { kind: "human", id: "identity-probe" },
  timestamp: "2026-09-01T00:00:00.000Z", files: [], payloadHash: "0".repeat(64), revisions: [],
};

function root(): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "mex-wiki-identity-"));
  roots.push(path);
  return path;
}

function identify(path: string, field?: keyof Identity): void {
  fsModel.identities.set(realpathSync(path), {
    ...IDENTITY,
    ...(field === undefined ? {} : { [field]: HIGH + 1n }),
  });
}

afterEach(() => {
  fsModel.afterOpen = undefined;
  fsModel.afterRead = undefined;
  fsModel.beforeWrite = undefined;
  fsModel.identities.clear();
  fsModel.descriptors.clear();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("full-width Wiki identity", () => {
  it("reads and appends successfully when large directory and leaf IDs are unchanged", () => {
    expect(Number(HIGH + 1n)).toBe(Number(HIGH));
    const scaffold = root();
    const events = join(scaffold, "events");
    mkdirSync(events);
    const ledger = operationLogPath(scaffold);
    writeFileSync(ledger, "");
    for (const path of [scaffold, events, ledger]) identify(path);
    appendAudit(scaffold, ENTRY);
    expect(readOperationLogExact(scaffold)).toEqual({ exists: true, text: `${JSON.stringify(ENTRY)}\n` });
    expect(readContainedSource(scaffold, ledger)).toBe(`${JSON.stringify(ENTRY)}\n`);
  });

  for (const field of ["dev", "ino"] as const) {
    for (const directory of ["root", "parent"] as const) {
      it.each(["afterOpen", "afterRead"] as const)(`rejects a ${directory} ${field} collision %s during a source read`, (phase) => {
        const scaffold = root();
        const parent = join(scaffold, "context");
        mkdirSync(parent);
        const path = join(parent, "architecture.md");
        writeFileSync(path, "# Architecture\n");
        const changed = directory === "root" ? scaffold : parent;
        identify(changed);
        expect(() => readContainedSource(scaffold, path, {
          [phase]: () => identify(changed, field),
        })).toThrow(WikiSourceReadError);
        expect(readFileSync(path, "utf8")).toBe("# Architecture\n");
      });

      it(`refuses an audit append after a ${directory} ${field} collision`, () => {
        const scaffold = root();
        const events = join(scaffold, "events");
        mkdirSync(events);
        const ledger = operationLogPath(scaffold);
        writeFileSync(ledger, "existing\n");
        const changed = directory === "root" ? scaffold : events;
        identify(changed);
        expect(() => appendAudit(scaffold, ENTRY, {
          beforeOpen: () => identify(changed, field),
        })).toThrow(OperationLogPathError);
        expect(readFileSync(ledger, "utf8")).toBe("existing\n");
      });
    }

    it(`does not mutate an index after a directory ${field} collision`, () => {
      const scaffold = root();
      const index = join(scaffold, "wiki.db");
      writeFileSync(index, "original database");
      identify(scaffold);
      const binding = bindIndexDirectory(index, scaffold);
      identify(scaffold, field);
      expect(() => assertIndexPath(index, binding)).toThrow(IndexPathError);
      expect(readFileSync(index, "utf8")).toBe("original database");
    });

    it(`preserves a replacement lock with the same owner record but a different ${field}`, () => {
      const scaffold = root();
      const lock = join(scaffold, "wiki.db.lock");
      // The identity model also covers files about to be exclusively created.
      fsModel.identities.set(lock, IDENTITY);
      const lease = acquireWikiMaintenanceLease(join(scaffold, "wiki.db"), "operation", scaffold);
      const owner = readFileSync(lock, "utf8");
      identify(lock, field);
      expect(() => lease.release()).toThrow(WikiMaintenanceLockedError);
      expect(readFileSync(lock, "utf8")).toBe(owner);
    });

    it(`refuses a reviewed canonical write after its parent ${field} changes`, () => {
      const target = makeScaffold();
      roots.push(target.root);
      const parent = join(target.root, "context");
      identify(parent);
      const before = target.files();
      const planned = planOperationBatch([
        envelope(target, "set-property", { property: "status", value: "deprecated" }, {
          entityId: JWT, opId: "op_identity_change",
        }),
      ], { scaffoldRoot: target.root });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      expect(() => applyPlannedOperationBatch(planned.plan, {
        scaffoldRoot: target.root,
        expectedPreviewRevision: planned.plan.previewRevision,
        beforeFileOpen: () => identify(parent, field),
      })).toThrow();
      expect(target.files()).toEqual(before);
      expect(existsSync(operationLogPath(target.root))).toBe(false);
    });
  }

  it("refuses a replaced audit leaf before appending", () => {
    const scaffold = root();
    mkdirSync(join(scaffold, "events"));
    const ledger = operationLogPath(scaffold);
    writeFileSync(ledger, "original\n");
    identify(ledger);
    fsModel.afterOpen = (path, flags) => {
      if (path === ledger && typeof flags === "number" && (flags & constants.O_APPEND) !== 0) identify(ledger, "ino");
    };
    expect(() => appendAudit(scaffold, ENTRY)).toThrow(OperationLogPathError);
    expect(readFileSync(ledger, "utf8")).toBe("original\n");
  });

  it("preserves the current ledger when its directory changes during rollback", () => {
    const scaffold = root();
    const events = join(scaffold, "events");
    mkdirSync(events);
    const ledger = operationLogPath(scaffold);
    writeFileSync(ledger, "current\n");
    identify(events);
    let retainedTemp: string | undefined;
    expect(() => restoreOperationLogExact(scaffold, "current\n", { exists: true, text: "original\n" }, {
      beforeRename: (temp) => {
        retainedTemp = temp;
        identify(events, "ino");
      },
    })).toThrow(OperationLogPathError);
    expect(readFileSync(ledger, "utf8")).toBe("current\n");
    expect(retainedTemp).toBeDefined();
    expect(readFileSync(retainedTemp!, "utf8")).toBe("original\n");
  });

  it("keeps a lock replaced while reading its owner for release", () => {
    const scaffold = root();
    const lock = join(scaffold, "wiki.db.lock");
    fsModel.identities.set(lock, IDENTITY);
    const lease = acquireWikiMaintenanceLease(join(scaffold, "wiki.db"), "operation", scaffold);
    const owner = readFileSync(lock, "utf8");
    fsModel.afterRead = (path) => { if (path === lock) identify(lock, "ino"); };
    expect(() => lease.release()).toThrow(WikiMaintenanceLockedError);
    expect(readFileSync(lock, "utf8")).toBe(owner);
  });

  it("does not reclaim a dead owner's lock replaced during its owner read", () => {
    const scaffold = root();
    const lock = join(scaffold, "wiki.db.lock");
    const owner = `${JSON.stringify({
      v: 1, pid: 2_147_483_647, token: "a".repeat(64), kind: "operation", createdAt: "2026-09-01T00:00:00.000Z",
    })}\n`;
    writeFileSync(lock, owner);
    identify(lock);
    fsModel.afterRead = (path) => { if (path === lock) identify(lock, "ino"); };
    expect(() => acquireWikiMaintenanceLease(join(scaffold, "wiki.db"), "operation", scaffold)).toThrow(WikiMaintenanceLockedError);
    expect(readFileSync(lock, "utf8")).toBe(owner);
    expect(existsSync(`${lock}.gate`)).toBe(false);
  });

  it.each([false, true])("cleans up a failed owner write only when it still owns the lock (replacement: %s)", (replace) => {
    const scaffold = root();
    const lock = join(scaffold, "wiki.db.lock");
    fsModel.identities.set(lock, IDENTITY);
    fsModel.beforeWrite = (path) => {
      if (path !== lock) return;
      fsModel.beforeWrite = undefined;
      writeFileSync(lock, replace ? "replacement owner\n" : "partial owner\n");
      if (replace) identify(lock, "ino");
      throw new Error("injected owner write failure");
    };
    expect(() => acquireWikiMaintenanceLease(join(scaffold, "wiki.db"), "operation", scaffold)).toThrow("injected owner write failure");
    expect(existsSync(lock)).toBe(replace);
    if (replace) expect(readFileSync(lock, "utf8")).toBe("replacement owner\n");
    expect(existsSync(`${lock}.gate`)).toBe(false);
  });
});
