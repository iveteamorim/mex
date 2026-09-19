import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MexPortError } from "../../contracts/shared.js";
import {
  TEAM_RECEIPT_SIGNER_RELATIVE_PATH,
  TeamReceiptSigner,
} from "../receipt-signer.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TeamReceiptSigner", () => {
  it("does not initialize on use and provisions one stable mode-0600 key explicitly", () => {
    const root = temporaryRoot();
    const signer = new TeamReceiptSigner(root, "signer_test_scaffold");
    expect(() => signer.sign("receipt")).toThrowError(MexPortError);
    expect(existsSync(join(root, ".mex"))).toBe(false);

    signer.initialize();
    const path = keyPath(root);
    const firstBytes = readFileSync(path);
    const first = statSync(path);
    expect(firstBytes).toHaveLength(32);
    if (process.platform !== "win32") expect(first.mode & 0o777).toBe(0o600);

    signer.initialize();
    expect(readFileSync(path)).toEqual(firstBytes);
    expect(statSync(path).mtimeMs).toBe(first.mtimeMs);
  });

  it("converges concurrent initializers and verifies only the exact bound payload", async () => {
    const root = temporaryRoot();
    const first = new TeamReceiptSigner(root, "shared_scaffold");
    const second = new TeamReceiptSigner(root, "shared_scaffold");
    await Promise.all([
      Promise.resolve().then(() => first.initialize()),
      Promise.resolve().then(() => second.initialize()),
    ]);
    const signature = first.sign("canonical receipt");
    expect(() => second.verify("canonical receipt", signature)).not.toThrow();
    expect(() => second.verify("changed receipt", signature)).toThrowError(MexPortError);
    expect(() => new TeamReceiptSigner(root, "other_scaffold").verify(
      "canonical receipt",
      signature,
    )).toThrowError(MexPortError);
  });

  it("binds signatures to the physical repository identity", () => {
    const firstRoot = temporaryRoot();
    const secondRoot = temporaryRoot();
    const first = new TeamReceiptSigner(firstRoot, "shared_scaffold");
    first.initialize();
    mkdirSync(join(secondRoot, ".mex/local"), { recursive: true });
    writeFileSync(keyPath(secondRoot), readFileSync(keyPath(firstRoot)), { mode: 0o600 });
    const signature = first.sign("canonical receipt");
    expect(() => new TeamReceiptSigner(secondRoot, "shared_scaffold").verify(
      "canonical receipt",
      signature,
    )).toThrowError(MexPortError);
  });

  it("accepts the shared 512-character scaffold boundary including multibyte text", () => {
    const root = temporaryRoot();
    const scaffoldId = "🙂".repeat(256);
    expect(scaffoldId).toHaveLength(512);
    expect(Buffer.byteLength(scaffoldId, "utf8")).toBeGreaterThan(512);
    const signer = new TeamReceiptSigner(root, scaffoldId);
    signer.initialize();
    const signature = signer.sign("canonical receipt");
    expect(() => signer.verify("canonical receipt", signature)).not.toThrow();

    expect(() => new TeamReceiptSigner(root, "a".repeat(513)))
      .toThrowError(MexPortError);
    expect(() => new TeamReceiptSigner(root, "scaffold\nidentity"))
      .toThrowError(MexPortError);
  });

  it("fails closed for symlinked, malformed, oversized, or permissive credentials", () => {
    const cases: readonly [string, (path: string, root: string) => void][] = [
      ["symlinked", (path, root) => {
        const target = join(root, "outside-key");
        writeFileSync(target, Buffer.alloc(32), { mode: 0o600 });
        symlinkSync(target, path);
      }],
      ["malformed", (path) => writeFileSync(path, Buffer.alloc(31), { mode: 0o600 })],
      ["oversized", (path) => writeFileSync(path, Buffer.alloc(33), { mode: 0o600 })],
      ["permissive", (path) => {
        writeFileSync(path, Buffer.alloc(32), { mode: 0o600 });
        chmodSync(path, 0o644);
      }],
    ];
    for (const [label, install] of cases) {
      if (label === "permissive" && process.platform === "win32") continue;
      const root = temporaryRoot();
      mkdirSync(join(root, ".mex/local"), { recursive: true });
      install(keyPath(root), root);
      const signer = new TeamReceiptSigner(root, `unsafe_${label}`);
      expect(() => signer.initialize(), label).toThrowError(MexPortError);
      expect(() => signer.sign("receipt"), label).toThrowError(MexPortError);
    }
  });

  it("never follows a symlinked local directory while provisioning", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    mkdirSync(join(root, ".mex"));
    symlinkSync(outside, join(root, ".mex/local"), "dir");

    expect(() => new TeamReceiptSigner(root, "symlinked_local").initialize())
      .toThrowError(MexPortError);
    expect(existsSync(join(outside, "identity-activity-signing.key"))).toBe(false);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-team-receipt-signer-"));
  roots.push(root);
  return root;
}

function keyPath(root: string): string {
  return join(root, ...TEAM_RECEIPT_SIGNER_RELATIVE_PATH.split("/"));
}
