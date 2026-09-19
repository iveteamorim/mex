import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MexPortError } from "../../../contracts/shared.js";
import type { TeamRelayCommand, TeamRelayPreviewEnvelope } from "../../../contracts/workflow.js";
import { normalizeTeamRelayCommand } from "../../handoff.js";
import { readRelayPreviewFile } from "../request-file.js";
import { withLocalRelayPreview } from "../local-preview.js";

const directoryInodes = vi.hoisted(() => new Map<string, bigint>());

// Keep real files and the live lock descriptor. Model only a directory's opaque
// inode so every platform exercises replacement even when Windows refuses to
// rename a directory containing an open lock file.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  function identified<T extends { ino: number | bigint } | undefined>(stats: T, path: unknown): T {
    const inode = directoryInodes.get(String(path));
    if (stats === undefined || inode === undefined) return stats;
    return Object.assign(stats, { ino: typeof stats.ino === "bigint" ? inode : Number(inode) });
  }
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => identified(actual.lstatSync(...args), args[0]),
    statSync: (...args: Parameters<typeof actual.statSync>) => identified(actual.statSync(...args), args[0]),
  };
});

const roots: string[] = [];
const DIRECTORY = ".mex/local/relay-previews";
const NOW = "2026-09-08T10:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  directoryInodes.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-relay-pending-"));
  roots.push(root);
  return root;
}

function request(operationId = "save-1", summary = "Continue the private handoff."): TeamRelayCommand {
  return normalizeTeamRelayCommand({
    operationId, expectedRevisions: [],
    action: { kind: "relay.draft.save", draft: { audience: "team", recipients: [], summary } },
  });
}

function preview(command: TeamRelayCommand): TeamRelayPreviewEnvelope {
  return {
    schemaVersion: 1, request: command,
    preview: {
      valid: true, scope: "local", changes: [], diagnostics: [],
      localChanges: [{ namespace: "relay-draft", id: "draft-1", beforeRevision: null, afterRevision: "a".repeat(64), summary: "Save local draft" }],
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: { kind: "unknown" }, occurredAt: NOW,
        repoState: { branch: "main", head: "b".repeat(40), dirty: false, observedAt: NOW },
      },
      purposeIds: [{ purpose: "relay-draft", id: "draft-1" }],
      requestRevision: "c".repeat(64), presentationRevision: "d".repeat(64), previewRevision: "e".repeat(64),
    },
  };
}

function receiptPath(root: string, command: TeamRelayCommand): string {
  return join(root, DIRECTORY, `${createHash("sha256").update(command.operationId).digest("hex")}.json`);
}

async function retain(root: string, command: TeamRelayCommand): Promise<void> {
  await expect(withLocalRelayPreview(root, command, async () => preview(command), async () => {
    throw new Error("private callback failure");
  })).rejects.toBeInstanceOf(MexPortError);
}

describe("pending local Relay previews", () => {
  it("persists private exact apply bytes first and reuses them after a failed callback", async () => {
    const root = fixture();
    const command = request();
    const issued = preview(command);
    const create = vi.fn(async () => issued);
    const path = receiptPath(root, command);
    let firstApplied: TeamRelayPreviewEnvelope | undefined;
    const first = withLocalRelayPreview(root, command, create, async (value) => {
      firstApplied = value;
      expect(readRelayPreviewFile(path, "relay.draft.save")).toEqual(issued);
      if (process.platform !== "win32") expect(lstatSync(path).mode & 0o777).toBe(0o600);
      throw new MexPortError({ code: "REVISION_CONFLICT", status: 409, title: "Private", detail: "SECRET callback content" });
    });
    await expect(first).rejects.toMatchObject({ problem: {
      code: "REVISION_CONFLICT",
      recovery: [{ command: `mex relay draft save --apply ${DIRECTORY}/${path.split(/[\\/]/u).at(-1)} --json` }],
    } });
    await expect(first).rejects.not.toThrow("SECRET");
    const originalBytes = readFileSync(path);
    const newCreate = vi.fn(async () => { throw new Error("must reuse"); });
    await expect(withLocalRelayPreview(root, structuredClone(command), newCreate, async (value) => {
      expect(value).toEqual(firstApplied);
      expect(readFileSync(path)).toEqual(originalBytes);
      return { applied: true, idempotentReplay: true };
    })).resolves.toEqual({ applied: true, idempotentReplay: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(newCreate).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(root, DIRECTORY))).toEqual([]);
    expect(existsSync(join(root, ".mex/relays"))).toBe(false);
    expect(existsSync(join(root, ".mex/team"))).toBe(false);
  });

  it("rejects changed content under a pending operation without creating or applying again", async () => {
    const root = fixture();
    const original = request();
    await retain(root, original);
    const path = receiptPath(root, original);
    const bytes = readFileSync(path);
    const create = vi.fn(async () => preview(request("save-1", "Changed intent")));
    const apply = vi.fn(async () => true);
    await expect(withLocalRelayPreview(root, request("save-1", "Changed intent"), create, apply)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(create).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(join(root, DIRECTORY))).toHaveLength(1);
  });

  it("serializes concurrent same-operation attempts before either can duplicate the save", async () => {
    const root = fixture();
    const command = request();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const first = withLocalRelayPreview(root, command, async () => preview(command), async () => {
      enter();
      await released;
      return "saved";
    });
    await entered;
    const duplicateCreate = vi.fn(async () => preview(command));
    const duplicateApply = vi.fn(async () => "duplicate");
    try {
      await expect(withLocalRelayPreview(root, command, duplicateCreate, duplicateApply)).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
      expect(duplicateCreate).not.toHaveBeenCalled();
      expect(duplicateApply).not.toHaveBeenCalled();
    } finally { release(); }
    await expect(first).resolves.toBe("saved");
  });

  it("rejects symlinked parent directories and receipt targets before callbacks", async () => {
    for (const target of [".mex", ".mex/local", DIRECTORY, "receipt"]) {
      const root = fixture();
      const outside = fixture();
      const command = request();
      if (target === "receipt") {
        mkdirSync(join(root, DIRECTORY), { recursive: true });
        const externalFile = join(outside, "private.json");
        writeFileSync(externalFile, "secret", { mode: 0o600 });
        symlinkSync(externalFile, receiptPath(root, command));
      } else {
        const components = target.split("/");
        if (components.length > 1) mkdirSync(join(root, ...components.slice(0, -1)), { recursive: true });
        symlinkSync(outside, join(root, target), "dir");
      }
      const create = vi.fn(async () => preview(command));
      const apply = vi.fn(async () => true);
      await expect(withLocalRelayPreview(root, command, create, apply)).rejects.toBeInstanceOf(MexPortError);
      expect(create).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(readdirSync(outside)).toEqual(target === "receipt" ? ["private.json"] : []);
    }
  });

  it.each(["identity", ...(process.platform === "win32" ? [] : ["rename"])])("refuses root or pending-directory replacement while create is awaiting (%s)", async (replacement) => {
    for (const replaceRoot of [true, false]) {
      const root = realpathSync(fixture());
      const path = replaceRoot ? root : join(root, DIRECTORY);
      mkdirSync(join(root, DIRECTORY), { recursive: true });
      const moved = `${root}-original`;
      if (replacement === "rename" && replaceRoot) roots.push(moved);
      const inode = 9_007_199_254_740_992n;
      if (replacement === "identity") directoryInodes.set(path, inode);
      const command = request();
      const apply = vi.fn(async () => true);
      const foreign = join(path, "other-owner.txt");
      await expect(withLocalRelayPreview(root, command, async () => {
        if (replacement === "identity") {
          // The two IDs collide when rounded to Number; the guard must retain
          // the full-width identity observed before the asynchronous callback.
          expect(Number(inode + 1n)).toBe(Number(inode));
          directoryInodes.set(path, inode + 1n);
        } else {
          renameSync(path, replaceRoot ? moved : `${path}-original`);
          mkdirSync(path, { recursive: true });
        }
        writeFileSync(foreign, "another owner\n", { mode: 0o600 });
        return preview(command);
      }, apply)).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
      expect(apply).not.toHaveBeenCalled();
      expect(existsSync(receiptPath(root, command))).toBe(false);
      expect(readFileSync(foreign, "utf8")).toBe("another owner\n");
    }
  });

  it("keeps successful apply successful when cleanup cannot safely remove the receipt", async () => {
    const root = fixture();
    const command = request();
    const path = receiptPath(root, command);
    const result = await withLocalRelayPreview(root, command, async () => preview(command), async () => {
      // An external change invalidates the cleanup proof after the write succeeded.
      writeFileSync(path, "replacement receipt\n", { mode: 0o600 });
      return { applied: true };
    });
    expect(result).toEqual({ applied: true });
    expect(readFileSync(path, "utf8")).toBe("replacement receipt\n");
  });

  it("retains a receipt changed only by line endings while apply was running", async () => {
    const root = fixture();
    const command = request();
    const path = receiptPath(root, command);
    let changed = "";
    const result = await withLocalRelayPreview(root, command, async () => preview(command), async () => {
      changed = readFileSync(path, "utf8").replaceAll("\n", "\r\n");
      writeFileSync(path, changed, { mode: 0o600 });
      return { applied: true };
    });
    expect(result).toEqual({ applied: true });
    expect(changed).toContain("\r\n");
    expect(readFileSync(path, "utf8")).toBe(changed);
  });

  it("bounds pending count without evicting receipts and still permits an existing retry", async () => {
    const root = fixture();
    const command = request();
    await retain(root, command);
    const path = receiptPath(root, command);
    const bytes = readFileSync(path);
    for (let index = 0; index < 63; index += 1) {
      writeFileSync(join(root, DIRECTORY, `${index.toString(16).padStart(64, "0")}.json`), bytes, { mode: 0o600 });
    }
    const create = vi.fn(async () => preview(request("new-operation")));
    const apply = vi.fn(async () => "applied");
    await expect(withLocalRelayPreview(root, request("new-operation"), create, apply)).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    expect(create).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(readdirSync(join(root, DIRECTORY))).toHaveLength(64);
    await expect(withLocalRelayPreview(root, command, create, apply)).resolves.toBe("applied");
    expect(create).not.toHaveBeenCalled();
    expect(readdirSync(join(root, DIRECTORY))).toHaveLength(63);
  });

  it("resumes a retained preview beside inert owner-only staging debris without consuming or deleting it", async () => {
    const root = fixture();
    const command = request();
    await retain(root, command);
    const receipt = receiptPath(root, command);
    const original = readRelayPreviewFile(receipt, "relay.draft.save");
    const stage = join(root, DIRECTORY, `.${"f".repeat(64)}.json.mex-tmp-12345-${"a".repeat(16)}`);
    writeFileSync(stage, "incomplete private preview", { mode: 0o600 });
    const create = vi.fn(async () => { throw new Error("must resume original"); });
    await expect(withLocalRelayPreview(root, command, create, async (value) => {
      expect(value).toEqual(original);
      return "recovered";
    })).resolves.toBe("recovered");
    expect(create).not.toHaveBeenCalled();
    expect(existsSync(receipt)).toBe(false);
    expect(readFileSync(stage, "utf8")).toBe("incomplete private preview");
    expect(readdirSync(join(root, DIRECTORY))).toHaveLength(1);
  });

  it("counts inert stages against pending capacity and rejects malformed or unsafe stages", async () => {
    const root = fixture();
    mkdirSync(join(root, DIRECTORY), { recursive: true });
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(join(root, DIRECTORY, `.${index.toString(16).padStart(64, "0")}.json.mex-tmp-12345-${"a".repeat(16)}`), "partial", { mode: 0o600 });
    }
    const create = vi.fn(async () => preview(request()));
    const apply = vi.fn(async () => true);
    await expect(withLocalRelayPreview(root, request(), create, apply)).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    expect(create).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(readdirSync(join(root, DIRECTORY))).toHaveLength(64);

    for (const kind of ["malformed", "symlink", "oversize", ...(process.platform === "win32" ? [] : ["nonprivate"])]) {
      const candidateRoot = fixture();
      const command = request();
      await retain(candidateRoot, command);
      const basename = `.${"f".repeat(64)}.json.mex-tmp-12345-${"a".repeat(16)}`;
      const stage = join(candidateRoot, DIRECTORY, kind === "malformed" ? `${basename}-unexpected` : basename);
      if (kind === "symlink") {
        const outside = join(fixture(), "private.json");
        writeFileSync(outside, "private", { mode: 0o600 });
        symlinkSync(outside, stage);
      } else {
        writeFileSync(stage, kind === "oversize" ? "x".repeat(64 * 1024 + 1) : "private", { mode: kind === "nonprivate" ? 0o644 : 0o600 });
      }
      await expect(withLocalRelayPreview(candidateRoot, command, create, apply)).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
      expect(existsSync(receiptPath(candidateRoot, command))).toBe(true);
    }
    expect(create).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("resumes the 64th linked receipt before its inert stage was removed but rejects further overflow", async () => {
    for (const layout of ["linked-stage", "extra-stage", "extra-receipt"]) {
      const root = fixture();
      const command = request();
      await retain(root, command);
      const path = receiptPath(root, command);
      const original = readRelayPreviewFile(path, "relay.draft.save");
      const bytes = readFileSync(path);
      for (let index = 0; index < (layout === "extra-receipt" ? 64 : 63); index += 1) {
        writeFileSync(join(root, DIRECTORY, `${index.toString(16).padStart(64, "0")}.json`), bytes, { mode: 0o600 });
      }
      const targetName = path.split(/[\\/]/u).at(-1)!;
      const stage = join(root, DIRECTORY, `.${targetName}.mex-tmp-12345-${"a".repeat(16)}`);
      if (layout !== "extra-receipt") linkSync(path, stage);
      if (layout === "extra-stage") {
        writeFileSync(`${stage.slice(0, -16)}${"b".repeat(16)}`, bytes, { mode: 0o600 });
      }
      const beforeEntries = readdirSync(join(root, DIRECTORY));
      const create = vi.fn(async () => { throw new Error("must reuse retained receipt"); });
      const apply = vi.fn(async (value: TeamRelayPreviewEnvelope) => {
        expect(value).toEqual(original);
        return "recovered";
      });
      if (layout === "linked-stage") {
        await expect(withLocalRelayPreview(root, request("new-operation"), create, apply)).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
        expect(create).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
        await expect(withLocalRelayPreview(root, command, create, apply)).resolves.toBe("recovered");
        expect(readFileSync(stage)).toEqual(bytes);
        expect(existsSync(path)).toBe(false);
        expect(readdirSync(join(root, DIRECTORY))).toHaveLength(64);
      } else {
        await expect(withLocalRelayPreview(root, command, create, apply)).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
        expect(apply).not.toHaveBeenCalled();
        expect(readFileSync(path)).toEqual(bytes);
        expect(readdirSync(join(root, DIRECTORY))).toEqual(beforeEntries);
      }
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("rejects oversize or malformed retained bytes and unsafe local-create previews", async () => {
    for (const bytes of ["x".repeat(64 * 1024 + 1), "{}", JSON.stringify({ nested: Array(5).fill("private") })]) {
      const root = fixture();
      const command = request();
      mkdirSync(join(root, DIRECTORY), { recursive: true });
      writeFileSync(receiptPath(root, command), bytes, { mode: 0o600 });
      const create = vi.fn(async () => preview(command));
      const apply = vi.fn(async () => true);
      await expect(withLocalRelayPreview(root, command, create, apply)).rejects.toBeInstanceOf(MexPortError);
      expect(create).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    }
    for (const mutation of [
      (issued: TeamRelayPreviewEnvelope) => ({ ...issued, preview: { ...issued.preview, scope: "canonical" as const } }),
      (issued: TeamRelayPreviewEnvelope) => ({ ...issued, preview: { ...issued.preview, scope: "mixed" as const } }),
      (issued: TeamRelayPreviewEnvelope) => ({ ...issued, preview: { ...issued.preview, localChanges: [{ ...issued.preview.localChanges[0]!, afterRevision: null }] } }),
      (issued: TeamRelayPreviewEnvelope) => ({ ...issued, receipt: { ...issued.receipt, purposeIds: [{ purpose: "relay-draft" as const, id: "other-draft" }] } }),
    ]) {
      const root = fixture();
      const command = request();
      const issued = preview(command);
      const apply = vi.fn(async () => true);
      await expect(withLocalRelayPreview(root, command, async () => mutation(issued), apply)).rejects.toBeInstanceOf(MexPortError);
      expect(apply).not.toHaveBeenCalled();
      expect(existsSync(receiptPath(root, command))).toBe(false);
    }
  });
});
