import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WIKI_CORPUS_LIMITS, WikiCorpusLimitError } from "../../index/corpus-policy.js";
import { rebuildWikiIndex } from "../../index/rebuild.js";
import {
  attestEntityClaimants,
  locateEntity,
  locateEntityClaimants,
  WikiClaimantScanIncompleteError,
} from "../locate.js";

const ENTITY_ID = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-locate-"));
  roots.push(root);
  return root;
}

function entityMarkdown(title: string, revision = 1): string {
  return `<!-- mex:entity
id: ${ENTITY_ID}
type: decision
status: promoted
revision: ${revision}
-->
## ${title}

Current canonical prose.
`;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("current-filesystem entity claimant location", () => {
  it("ignores a stale index after the canonical claimant moves", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "old"), { recursive: true });
    writeFileSync(join(root, "old", "decision.md"), entityMarkdown("Before move"), "utf8");
    const indexPath = join(root, "wiki.db");
    rebuildWikiIndex({ scaffoldRoot: root, indexPath });

    mkdirSync(join(root, "current"), { recursive: true });
    renameSync(join(root, "old", "decision.md"), join(root, "current", "decision.md"));

    const result = locateEntityClaimants(ENTITY_ID, { scaffoldRoot: root, indexPath });
    expect(result).toMatchObject({ claimantCount: 1, ambiguous: false });
    expect(result.winner?.path).toBe("current/decision.md");
    expect(locateEntity(ENTITY_ID, { scaffoldRoot: root, indexPath })?.path).toBe("current/decision.md");
  });

  it("selects the deterministic winner, saturates duplicate count, and preserves replay preference", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "z-last.md"), entityMarkdown("Last claimant", 3), "utf8");
    writeFileSync(join(root, "a-first.md"), entityMarkdown("First claimant", 1), "utf8");
    writeFileSync(join(root, "m-middle.md"), entityMarkdown("Middle claimant", 2), "utf8");

    const result = locateEntityClaimants(ENTITY_ID, { scaffoldRoot: root });
    expect(result).toMatchObject({ claimantCount: 2, ambiguous: true });
    expect(result.winner?.path).toBe("a-first.md");
    expect(result.winner?.entity.revision).toBe(1);

    const replay = locateEntityClaimants(ENTITY_ID, {
      scaffoldRoot: root,
      preferFile: "z-last.md",
    });
    expect(replay).toMatchObject({ claimantCount: 2, ambiguous: true });
    expect(replay.winner?.path).toBe("z-last.md");
    expect(replay.winner?.entity.revision).toBe(3);
  });

  it("fails closed on a later over-limit file instead of trusting an earlier winner", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "a-claimant.md"), entityMarkdown("Bounded claimant"), "utf8");
    writeFileSync(join(root, "z-oversized.md"), "# placeholder\n", "utf8");

    expect(() => locateEntityClaimants(ENTITY_ID, {
      scaffoldRoot: root,
      readFile: (absolutePath) => absolutePath.endsWith("z-oversized.md")
        ? "x".repeat(WIKI_CORPUS_LIMITS.maxFileBytes + 1)
        : readFileSync(absolutePath, "utf8"),
    })).toThrowError(WikiCorpusLimitError);
    expect(existsSync(join(root, "wiki.db"))).toBe(false);
  });

  it("attests every discovered source while preserving tolerant ordinary lookup", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "a-claimant.md"), entityMarkdown("Readable claimant"), "utf8");
    writeFileSync(join(root, "z-unreadable.md"), "# unreadable seam\n", "utf8");
    const options = {
      scaffoldRoot: root,
      readFile: (absolutePath: string) => {
        if (absolutePath.endsWith("z-unreadable.md")) throw new Error("injected read failure");
        return readFileSync(absolutePath, "utf8");
      },
    };

    expect(locateEntity(ENTITY_ID, options)?.path).toBe("a-claimant.md");
    expect(() => attestEntityClaimants(ENTITY_ID, options))
      .toThrowError(WikiClaimantScanIncompleteError);
  });

  it("does not follow a Markdown leaf symlink to manufacture a claimant", () => {
    if (process.platform === "win32") return;
    const root = temporaryRoot();
    writeFileSync(join(root, "canonical.txt"), entityMarkdown("Symlink target"), "utf8");
    symlinkSync("canonical.txt", join(root, "linked.md"));

    expect(locateEntityClaimants(ENTITY_ID, { scaffoldRoot: root })).toEqual({
      winner: null,
      claimantCount: 0,
      ambiguous: false,
    });
    expect(() => attestEntityClaimants(ENTITY_ID, { scaffoldRoot: root }))
      .toThrowError(WikiClaimantScanIncompleteError);
    expect(existsSync(join(root, "wiki.db"))).toBe(false);
  });
});
