/**
 * The two surfaces, and the map between them — written down where a test reads it.
 *
 * §16 names eight agent-facing tools and §15.1 names ten commands, and they are
 * **not the same list**: neither is a subset of the other. `wiki_grounding_status`
 * has no command; `list`, `show`, `backlinks`, `graph`, `rebuild-index` and
 * `migrate` have no tool. A correspondence that lives only in someone's head is
 * exactly the drift §20.7's "exact schema parity" is testing for, so it lives
 * here as data and the parity test walks it.
 *
 * The relation between them is deliberately not one-to-one in the other
 * direction either: `wiki show` calls `wiki_get`, and `wiki backlinks` and
 * `wiki graph` both call `wiki_neighborhood` with different projections. A
 * command is an adapter over a tool, never a second implementation of one.
 */

/** §16's tool names. Narrow, bounded, and the only mutating pair is the last two. */
export const WIKI_TOOLS = [
  "wiki_list",
  "wiki_get",
  "wiki_search",
  "wiki_neighborhood",
  "wiki_validate",
  "wiki_plan_operation",
  "wiki_apply_operation",
  "wiki_grounding_status",
] as const;

export type WikiToolName = (typeof WIKI_TOOLS)[number];

/**
 * §15.1's ten, in the order the spec lists them.
 *
 * A fact about the spec, kept separate from what mex actually implements. The
 * spec's list is a floor rather than a closed surface — P9 added an eleventh
 * command, and P8 adds three more — and collapsing the two lists would either
 * make the spec appear to name commands it does not, or leave the extra
 * commands outside the table every parity test walks. It is the second failure
 * that actually happened: `regenerate-views` shipped outside this table, so the
 * envelope suite that asserts its own count "so a command dropped from the list
 * fails here" was counting ten of eleven.
 */
export const SPEC_15_1_COMMANDS = [
  "list",
  "show",
  "query",
  "related",
  "backlinks",
  "validate",
  "graph",
  "rebuild-index",
  "migrate",
  "apply",
] as const;

/** Every command mex implements under `mex wiki`. */
export const WIKI_COMMANDS = [
  ...SPEC_15_1_COMMANDS,
  "regenerate-views",
  "build",
  "prepare",
  "propose",
] as const;

export type WikiCommandName = (typeof WIKI_COMMANDS)[number];

/**
 * Which service function answers each command.
 *
 * `tool` is null where the command has no §16 counterpart — which is a fact
 * about the spec, not a gap to be filled by inventing a ninth tool. Every entry
 * still names a `service` function, because the rule the parity test enforces
 * is that no command reaches past the service module.
 */
export interface CommandBinding {
  command: WikiCommandName;
  /** The §16 tool this command is an adapter over, or null when there is none. */
  tool: WikiToolName | null;
  /** The exported name in `service/index.ts` the command calls. */
  service: string;
  /** True when the command can write Markdown. */
  mutates: boolean;
}

export const COMMAND_BINDINGS: readonly CommandBinding[] = [
  { command: "list", tool: "wiki_list", service: "wikiList", mutates: false },
  { command: "show", tool: "wiki_get", service: "wikiGet", mutates: false },
  { command: "query", tool: "wiki_search", service: "wikiSearch", mutates: false },
  { command: "related", tool: "wiki_neighborhood", service: "wikiNeighborhood", mutates: false },
  { command: "backlinks", tool: "wiki_neighborhood", service: "wikiBacklinks", mutates: false },
  { command: "validate", tool: "wiki_validate", service: "wikiValidate", mutates: false },
  { command: "graph", tool: null, service: "wikiGraph", mutates: false },
  { command: "rebuild-index", tool: null, service: "wikiRebuildIndex", mutates: false },
  { command: "migrate", tool: null, service: "wikiMigrate", mutates: true },
  { command: "apply", tool: "wiki_apply_operation", service: "wikiApplyOperation", mutates: true },
  { command: "regenerate-views", tool: null, service: "wikiRegenerateViews", mutates: true },
  { command: "build", tool: null, service: "wikiSynthesisBuild", mutates: false },
  { command: "prepare", tool: null, service: "wikiSynthesisPrepare", mutates: false },
  { command: "propose", tool: null, service: "wikiSynthesisPropose", mutates: true },
];

/**
 * Tools with no command of their own, and why each has none.
 *
 * `wiki_grounding_status` is the one §16 names that §15.1 does not — an agent
 * asking "is this knowledge still true of the code" is not a question a person
 * types, and `wiki show` and `wiki list --health` already carry the answer for
 * a human. `wiki_plan_operation` has no command because planning is exactly
 * what `wiki apply --dry-run` does, and a second command for it would be a
 * second spelling of one act.
 *
 * Note that the brief's §3.2b listed `wiki list` and `wiki show` among the
 * commands with no tool. They have one — `wiki_list` and `wiki_get` — and the
 * table above is what a test reads rather than that prose.
 */
export const TOOLS_WITHOUT_COMMANDS: readonly WikiToolName[] = [
  "wiki_grounding_status",
  "wiki_plan_operation",
];

/**
 * Commands answering a question §16 does not pose.
 *
 * Synthesis is not in §16 at all — the spec's tool list predates it — and the
 * right response is to leave `WIKI_TOOLS` alone rather than to invent a ninth
 * entry. §16 is a statement about a published contract; the command surface is
 * a statement about what mex can do, and they are allowed to differ as long as
 * the difference is written down where a test reads it.
 */
export const COMMANDS_WITHOUT_TOOLS: readonly WikiCommandName[] = [
  "graph",
  "rebuild-index",
  "migrate",
  "regenerate-views",
  "build",
  "prepare",
  "propose",
];
