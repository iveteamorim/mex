import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DriftIssue } from "../../types.js";
import {
  ANCHOR_FILES,
  opencodeInstructions,
  referencesScaffold,
} from "../../tool-config.js";

/**
 * Does anything actually load the scaffold?
 *
 * A `.mex/` directory is only worth its population cost if some always-loaded
 * file tells the agent to read it. Claude Code loads `CLAUDE.md`, Cursor loads
 * `.cursorrules`; none of them go looking for `.mex/ROUTER.md` unaided. So a
 * scaffold with no anchor pointing at it is correct, complete, and inert --
 * and nothing else in `mex check` notices, because every other checker
 * validates the scaffold's contents rather than its reachability.
 *
 * Setup now writes the pointer itself, but this check is the durable half: it
 * keeps working when the anchor is deleted later, restored from a template, or
 * replaced by a teammate who never ran setup.
 *
 * See https://github.com/mex-memory/mex/issues/106
 */

const FIX_HINT =
  "Add a line naming `.mex/ROUTER.md` to it, or rerun `mex setup` to have one appended.";

/**
 * Whether the scaffold records an explicit decision to install no tool config.
 * Absent or malformed config is not a decision, so it does not silence the
 * check -- only an `aiTools` present and empty does.
 */
function optedOutOfToolConfigs(scaffoldRoot: string): boolean {
  try {
    const raw = readFileSync(resolve(scaffoldRoot, "config.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return false;
    const tools = (parsed as Record<string, unknown>).aiTools;
    return Array.isArray(tools) && tools.length === 0;
  } catch {
    return false;
  }
}

/** Whether one anchor file points at the scaffold. */
function anchorPointsAtScaffold(projectRoot: string, path: string, format: string): boolean {
  const abs = resolve(projectRoot, path);
  if (!existsSync(abs)) return false;
  let content: string;
  try {
    content = readFileSync(abs, "utf-8");
  } catch {
    // Unreadable file: treat as no evidence rather than reporting a
    // checker-internal error the user cannot act on.
    return false;
  }
  if (format === "json") {
    const instructions = opencodeInstructions(content);
    if (instructions === null) return false;
    return instructions.some((entry) => entry.startsWith(".mex/") || referencesScaffold(entry));
  }
  return referencesScaffold(content);
}

/**
 * Report a populated scaffold that no root anchor references.
 *
 * `scaffoldRoot` is passed rather than assumed so a scaffold configured
 * somewhere other than `<root>/.mex` is still checked.
 */
export function checkAnchorLink(projectRoot: string, scaffoldRoot: string): DriftIssue[] {
  // Without a router there is no scaffold to orphan. The other checkers own
  // the "scaffold is incomplete" story; this one only asks about reachability.
  if (!existsSync(resolve(scaffoldRoot, "ROUTER.md"))) return [];

  // Setup offers "None / skip", whose whole point is that `.mex/AGENTS.md`
  // works with any tool that can read files. Someone who chose that made this
  // trade-off deliberately and does not need it reported back at them.
  if (optedOutOfToolConfigs(scaffoldRoot)) return [];

  const present = ANCHOR_FILES.filter((anchor) =>
    existsSync(resolve(projectRoot, anchor.path)),
  );

  if (present.length === 0) {
    return [
      {
        code: "SCAFFOLD_ORPHANED",
        severity: "error",
        file: ".mex/ROUTER.md",
        line: null,
        message:
          "The scaffold is populated but no AI tool config exists to load it, so no agent will read it. "
          + `Run \`mex setup\` to create one (${ANCHOR_FILES.map((a) => a.path).join(", ")}).`,
      },
    ];
  }

  const linked = present.filter((anchor) =>
    anchorPointsAtScaffold(projectRoot, anchor.path, anchor.format),
  );
  if (linked.length > 0) return [];

  // Report against the anchor itself, not the scaffold: that is the file the
  // user has to edit, and `mex check` output is read as a worklist.
  const paths = present.map((anchor) => anchor.path);
  const subject =
    paths.length === 1
      ? `${paths[0]} never mentions \`.mex/\``
      : `${describe(paths)} exist, but none of them mentions \`.mex/\``;
  return [
    {
      code: "SCAFFOLD_ORPHANED",
      severity: "error",
      file: paths[0]!,
      line: null,
      message: `${subject}, so the populated scaffold is never loaded. ${FIX_HINT}`,
    },
  ];
}

function describe(paths: readonly string[]): string {
  return `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}`;
}
