import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicCreateArtifact, atomicReplaceArtifact, readContainedArtifact, withContainedArtifactLock } from "../filesystem.js";
import { revisionOf } from "../revision.js";

type Identity = { dev: bigint; ino: bigint };
const fault = vi.hoisted(() => ({
  paths: new Map<string, Identity>(),
  descriptors: new Map<number, { path: string; identity: Identity | undefined }>(),
  afterRead: null as ((path: string, descriptor: number) => void) | null,
  afterWrite: null as ((path: string) => void) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  function identityStats<T extends { dev: number | bigint; ino: number | bigint } | undefined>(
    stats: T,
    identity: Identity | undefined,
  ): T {
    if (stats === undefined || identity === undefined) return stats;
    const bigint = typeof stats.ino === "bigint";
    return Object.assign(stats, {
      dev: bigint ? identity.dev : Number(identity.dev),
      ino: bigint ? identity.ino : Number(identity.ino),
    });
  }
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      const descriptor = actual.openSync(...args);
      const path = String(args[0]);
      fault.descriptors.set(descriptor, { path, identity: fault.paths.get(path) });
      return descriptor;
    },
    closeSync(descriptor: number) {
      fault.descriptors.delete(descriptor);
      return actual.closeSync(descriptor);
    },
    fstatSync(...args: Parameters<typeof actual.fstatSync>) {
      return identityStats(actual.fstatSync(...args), fault.descriptors.get(args[0])?.identity);
    },
    lstatSync(...args: Parameters<typeof actual.lstatSync>) {
      return identityStats(actual.lstatSync(...args), fault.paths.get(String(args[0])));
    },
    statSync(...args: Parameters<typeof actual.statSync>) {
      return identityStats(actual.statSync(...args), fault.paths.get(String(args[0])));
    },
    readSync(...args: Parameters<typeof actual.readSync>) {
      const count = actual.readSync(...args);
      const path = fault.descriptors.get(args[0])?.path;
      if (count > 0 && path !== undefined) fault.afterRead?.(path, args[0]);
      return count;
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      actual.writeFileSync(...args);
      const path = typeof args[0] === "number" ? fault.descriptors.get(args[0])?.path : String(args[0]);
      if (path !== undefined) fault.afterWrite?.(path);
    },
  };
});

const FIRST: Identity = { dev: 9_007_199_254_741_000n, ino: 9_007_199_254_740_992n };
const NEXT: Identity = { ...FIRST, ino: FIRST.ino + 1n };
const roots: string[] = [];

afterEach(() => {
  fault.paths.clear();
  fault.descriptors.clear();
  fault.afterRead = null;
  fault.afterWrite = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-artifact-identity-")));
  roots.push(root);
  const path = ".mex/local/identity.json";
  const absolute = join(root, path);
  atomicCreateArtifact(root, path, "original\n");
  expect(Number(FIRST.ino)).toBe(Number(NEXT.ino));
  return { root, path, absolute } as const;
}

describe("exact artifact file identities", () => {
  it.each(["path", "descriptor"] as const)("rejects a rounded-collision %s identity change during a read", (changed) => {
    const { root, path, absolute } = fixture();
    fault.paths.set(absolute, FIRST);
    fault.afterRead = (readPath, descriptor) => {
      if (readPath !== absolute) return;
      fault.paths.set(absolute, NEXT);
      if (changed === "descriptor") fault.descriptors.get(descriptor)!.identity = NEXT;
    };
    expect(() => readContainedArtifact(root, path, 1024)).toThrowError(expect.objectContaining({
      problem: expect.objectContaining({ code: "REVISION_CONFLICT" }),
    }));
    expect(readFileSync(absolute, "utf8")).toBe("original\n");
  });

  it("rechecks large identities after staging and preserves the original on failure", () => {
    const { root, path, absolute } = fixture();
    fault.paths.set(absolute, FIRST);
    let staged = false;
    fault.afterWrite = (written) => {
      if (!written.includes(".mex-tmp-")) return;
      staged = true;
      fault.afterRead = (readPath) => {
        if (readPath === absolute) fault.paths.set(absolute, NEXT);
      };
    };
    expect(() => atomicReplaceArtifact(root, path, revisionOf("original\n"), "replacement\n", 1024))
      .toThrowError(expect.objectContaining({ problem: expect.objectContaining({ code: "REVISION_CONFLICT" }) }));
    expect(staged).toBe(true);
    expect(readFileSync(absolute, "utf8")).toBe("original\n");
    expect(readdirSync(dirname(absolute))).toEqual(["identity.json"]);
  });

  it("persists full decimal identities and refuses a dead lock bound to a rounded-collision root", async () => {
    const { root, absolute } = fixture();
    const directory = ".mex/local";
    const lockName = ".identity.mex-lock";
    const lockPath = join(root, directory, lockName);
    fault.paths.set(root, FIRST);
    fault.paths.set(dirname(absolute), NEXT);
    let captured = "";
    await withContainedArtifactLock(root, directory, lockName, () => {
      captured = readFileSync(lockPath, "utf8");
    });
    const metadata = JSON.parse(captured);
    expect(metadata).toMatchObject({
      version: 1,
      root: { dev: String(FIRST.dev), ino: String(FIRST.ino) },
      directory: { dev: String(NEXT.dev), ino: String(NEXT.ino) },
    });
    metadata.root.ino = String(NEXT.ino);
    metadata.pid = 2_147_483_647;
    const foreign = `${JSON.stringify(metadata)}\n`;
    writeFileSync(lockPath, foreign);
    const operation = vi.fn();
    await expect(withContainedArtifactLock(root, directory, lockName, operation))
      .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    expect(operation).not.toHaveBeenCalled();
    expect(readFileSync(lockPath, "utf8")).toBe(foreign);
  });

  it.each([false, true])("does not unlink another large-identity lock when the operation fails: %s", async (fail) => {
    const { root } = fixture();
    const lockPath = join(root, ".mex/local/.identity.mex-lock");
    fault.paths.set(lockPath, FIRST);
    const result = withContainedArtifactLock(root, ".mex/local", ".identity.mex-lock", () => {
      fault.paths.set(lockPath, NEXT);
      writeFileSync(lockPath, "another owner\n");
      if (fail) throw new Error("operation failed");
      return "complete";
    });
    if (fail) await expect(result).rejects.toThrow("operation failed");
    else await expect(result).resolves.toBe("complete");
    expect(readFileSync(lockPath, "utf8")).toBe("another owner\n");
  });

  it("preserves a replacement lock when initializing its original owner fails", async () => {
    const { root } = fixture();
    const lockPath = join(root, ".mex/local/.identity.mex-lock");
    fault.paths.set(lockPath, FIRST);
    fault.afterWrite = (written) => {
      if (written !== lockPath) return;
      fault.afterWrite = null;
      fault.paths.set(lockPath, NEXT);
      writeFileSync(lockPath, "another owner\n");
      throw new Error("lock initialization failed");
    };
    await expect(withContainedArtifactLock(root, ".mex/local", ".identity.mex-lock", () => undefined))
      .rejects.toThrow("lock initialization failed");
    expect(readFileSync(lockPath, "utf8")).toBe("another owner\n");
  });
});
