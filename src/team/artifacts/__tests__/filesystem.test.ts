import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoRelativePath } from "../../contracts/shared.js";
import {
  atomicCreateArtifact,
  atomicReplaceArtifact,
  readContainedArtifact,
  tryReadContainedArtifact,
  withContainedArtifactLock,
} from "../filesystem.js";
import { revisionOf } from "../revision.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("contained atomic artifact I/O", () => {
  it("can publish owner-only private files without changing the default artifact mode", () => {
    const root = temporaryRoot();
    atomicCreateArtifact(root, ".mex/local/private.json", "private\n", 0o600);
    atomicCreateArtifact(root, ".mex/team/public.md", "public\n");
    if (process.platform !== "win32") {
      expect(lstatSync(join(root, ".mex/local/private.json")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(root, ".mex/team/public.md")).mode & 0o777).toBe(0o644 & ~process.umask());
    }
  });

  it("publishes complete bytes, refuses overwrite, and preserves stale revisions", () => {
    const root = temporaryRoot();
    const path = ".mex/team/members/member_00000000000000000000000000.md" as RepoRelativePath;
    const first = "first\n";
    const second = "second\n";

    expect(tryReadContainedArtifact(root, path, 100)).toBeNull();
    expect(existsSync(join(root, ".mex"))).toBe(false);
    expect(atomicCreateArtifact(root, path, first)).toBe(revisionOf(first));
    expect(readContainedArtifact(root, path, 100)).toMatchObject({ revision: revisionOf(first) });
    expect(() => atomicCreateArtifact(root, path, "overwrite\n")).toThrow(/already exists/);
    expect(readFileSync(join(root, ...path.split("/")), "utf8")).toBe(first);

    expect(atomicReplaceArtifact(root, path, revisionOf(first), second, 64 * 1024)).toBe(revisionOf(second));
    expect(readFileSync(join(root, ...path.split("/")), "utf8")).toBe(second);
    expect(() => atomicReplaceArtifact(root, path, revisionOf(first), "stale\n", 64 * 1024)).toThrow(/expected revision/);
    expect(readFileSync(join(root, ...path.split("/")), "utf8")).toBe(second);
    expect(readdirSync(dirname(join(root, ...path.split("/")))).every(
      (name) => !name.includes("mex-tmp") && !name.includes("mex-lock"),
    )).toBe(true);
  });

  it("enforces the artifact byte budget during reads and replacement revalidation", () => {
    const root = temporaryRoot();
    const path = ".mex/team/members/member_00000000000000000000000000.md" as RepoRelativePath;
    const oversized = "x".repeat(64 * 1024 + 1);
    atomicCreateArtifact(root, path, oversized);

    expect(() => readContainedArtifact(root, path, 64 * 1024)).toThrowError(
      expect.objectContaining({ problem: expect.objectContaining({ code: "VALIDATION_FAILED" }) }),
    );
    expect(() => atomicReplaceArtifact(
      root,
      path,
      revisionOf(oversized),
      "bounded replacement\n",
      64 * 1024,
    )).toThrowError(
      expect.objectContaining({ problem: expect.objectContaining({ code: "VALIDATION_FAILED" }) }),
    );
    expect(readFileSync(join(root, ...path.split("/")), "utf8")).toBe(oversized);
  });

  it("fails closed without removing unknown per-file lock metadata", () => {
    const root = temporaryRoot();
    const path = ".mex/team/members/member_00000000000000000000000000.md" as RepoRelativePath;
    atomicCreateArtifact(root, path, "first\n");
    const lock = join(root, ".mex/team/members", `.${path.split("/").at(-1)}.mex-lock`);
    writeFileSync(lock, "other writer\n");

    expect(() => atomicReplaceArtifact(root, path, revisionOf("first\n"), "second\n", 64 * 1024))
      .toThrowError(expect.objectContaining({
        problem: expect.objectContaining({ code: "REVISION_CONFLICT" }),
      }));
    expect(readFileSync(lock, "utf8")).toBe("other writer\n");
  });

  it("recovers a per-file replacement lock after its holder is killed", async () => {
    const root = temporaryRoot();
    const path = ".mex/team/members/member_00000000000000000000000000.md" as RepoRelativePath;
    const directory = ".mex/team/members" as RepoRelativePath;
    atomicCreateArtifact(root, path, "first\n");
    const lock = join(root, directory, `.${path.split("/").at(-1)}.mex-lock`);
    const captureLock = ".capture-owner.mex-lock";
    let captured = "";
    await withContainedArtifactLock(root, directory, captureLock, () => {
      captured = readFileSync(join(root, directory, captureLock), "utf8");
    });
    const metadata = JSON.parse(captured) as Record<string, unknown>;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      await once(child, "spawn");
      metadata.pid = child.pid;
      writeFileSync(lock, `${JSON.stringify(metadata)}\n`, "utf8");
      child.kill("SIGKILL");
      await once(child, "exit");

      expect(atomicReplaceArtifact(root, path, revisionOf("first\n"), "second\n", 64 * 1024))
        .toBe(revisionOf("second\n"));
      expect(readFileSync(join(root, ...path.split("/")), "utf8")).toBe("second\n");
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(`${lock}.recovery`)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("rejects a concurrent collection lock without removing the active writer's lock", async () => {
    const root = temporaryRoot();
    const directory = ".mex/team/members" as RepoRelativePath;
    const lockPath = join(root, directory, ".members.mex-lock");
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withContainedArtifactLock(
      root,
      directory,
      ".members.mex-lock",
      async () => {
        enterFirst();
        await firstReleased;
        return "first complete";
      },
    );

    await firstEntered;
    const heldLockBytes = readFileSync(lockPath, "utf8");
    try {
      await expect(withContainedArtifactLock(
        root,
        directory,
        ".members.mex-lock",
        () => "second complete",
      )).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
      expect(readFileSync(lockPath, "utf8")).toBe(heldLockBytes);
    } finally {
      releaseFirst();
    }

    await expect(first).resolves.toBe("first complete");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers bounded collection-lock metadata after its holder is killed", async () => {
    const root = temporaryRoot();
    const directory = ".mex/team/members" as RepoRelativePath;
    const lockName = ".members.mex-lock";
    const lockPath = join(root, directory, lockName);
    let captured = "";
    await withContainedArtifactLock(root, directory, lockName, () => {
      captured = readFileSync(lockPath, "utf8");
    });
    const metadata = JSON.parse(captured) as Record<string, unknown>;

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      await once(child, "spawn");
      metadata.pid = child.pid;
      writeFileSync(lockPath, `${JSON.stringify(metadata)}\n`, "utf8");
      child.kill("SIGKILL");
      await once(child, "exit");

      await expect(withContainedArtifactLock(
        root,
        directory,
        lockName,
        () => "recovered",
      )).resolves.toBe("recovered");
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(`${lockPath}.recovery`)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("recovers a dead crash marker but never steals malformed or foreign-root locks", async () => {
    const root = temporaryRoot();
    const otherRoot = temporaryRoot();
    const directory = ".mex/team/members" as RepoRelativePath;
    const lockName = ".members.mex-lock";
    const lockPath = join(root, directory, lockName);
    let captured = "";
    await withContainedArtifactLock(root, directory, lockName, () => {
      captured = readFileSync(lockPath, "utf8");
    });
    const deadMetadata = JSON.parse(captured) as Record<string, unknown>;
    deadMetadata.pid = 2_147_483_647;
    writeFileSync(`${lockPath}.recovery`, `${JSON.stringify(deadMetadata)}\n`, "utf8");
    await expect(withContainedArtifactLock(root, directory, lockName, () => "after crash"))
      .resolves.toBe("after crash");

    writeFileSync(lockPath, "not canonical lock metadata\n", "utf8");
    await expect(withContainedArtifactLock(root, directory, lockName, () => undefined))
      .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    expect(readFileSync(lockPath, "utf8")).toBe("not canonical lock metadata\n");

    rmSync(lockPath);
    const otherDirectory = join(otherRoot, directory);
    mkdirSync(otherDirectory, { recursive: true });
    let foreign = "";
    await withContainedArtifactLock(otherRoot, directory, lockName, () => {
      foreign = readFileSync(join(otherDirectory, lockName), "utf8");
    });
    writeFileSync(lockPath, foreign, "utf8");
    await expect(withContainedArtifactLock(root, directory, lockName, () => undefined))
      .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    expect(readFileSync(lockPath, "utf8")).toBe(foreign);
  });

  it("fails closed on a symlinked collection lock and cleans up after operation failure", async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const directory = ".mex/team/members" as RepoRelativePath;
    const lockName = ".members.mex-lock";
    const directoryPath = join(root, directory);
    const lockPath = join(directoryPath, lockName);
    mkdirSync(directoryPath, { recursive: true });
    const target = join(outside, "lock-target");
    writeFileSync(target, "outside\n", "utf8");
    symlinkSync(target, lockPath, "file");

    await expect(withContainedArtifactLock(root, directory, lockName, () => undefined))
      .rejects.toMatchObject({ problem: { code: "PATH_OUTSIDE_PROJECT" } });
    expect(readFileSync(target, "utf8")).toBe("outside\n");
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);

    rmSync(lockPath);
    await expect(withContainedArtifactLock(root, directory, lockName, () => {
      throw new Error("simulated writer crash");
    })).rejects.toThrow("simulated writer crash");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("rejects lexical escapes and symlinked ancestors without touching the target", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    mkdirSync(join(root, ".mex"));
    mkdirSync(join(outside, "team", "members"), { recursive: true });
    symlinkSync(outside, join(root, ".mex", "team"), process.platform === "win32" ? "junction" : "dir");
    const path = ".mex/team/members/member_00000000000000000000000000.md" as RepoRelativePath;

    expect(() => atomicCreateArtifact(root, path, "secret\n")).toThrow(/Path component|Unsafe/);
    expect(existsSync(join(outside, "team", "members", path.split("/").at(-1)!))).toBe(false);
    expect(lstatSync(join(root, ".mex", "team")).isSymbolicLink()).toBe(true);
    expect(() => atomicCreateArtifact(
      root,
      "../outside.md" as RepoRelativePath,
      "escape\n",
    )).toThrow(/repository-relative/);
  });
});

describe("Git's checkout line-ending conversion", () => {
  const CANONICAL = "---\nschema_version: 1\nid: \"member_00000000000000000000000000\"\n---\n";
  const path = ".mex/team/members/member_00000000000000000000000000.md" as RepoRelativePath;

  it("defaults to exact bytes and requires explicit canonical replacement checks", () => {
    const root = temporaryRoot();
    const crlf = CANONICAL.replaceAll("\n", "\r\n");
    atomicCreateArtifact(root, path, crlf);
    const canonical = readContainedArtifact(root, path, 64 * 1024, "canonical");
    const exact = readContainedArtifact(root, path, 64 * 1024);
    expect(Buffer.from(canonical.bytes).toString("utf8")).toBe(CANONICAL);
    expect(canonical.revision).toBe(revisionOf(CANONICAL));
    expect(Buffer.from(exact.bytes).toString("utf8")).toBe(crlf);
    expect(exact.revision).toBe(revisionOf(crlf));
    expect(exact.revision).not.toBe(canonical.revision);
    expect(tryReadContainedArtifact(root, path, 64 * 1024)).toEqual(exact);
    expect(() => atomicReplaceArtifact(root, path, canonical.revision, "stale\n", 64 * 1024))
      .toThrowError(expect.objectContaining({ problem: expect.objectContaining({ code: "REVISION_CONFLICT" }) }));
    expect(readFileSync(join(root, path), "utf8")).toBe(crlf);
    expect(atomicReplaceArtifact(root, path, exact.revision, crlf, 64 * 1024, "exact"))
      .toBe(revisionOf(crlf));
    // Canonical callers explicitly accept the LF revision of a CRLF checkout.
    expect(atomicReplaceArtifact(root, path, canonical.revision, CANONICAL, 64 * 1024, "canonical"))
      .toBe(revisionOf(CANONICAL));
  });

  it("is undone on read, so a Windows clone sees the bytes that were committed", () => {
    // A `.mex/**` artifact is canonical: written with LF, parsed with any `\r`
    // refused, and revisioned by the SHA-256 of its bytes. `core.autocrlf`
    // defaults to true on Windows, so a repository authored on macOS or Linux
    // checks out as CRLF and every artifact in it stops parsing — on a tree Git
    // reports as clean. Measured on a real cross-platform repository: Members,
    // Activity and the Inbox were all empty or in error.
    const root = temporaryRoot();
    git(root, ["init", "--quiet", "-b", "main"]);
    git(root, ["config", "user.email", "artifacts@example.invalid"]);
    git(root, ["config", "user.name", "Artifacts Contract"]);
    git(root, ["config", "core.autocrlf", "true"]);
    mkdirSync(dirname(join(root, ...path.split("/"))), { recursive: true });
    writeFileSync(join(root, ...path.split("/")), CANONICAL);
    git(root, ["add", "--", path]);
    git(root, ["commit", "--quiet", "-m", "canonical artifact"]);

    // Let Git write the working copy, exactly as a clone would. This is the
    // whole point: the CRLF is Git's, not the test's.
    rmSync(join(root, ...path.split("/")));
    git(root, ["checkout", "--", path]);

    const onDisk = readFileSync(join(root, ...path.split("/")));
    expect(onDisk.includes(Buffer.from("\r\n"))).toBe(true);
    expect(onDisk.equals(Buffer.from(CANONICAL, "utf8"))).toBe(false);

    const read = readContainedArtifact(root, path, 64 * 1024, "canonical");
    expect(Buffer.from(read.bytes).toString("utf8")).toBe(CANONICAL);
    // And the revision is the committed artifact's, not this platform's — the
    // same artifact hashed differently on Windows and macOS before this.
    expect(read.revision).toBe(revisionOf(CANONICAL));
  });

  it("leaves a lone carriage return alone, because Git never wrote it", () => {
    // The conversion undone here is CRLF only. A bare `\r` is not something a
    // checkout produces, so it is genuinely non-canonical content and the
    // parsers must still reject it. Narrowing this to CRLF is what keeps the
    // canonical guarantee intact rather than merely relaxed.
    const root = temporaryRoot();
    const lone = "---\rschema_version: 1\n---\n";
    mkdirSync(dirname(join(root, ...path.split("/"))), { recursive: true });
    writeFileSync(join(root, ...path.split("/")), lone);

    const read = readContainedArtifact(root, path, 64 * 1024, "canonical");
    expect(Buffer.from(read.bytes).toString("utf8")).toBe(lone);
    expect(read.revision).toBe(revisionOf(lone));
  });

  it("does not turn mixed line endings into a canonical record or shrink the on-disk bound", () => {
    const root = temporaryRoot();
    const mixed = CANONICAL.replace("---\n", "---\r\n");
    atomicCreateArtifact(root, path, mixed);
    const read = readContainedArtifact(root, path, 64 * 1024, "canonical");
    expect(Buffer.from(read.bytes).toString("utf8")).toBe(mixed);
    expect(read.revision).toBe(revisionOf(mixed));
    expect(() => readContainedArtifact(root, path, Buffer.byteLength(CANONICAL), "canonical"))
      .toThrowError(expect.objectContaining({ problem: expect.objectContaining({ code: "VALIDATION_FAILED" }) }));
    expect(readFileSync(join(root, path), "utf8")).toBe(mixed);
  });
});

function git(root: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-lane-c-artifacts-"));
  roots.push(root);
  return root;
}
