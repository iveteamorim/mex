import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureMarkdownAnchor,
  ensureOpencodeAnchor,
  planAnchorPointer,
  planOpencodeAnchor,
  renderAnchorPointerBlock,
  MEX_ANCHOR_START,
  MEX_ANCHOR_END,
} from "../src/setup/anchor.js";
import { checkAnchorLink } from "../src/drift/checkers/anchor-link.js";
import { ensureToolAnchors } from "../src/setup/index.js";

// Setup used to skip any tool anchor that already existed, so a repo with a
// hand-written .cursorrules got a fully populated .mex/ that nothing loaded.
// See https://github.com/mex-memory/mex/issues/106

let tmpDir: string;
let templateDir: string;

const HAND_WRITTEN = "# My rules\n\nAlways run the linter before committing.\n";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-anchor-"));
  templateDir = mkdtempSync(join(tmpdir(), "mex-anchor-tpl-"));
  writeFileSync(join(templateDir, ".cursorrules"), "<!-- mex-tool-config -->\ntemplate body\n");
  writeFileSync(
    join(templateDir, "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", instructions: [".mex/AGENTS.md"] }, null, 2)}\n`,
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(templateDir, { recursive: true, force: true });
});

// ── Markdown anchors ──

describe("ensureMarkdownAnchor", () => {
  it("copies the template when no anchor exists", () => {
    const result = ensureMarkdownAnchor(tmpDir, ".cursorrules", join(templateDir, ".cursorrules"));
    expect(result.outcome).toBe("created");
    expect(readFileSync(join(tmpDir, ".cursorrules"), "utf-8")).toContain("template body");
  });

  it("appends a pointer to a hand-written anchor instead of skipping it", () => {
    writeFileSync(join(tmpDir, ".cursorrules"), HAND_WRITTEN);
    const result = ensureMarkdownAnchor(tmpDir, ".cursorrules", join(templateDir, ".cursorrules"));

    expect(result.outcome).toBe("appended");
    const after = readFileSync(join(tmpDir, ".cursorrules"), "utf-8");
    // The user's bytes survive untouched, at the front, byte for byte.
    expect(after.startsWith(HAND_WRITTEN)).toBe(true);
    expect(after).toContain(".mex/ROUTER.md");
    expect(after).toContain(MEX_ANCHOR_START);
  });

  it("creates the parent directory for a nested anchor", () => {
    const result = ensureMarkdownAnchor(
      tmpDir,
      ".github/copilot-instructions.md",
      join(templateDir, ".cursorrules"),
    );
    expect(result.outcome).toBe("created");
    expect(readFileSync(join(tmpDir, ".github/copilot-instructions.md"), "utf-8"))
      .toContain("template body");
  });

  it("leaves an anchor that already names .mex/ alone", () => {
    const own = "# My rules\n\nRead `.mex/ROUTER.md` first.\n";
    writeFileSync(join(tmpDir, ".cursorrules"), own);
    const result = ensureMarkdownAnchor(tmpDir, ".cursorrules", join(templateDir, ".cursorrules"));

    expect(result.outcome).toBe("already-linked");
    expect(readFileSync(join(tmpDir, ".cursorrules"), "utf-8")).toBe(own);
  });

  it("leaves a mex template copy alone rather than restating its pointer", () => {
    const copy = "<!-- mex-tool-config: managed copy -->\nRead ROUTER.md first.\n";
    writeFileSync(join(tmpDir, ".cursorrules"), copy);
    const result = ensureMarkdownAnchor(tmpDir, ".cursorrules", join(templateDir, ".cursorrules"));

    expect(result.outcome).toBe("already-linked");
    expect(readFileSync(join(tmpDir, ".cursorrules"), "utf-8")).toBe(copy);
  });

  it("refreshes an existing mex block without disturbing the rest", () => {
    writeFileSync(
      join(tmpDir, ".cursorrules"),
      `${HAND_WRITTEN}\n${MEX_ANCHOR_START}\nstale contents\n${MEX_ANCHOR_END}\n\n## After\ntail text\n`,
    );
    const result = ensureMarkdownAnchor(tmpDir, ".cursorrules", join(templateDir, ".cursorrules"));

    expect(result.outcome).toBe("updated");
    const after = readFileSync(join(tmpDir, ".cursorrules"), "utf-8");
    expect(after).not.toContain("stale contents");
    expect(after.startsWith(HAND_WRITTEN)).toBe(true);
    expect(after).toContain("## After\ntail text\n");
  });

  it("is idempotent: a second run changes nothing", () => {
    writeFileSync(join(tmpDir, ".cursorrules"), HAND_WRITTEN);
    ensureMarkdownAnchor(tmpDir, ".cursorrules", join(templateDir, ".cursorrules"));
    const first = readFileSync(join(tmpDir, ".cursorrules"), "utf-8");

    const second = ensureMarkdownAnchor(tmpDir, ".cursorrules", join(templateDir, ".cursorrules"));
    expect(second.outcome).toBe("already-linked");
    expect(readFileSync(join(tmpDir, ".cursorrules"), "utf-8")).toBe(first);
  });

  it("preserves CRLF line endings", () => {
    writeFileSync(join(tmpDir, ".cursorrules"), "# My rules\r\n\r\nRun the linter.\r\n");
    ensureMarkdownAnchor(tmpDir, ".cursorrules", join(templateDir, ".cursorrules"));

    const after = readFileSync(join(tmpDir, ".cursorrules"), "utf-8");
    expect(after).toContain(`${MEX_ANCHOR_START}\r\n`);
    expect(after.includes("\n\n")).toBe(false); // no bare LF crept in
  });

  it("refuses to edit a file with unbalanced markers and leaves it untouched", () => {
    const broken = `${HAND_WRITTEN}\n${MEX_ANCHOR_START}\nno end marker\n`;
    writeFileSync(join(tmpDir, ".cursorrules"), broken);
    const result = ensureMarkdownAnchor(tmpDir, ".cursorrules", join(templateDir, ".cursorrules"));

    expect(result.outcome).toBe("conflict");
    expect(result.reason).toContain("unbalanced");
    expect(readFileSync(join(tmpDir, ".cursorrules"), "utf-8")).toBe(broken);
  });

  it("reports a conflict on invalid UTF-8 rather than corrupting the file", () => {
    const plan = planAnchorPointer(Buffer.from([0xff, 0xfe, 0x00]));
    expect(plan.outcome).toBe("conflict");
    expect(plan.desiredBytes).toBeUndefined();
  });

  it("refuses a destination that is not a known tool config", () => {
    // This module writes into files a human wrote, so it is one of the few
    // writers outside the wiki engine. The fixed registry, not the caller,
    // decides what it may touch -- including that it never touches .mex/.
    expect(() =>
      ensureMarkdownAnchor(tmpDir, ".mex/ROUTER.md", join(templateDir, ".cursorrules")),
    ).toThrow(/not a known AI tool config/);
    expect(() =>
      ensureMarkdownAnchor(tmpDir, "../escape.md", join(templateDir, ".cursorrules")),
    ).toThrow(/not a known AI tool config/);
  });

  it("renders a block that names both scaffold entry points", () => {
    const block = renderAnchorPointerBlock();
    expect(block).toContain(".mex/AGENTS.md");
    expect(block).toContain(".mex/ROUTER.md");
    expect(block.startsWith(MEX_ANCHOR_START)).toBe(true);
    expect(block.endsWith(MEX_ANCHOR_END)).toBe(true);
  });
});

// ── OpenCode's JSON anchor ──

describe("ensureOpencodeAnchor", () => {
  const write = (value: unknown) => {
    mkdirSync(join(tmpDir, ".opencode"), { recursive: true });
    writeFileSync(join(tmpDir, ".opencode/opencode.json"), `${JSON.stringify(value, null, 2)}\n`);
  };
  const read = () =>
    JSON.parse(readFileSync(join(tmpDir, ".opencode/opencode.json"), "utf-8")) as Record<
      string,
      unknown
    >;

  it("copies the template when no config exists", () => {
    const result = ensureOpencodeAnchor(
      tmpDir,
      ".opencode/opencode.json",
      join(templateDir, "opencode.json"),
    );
    expect(result.outcome).toBe("created");
    expect(read().instructions).toEqual([".mex/AGENTS.md"]);
  });

  it("adds the scaffold to an existing instructions list, keeping the user's entries", () => {
    write({ $schema: "https://opencode.ai/config.json", instructions: ["docs/house-style.md"] });
    const result = ensureOpencodeAnchor(
      tmpDir,
      ".opencode/opencode.json",
      join(templateDir, "opencode.json"),
    );

    expect(result.outcome).toBe("appended");
    expect(read().instructions).toEqual(["docs/house-style.md", ".mex/AGENTS.md"]);
    expect(read().$schema).toBe("https://opencode.ai/config.json");
  });

  it("adds an instructions list to a config that has none", () => {
    write({ theme: "dark" });
    ensureOpencodeAnchor(tmpDir, ".opencode/opencode.json", join(templateDir, "opencode.json"));

    expect(read().instructions).toEqual([".mex/AGENTS.md"]);
    expect(read().theme).toBe("dark");
  });

  it("leaves a config that already points at the scaffold alone", () => {
    write({ instructions: [".mex/ROUTER.md"] });
    const before = readFileSync(join(tmpDir, ".opencode/opencode.json"), "utf-8");
    const result = ensureOpencodeAnchor(
      tmpDir,
      ".opencode/opencode.json",
      join(templateDir, "opencode.json"),
    );

    expect(result.outcome).toBe("already-linked");
    expect(readFileSync(join(tmpDir, ".opencode/opencode.json"), "utf-8")).toBe(before);
  });

  it("refuses to rewrite a config it cannot read, rather than clobbering it", () => {
    mkdirSync(join(tmpDir, ".opencode"), { recursive: true });
    const broken = "{ not json";
    writeFileSync(join(tmpDir, ".opencode/opencode.json"), broken);
    const result = ensureOpencodeAnchor(
      tmpDir,
      ".opencode/opencode.json",
      join(templateDir, "opencode.json"),
    );

    expect(result.outcome).toBe("conflict");
    expect(readFileSync(join(tmpDir, ".opencode/opencode.json"), "utf-8")).toBe(broken);
  });

  it("treats a non-string instructions field as a conflict", () => {
    expect(planOpencodeAnchor('{"instructions": "docs.md"}').outcome).toBe("conflict");
  });
});

// ── The durable half: detection ──

describe("checkAnchorLink", () => {
  const scaffold = () => {
    mkdirSync(join(tmpDir, ".mex"), { recursive: true });
    writeFileSync(join(tmpDir, ".mex/ROUTER.md"), "# Router\n");
  };
  const run = () => checkAnchorLink(tmpDir, join(tmpDir, ".mex"));

  it("stays silent when there is no scaffold to orphan", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), HAND_WRITTEN);
    expect(run()).toHaveLength(0);
  });

  it("flags a populated scaffold that the only anchor never mentions", () => {
    scaffold();
    writeFileSync(join(tmpDir, "CLAUDE.md"), HAND_WRITTEN);

    const issues = run();
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("SCAFFOLD_ORPHANED");
    expect(issues[0].severity).toBe("error");
    // Reported against the file the user has to edit, not the scaffold.
    expect(issues[0].file).toBe("CLAUDE.md");
  });

  it("stays silent when the user chose to install no tool config", () => {
    // Setup's "None / skip" option says .mex/AGENTS.md works with any tool
    // that can read files. That is a deliberate trade-off, not drift.
    scaffold();
    writeFileSync(join(tmpDir, ".mex/config.json"), JSON.stringify({ aiTools: [] }));
    expect(run()).toHaveLength(0);
  });

  it("still reports when a tool was selected but its anchor does not point at the scaffold", () => {
    scaffold();
    writeFileSync(join(tmpDir, ".mex/config.json"), JSON.stringify({ aiTools: ["claude"] }));
    writeFileSync(join(tmpDir, "CLAUDE.md"), HAND_WRITTEN);
    expect(run()).toHaveLength(1);
  });

  it("does not treat unreadable config as an opt-out", () => {
    scaffold();
    writeFileSync(join(tmpDir, ".mex/config.json"), "{ not json");
    expect(run()).toHaveLength(1);
  });

  it("flags a scaffold with no tool config at all", () => {
    scaffold();
    const issues = run();
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("SCAFFOLD_ORPHANED");
    expect(issues[0].file).toBe(".mex/ROUTER.md");
    expect(issues[0].message).toContain("mex setup");
  });

  it("is satisfied by any one anchor pointing at the scaffold", () => {
    scaffold();
    writeFileSync(join(tmpDir, "CLAUDE.md"), HAND_WRITTEN);
    writeFileSync(join(tmpDir, ".cursorrules"), "See `.mex/ROUTER.md` for context.\n");
    expect(run()).toHaveLength(0);
  });

  it("accepts the pointer setup appends", () => {
    scaffold();
    writeFileSync(join(tmpDir, ".cursorrules"), HAND_WRITTEN);
    ensureMarkdownAnchor(tmpDir, ".cursorrules", join(templateDir, ".cursorrules"));
    expect(run()).toHaveLength(0);
  });

  it("accepts OpenCode's JSON pointer", () => {
    scaffold();
    mkdirSync(join(tmpDir, ".opencode"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".opencode/opencode.json"),
      JSON.stringify({ instructions: [".mex/AGENTS.md"] }),
    );
    expect(run()).toHaveLength(0);
  });

  it("does not accept an OpenCode config whose instructions ignore the scaffold", () => {
    scaffold();
    mkdirSync(join(tmpDir, ".opencode"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".opencode/opencode.json"),
      JSON.stringify({ instructions: ["docs/house-style.md"] }),
    );
    expect(run()).toHaveLength(1);
  });

  it("does not mistake the word mex for a scaffold pointer", () => {
    scaffold();
    // Prose about the tool loads nothing. This is exactly the state the issue
    // describes: `grep -c mex CLAUDE.md` is non-zero, yet nothing is loaded.
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# Rules\n\nWe use mex for context.\n");
    expect(run()).toHaveLength(1);
  });

  it("names every anchor it looked at so the fix is unambiguous", () => {
    scaffold();
    writeFileSync(join(tmpDir, "CLAUDE.md"), HAND_WRITTEN);
    writeFileSync(join(tmpDir, ".cursorrules"), HAND_WRITTEN);

    const [issue] = run();
    expect(issue.message).toContain("CLAUDE.md");
    expect(issue.message).toContain(".cursorrules");
  });
});

// ── The path setup actually takes ──

describe("ensureToolAnchors", () => {
  // Everything above tests the writers directly. These test the wiring setup
  // uses: the tool list in, the console reporting and the sticky notes out.
  let logs: string[];
  let templates: string;

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    // Mirrors templates/.tool-configs/, which is what TEMPLATES_DIR resolves to.
    templates = mkdtempSync(join(tmpdir(), "mex-anchor-td-"));
    mkdirSync(join(templates, ".tool-configs"), { recursive: true });
    for (const name of [".cursorrules", ".windsurfrules", "copilot-instructions.md"]) {
      writeFileSync(
        join(templates, ".tool-configs", name),
        "<!-- mex-tool-config -->\ntemplate body\n",
      );
    }
    writeFileSync(
      join(templates, ".tool-configs/opencode.json"),
      `${JSON.stringify({ instructions: [".mex/AGENTS.md"] }, null, 2)}\n`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(templates, { recursive: true, force: true });
  });

  it("appends a pointer to every selected tool's existing anchor", () => {
    writeFileSync(join(tmpDir, ".cursorrules"), HAND_WRITTEN);
    writeFileSync(join(tmpDir, ".windsurfrules"), HAND_WRITTEN);

    const notes = ensureToolAnchors(tmpDir, templates, ["cursor", "windsurf"], false);

    expect(notes).toEqual([]);
    for (const file of [".cursorrules", ".windsurfrules"]) {
      const after = readFileSync(join(tmpDir, file), "utf-8");
      expect(after.startsWith(HAND_WRITTEN)).toBe(true);
      expect(after).toContain(".mex/ROUTER.md");
    }
  });

  it("leaves Claude and Codex to the agent-skills installer", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), HAND_WRITTEN);
    ensureToolAnchors(tmpDir, templates, ["claude", "codex"], false);
    // Untouched here: appending twice would duplicate the installer's block.
    expect(readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8")).toBe(HAND_WRITTEN);
  });

  it("creates a missing anchor from the template", () => {
    const notes = ensureToolAnchors(tmpDir, templates, ["copilot"], false);
    expect(notes).toEqual([]);
    expect(readFileSync(join(tmpDir, ".github/copilot-instructions.md"), "utf-8"))
      .toContain("template body");
  });

  it("links OpenCode's JSON config", () => {
    mkdirSync(join(tmpDir, ".opencode"), { recursive: true });
    writeFileSync(join(tmpDir, ".opencode/opencode.json"), JSON.stringify({ theme: "dark" }));

    ensureToolAnchors(tmpDir, templates, ["opencode"], false);

    const parsed = JSON.parse(readFileSync(join(tmpDir, ".opencode/opencode.json"), "utf-8"));
    expect(parsed.instructions).toEqual([".mex/AGENTS.md"]);
    expect(parsed.theme).toBe("dark");
  });

  it("returns a note for an anchor it could not link, so setup can repeat it", () => {
    const broken = `${HAND_WRITTEN}\n${MEX_ANCHOR_START}\nno end marker\n`;
    writeFileSync(join(tmpDir, ".cursorrules"), broken);

    const notes = ensureToolAnchors(tmpDir, templates, ["cursor"], false);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(".cursorrules");
    expect(notes[0]).toContain(".mex/ROUTER.md");
    expect(readFileSync(join(tmpDir, ".cursorrules"), "utf-8")).toBe(broken);
  });

  it("writes nothing on a dry run, and says what the real run would do", () => {
    writeFileSync(join(tmpDir, ".cursorrules"), HAND_WRITTEN);

    ensureToolAnchors(tmpDir, templates, ["cursor"], true);

    // The bug this replaces: --dry-run promised to overwrite while the real
    // path skipped. Plan and write are now the same function.
    expect(readFileSync(join(tmpDir, ".cursorrules"), "utf-8")).toBe(HAND_WRITTEN);
    expect(logs.join("\n")).toContain("(dry run)");
    expect(logs.join("\n")).toContain(".cursorrules");
  });

  it("is quiet and idempotent when every anchor is already linked", () => {
    writeFileSync(join(tmpDir, ".cursorrules"), HAND_WRITTEN);
    ensureToolAnchors(tmpDir, templates, ["cursor"], false);
    const once = readFileSync(join(tmpDir, ".cursorrules"), "utf-8");

    const notes = ensureToolAnchors(tmpDir, templates, ["cursor"], false);

    expect(notes).toEqual([]);
    expect(readFileSync(join(tmpDir, ".cursorrules"), "utf-8")).toBe(once);
  });

  it("repairs an install the old skip orphaned", () => {
    // The case that matters: a populated scaffold whose aiTools are already
    // saved never shows the menu, so linking has to happen on that path too.
    mkdirSync(join(tmpDir, ".mex"), { recursive: true });
    writeFileSync(join(tmpDir, ".mex/ROUTER.md"), "# Router\n");
    writeFileSync(join(tmpDir, ".cursorrules"), HAND_WRITTEN);
    expect(checkAnchorLink(tmpDir, join(tmpDir, ".mex"))).toHaveLength(1);

    ensureToolAnchors(tmpDir, templates, ["cursor"], false);

    expect(checkAnchorLink(tmpDir, join(tmpDir, ".mex"))).toHaveLength(0);
  });
});
