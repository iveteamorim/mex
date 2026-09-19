#!/usr/bin/env node
/**
 * Generate the tier-1 migration corpus.
 *
 * Plan section 6a: the corpus is **synthesized**, never vendored, and is
 * generated to match a committed shape census. Every word of prose here is
 * invented — it describes a fictional "Harbour" ticketing service — and the
 * only thing taken from any real scaffold is a count.
 *
 * The shape is not invented. `test/fixtures/wiki-migration/census.json` is a
 * census of a real filled pre-wiki scaffold, and the file table below exists to
 * hit it: 13 context files against 8 pattern files, a 14-edge router against a
 * mode of 3, sixteen depth-3 headings, and every one of 77 edges carrying a
 * condition. Those are the structures a human produced over months that neither
 * a spec nor a builder would think to invent.
 *
 * **Tier 1 has no groundings and no anchors**, because a real pre-wiki scaffold
 * has none: `mex ground` is what writes them, and a scaffold that has not been
 * grounded yet carries nothing. Grounding migration is tier 2's, which runs the
 * real grounding path against a temporary graph so the node ids and `mh:64:`
 * fingerprints are real rather than hand-typed, and tier 3's, which carries the
 * multi-entity ambiguity case.
 *
 * Deterministic: no clock, no randomness, no absolute paths in output. Running
 * it twice produces byte-identical files, which is what lets a test assert the
 * committed fixture is exactly the generator's output.
 *
 *   node scripts/generate-wiki-migration-corpus.mjs [target-dir]
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = resolve(HERE, "..", "test", "fixtures", "wiki-migration", "tier1");

/** A fixed date. A clock in a generator makes the fixture change on its own. */
const DATE = "2026-03-14";

/** Invented prose, rotated deterministically. Three lines each. */
const PARAGRAPHS = [
  [
    "Inbound mail is written to the raw store before anything parses it, so a",
    "parser that rejects a message never loses it. Everything that can fail",
    "interestingly happens downstream, where a retry is cheap and visible.",
  ],
  [
    "A stored message is matched to a thread by its reply headers, falling back",
    "to a subject-and-participant match when those headers are missing. The",
    "fallback is generous on purpose, because a missed join is the worse error.",
  ],
  [
    "Each ticket is assigned to exactly one queue. The rules run in declaration",
    "order and the first match wins, with an explicit catch-all last, so there",
    "is always an owner and an operator can predict the outcome.",
  ],
  [
    "Outbound replies go through a single sender that owns rate limiting and",
    "bounce handling. Nothing else talks to the mail provider, so changing",
    "provider touches one module and the credentials it reads.",
  ],
  [
    "Modules are named for the noun they own rather than the layer they sit in.",
    "A module called ticket owns tickets, and there is no manager, service or",
    "helper variant of it hiding the same behaviour under a second name.",
  ],
  [
    "An error carries the identifier of the thing that failed and nothing else.",
    "No stack strings in messages and no chains rewrapped at every layer, so a",
    "reader can tell what broke without reconstructing how it was caught.",
  ],
  [
    "Configuration is read from the environment with no defaults for anything",
    "that addresses a real system. A missing variable fails at startup naming",
    "itself, rather than defaulting to something that silently half-works.",
  ],
  [
    "The work queue is a table in the same database as everything else. That",
    "costs throughput nobody is currently asking for and buys one thing to",
    "back up, one thing to restore, and one place a stuck job can be found.",
  ],
  [
    "Operators reassign rather than share. Cross-team tickets move between",
    "queues, which means reassignment has to be one action and has to leave a",
    "trail that answers who moved it and when.",
  ],
  [
    "Every test names the behaviour it protects in its title. A test that",
    "cannot fail is deleted rather than kept for coverage, and one that needs",
    "two fixtures to explain itself is usually testing two things.",
  ],
  [
    "Retention is the open question. The raw store keeps every message and has",
    "no expiry, so the volume fills on a schedule nobody has written down and",
    "ingest starts refusing when it does.",
  ],
  [
    "Rules are data and are reloaded without a restart, which took the deploy",
    "out of the loop and put validation on the critical path. A malformed rule",
    "set now reaches production with only the loader standing in front of it.",
  ],
  [
    "The bootstrap target is safe to re-run. It drops and recreates the local",
    "database only, applies every migration in order, and loads a fixture set",
    "with three queues and a handful of threads.",
  ],
  [
    "A health check that sends a message and reads it back is the only thing",
    "that would catch a stalled sender, because tickets continue to look",
    "answered from the operator's side while replies pile up unsent.",
  ],
  [
    "Schema changes go out ahead of the code that needs them and stay backward",
    "compatible for one release. Two deploys is slower and it is what lets a",
    "rollback happen without a second migration under pressure.",
  ],
  [
    "Search is a query against Postgres rather than a cluster of its own. It is",
    "slower than it could be at a volume the service does not have, and it is",
    "one fewer system to operate, secure and keep in sync.",
  ],
];

let rotation = 0;
function prose(count) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(...PARAGRAPHS[rotation % PARAGRAPHS.length], "");
    rotation += 1;
  }
  return lines;
}

/** Ten decision entries. Two carry no `**Decision:**` marker, deliberately. */
const DECISIONS = [
  ["Store raw mail before parsing it", "2026-01-12", "Active", true],
  ["One queue owns a ticket", "2026-01-30", "Active", true],
  ["Queue rules are data, not code", "2026-02-09", "Active", true],
  ["Keep the work queue in Postgres", "2026-02-16", "Active", true],
  ["Two-phase schema changes", "2026-02-23", "Active", true],
  ["Search without a search cluster", "2026-03-02", "Active", true],
  ["A single outbound sender", "2026-03-06", "Active", true],
  ["Reassign rather than share ownership", "2026-03-09", "Active", true],
  ["Raw store retention", "2026-03-11", "Open", false],
  ["Multi-region ingest", "2026-03-13", "Open", false],
];

function decisionEntry([title, date, status, decided], paras) {
  const lines = [`### ${title}`, ""];
  if (decided) {
    lines.push(
      `**Date:** ${date}`,
      `**Status:** ${status}`,
      "**Decision:** stated in one sentence, so a reader can stop here.",
      "**Reasoning:** the constraint that made the alternative worse.",
      "",
    );
  } else {
    lines.push(
      `**Date:** ${date}`,
      `**Status:** ${status}`,
      "Nothing has been decided here yet. The section exists so the question is",
      "written down rather than rediscovered, and it names what would settle it.",
      "",
    );
  }
  lines.push(...prose(paras));
  return lines;
}

const front = ({ name, description, triggers, edges }) => {
  const lines = ["---", `name: ${name}`, `description: "${description}"`];
  if (triggers !== undefined) {
    lines.push("triggers:");
    for (const trigger of triggers) lines.push(`  - "${trigger}"`);
  }
  if (edges !== undefined) {
    lines.push("edges:");
    for (const edge of edges) {
      lines.push(`  - target: ${edge.target}`);
      lines.push(`    condition: ${edge.condition}`);
    }
  }
  lines.push(`last_updated: ${DATE}`, "---", "");
  return lines.join("\n");
};

/** Trigger phrases, invented, sliced to the count a file needs. */
const TRIGGER_POOL = [
  "architecture", "request flow", "boundaries", "queues", "routing", "threading",
  "delivery", "ingest", "naming", "style", "error handling", "conventions",
  "why do we", "decision", "alternative", "setup", "environment", "first run",
  "risk", "failure mode", "capacity", "retention", "stack", "dependency",
  "version", "testing", "fixtures", "operations", "runbook", "on call",
];

/** Edge targets, invented, drawn from the corpus's own file list. */
const EDGE_POOL = [
  "context/architecture.md", "context/conventions.md", "context/setup.md",
  "context/decisions.md", "context/stack.md", "context/risks.md",
  "context/testing.md", "context/operations.md", "context/glossary.md",
  "context/data-model.md", "context/integrations.md", "context/security.md",
  "context/performance.md", "patterns/INDEX.md",
];

const CONDITIONS = [
  "when the boundary between two services matters",
  "when writing or reviewing a change",
  "when a design choice needs its reasoning",
  "when preparing a development machine",
  "when a library version is in question",
  "when a failure mode is being weighed",
  "when adding or changing a test",
  "when running the service in anger",
  "when a term is used without definition",
  "when the shape of stored data matters",
  "when a third party is involved",
  "when the change touches credentials",
  "when latency or volume is the concern",
  "at the start of a task, to find a matching pattern",
];

/**
 * Edge targets for one file.
 *
 * The pool is ordered the way a real scaffold's edges point: at the few files
 * everything refers back to first, then outward. That ordering is not
 * constrained by the census — which counts edges and conditions, never
 * targets — and it matters, because an edge converts only when its target
 * resolves to exactly one entity. A pool that happened to point every edge at a
 * file the classifier abstains on would leave the whole conversion path
 * unexercised while every count still matched.
 *
 * A file never edges to itself.
 */
function edgesFor(count, selfPath) {
  const edges = [];
  let slot = 0;
  while (edges.length < count && slot < EDGE_POOL.length) {
    if (EDGE_POOL[slot] !== selfPath) edges.push({ target: EDGE_POOL[slot], condition: CONDITIONS[slot] });
    slot += 1;
  }
  return edges;
}

function triggersFor(count, offset) {
  const triggers = [];
  for (let index = 0; index < count; index += 1) {
    triggers.push(TRIGGER_POOL[(offset + index) % TRIGGER_POOL.length]);
  }
  return triggers;
}

/**
 * The file table.
 *
 * `h2` names the depth-2 sections; `nested` gives a section its depth-3
 * children. `paras` is paragraphs per section, which is what lands each file in
 * the prose-length bucket the census records.
 */
const PLAN = [
  { path: "ROUTER.md", title: "Session Bootstrap", name: "router", description: "Session bootstrap and navigation hub for the Harbour ticketing service.", edges: 14, triggers: 12, h2: ["Reading order", "Routing table", "Working agreement"], paras: 2 },
  { path: "AGENTS.md", title: "Harbour", h2: ["Non-negotiables", "Commands", "After every task"], paras: 2 },
  { path: "SETUP.md", title: "First run", h2: ["Install", "Verify", "Where to go next"], paras: 2 },
  { path: "SYNC.md", title: "Keeping the scaffold honest", h2: ["What sync checks", "When it disagrees", "What it will not do"], paras: 2 },

  { path: "context/architecture.md", title: "Architecture", name: "architecture", description: "How Harbour's pieces connect and how a message becomes a ticket.", edges: 5, triggers: 12, h2: ["Ingest", "Threading", "Routing", "Delivery"], nested: { Ingest: ["Acceptance", "The raw store", "Enqueueing"], Threading: ["Header matching", "The fallback", "Splitting"] }, paras: 1 },
  { path: "context/conventions.md", title: "Conventions", name: "conventions", description: "How code is written in Harbour: naming, structure, errors and tests.", edges: 4, triggers: 10, h2: ["Naming", "Errors", "Structure", "Tests", "Logging", "Configuration", "Migrations", "Dependencies", "Review"], paras: 5 },
  { path: "context/decisions.md", title: "Decisions", name: "decisions", description: "The choices Harbour has made and the reasoning behind each one.", edges: 5, triggers: 11, decisionLog: true, paras: 2 },
  { path: "context/setup.md", title: "Setup", name: "setup", description: "Preparing a machine to run and test Harbour locally.", edges: 4, triggers: 9, h2: ["Prerequisites", "First-time setup", "Environment variables", "Running the workers", "Loading fixtures", "Common issues"], paras: 2 },
  { path: "context/risks.md", title: "Risks", name: "risks", description: "Known risks in Harbour, what triggers each one, and what would reduce it.", edges: 4, triggers: 9, h2: ["Raw store growth", "Single outbound sender", "Rule reload without validation", "Queue starvation", "Provider lock-in", "Operator error"], paras: 2 },
  { path: "context/stack.md", title: "Stack", name: "stack", description: "The technologies Harbour runs on and the constraints on changing them.", edges: 3, triggers: 9, h2: ["Core", "Deliberately absent", "Version constraints", "Upgrades", "Local substitutes"], paras: 3 },
  { path: "context/testing.md", title: "Testing", name: "testing", description: "How Harbour is tested and what each layer of the suite is for.", edges: 3, triggers: 8, h2: ["Layers", "Fixtures", "The mail catcher", "Flakiness", "What is not tested"], paras: 3 },
  { path: "context/operations.md", title: "Operations", name: "operations", description: "Running Harbour: deploys, alerts, and what to do when something stops.", edges: 3, triggers: 8, h2: ["Deploys", "Alerts", "Backups", "Rollback", "On call"], paras: 3 },
  { path: "context/glossary.md", title: "Glossary", name: "glossary", description: "Terms used throughout Harbour, defined once so they are not redefined.", edges: 3, h2: ["Ticket", "Thread", "Queue", "Raw message"], paras: 1 },
  { path: "context/data-model.md", title: "Data model", name: "data-model", description: "The tables Harbour stores and how they relate to one another.", edges: 3, triggers: 7, h2: ["Tickets", "Messages", "Queues", "Audit"], paras: 1 },
  { path: "context/integrations.md", title: "Integrations", name: "integrations", description: "The third parties Harbour talks to and what each one is trusted for.", edges: 3, triggers: 6, h2: ["Mail provider", "Identity", "Billing", "Webhooks"], paras: 1 },
  { path: "context/security.md", title: "Security", name: "security", description: "How Harbour handles credentials, access and customer data.", edges: 3, triggers: 6, h2: ["Credentials", "Access", "Customer data", "Audit trail"], paras: 1 },
  { path: "context/performance.md", title: "Performance", name: "performance", description: "Where Harbour spends its time and which numbers are worth watching.", edges: 3, triggers: 6, h2: ["Ingest latency", "Queue depth", "Query shapes", "What to watch"], paras: 1 },

  { path: "patterns/INDEX.md", title: "Pattern Index", name: "pattern-index", description: "Lookup table for Harbour's pattern files.", h2: ["Patterns", "Adding a row", "Removing a row", "Keeping it honest"], paras: 2 },
  { path: "patterns/README.md", title: "Patterns", introParas: 4, paras: 3 },
];

const PATTERN_SECTIONS = ["Context", "Steps", "Gotchas", "Verify", "Debug", "Update Scaffold"];

const PATTERNS = [
  ["add-queue-rule", "Add or reorder a routing rule", 3, 6, 1],
  ["replay-raw-message", "Replay a stored message that never became a ticket", 3, 6, 3],
  ["split-thread", "Split a thread that was joined wrongly", 3, 6, 1],
  ["merge-tickets", "Merge two tickets that are the same conversation", 3, 5, 1],
  ["add-migration", "Add and apply a database migration", 3, 5, 1],
  ["trace-a-reply", "Trace a reply that never reached the customer", 2, 5, 1],
];

for (const [slug, title, edgeCount, triggerCount, paras] of PATTERNS) {
  PLAN.push({
    path: `patterns/${slug}.md`,
    title,
    name: slug,
    description: `${title}. Follow this rather than working it out again.`,
    edges: edgeCount,
    triggers: triggerCount,
    h2: PATTERN_SECTIONS,
    paras,
  });
}

function render(spec, index) {
  const lines = [];
  const head =
    spec.name === undefined
      ? ""
      : front({
          name: spec.name,
          description: spec.description,
          ...(spec.triggers === undefined ? {} : { triggers: triggersFor(spec.triggers, index * 3) }),
          ...(spec.edges === undefined ? {} : { edges: edgesFor(spec.edges, spec.path) }),
        });

  lines.push(`# ${spec.title}`, "");
  lines.push(...prose(spec.introParas ?? 1));

  if (spec.decisionLog === true) {
    lines.push("## Decision Log", "");
    lines.push(...prose(spec.paras));
    for (const entry of DECISIONS.slice(0, 8)) lines.push(...decisionEntry(entry, spec.paras));
    lines.push("## Open questions", "");
    lines.push(...prose(spec.paras));
    for (const entry of DECISIONS.slice(8)) lines.push(...decisionEntry(entry, spec.paras));
  } else {
    for (const heading of spec.h2 ?? []) {
      lines.push(`## ${heading}`, "");
      lines.push(...prose(spec.paras));
      for (const child of spec.nested?.[heading] ?? []) {
        lines.push(`### ${child}`, "");
        lines.push(...prose(spec.paras));
      }
    }
  }

  // One trailing blank line collapses to the file's final terminator.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${head}${lines.join("\n")}\n`;
}

const files = {};
PLAN.forEach((spec, index) => {
  files[spec.path] = render(spec, index);
});

const target = resolve(process.argv[2] ?? DEFAULT_TARGET);
rmSync(target, { recursive: true, force: true });
for (const [path, text] of Object.entries(files)) {
  const absolute = join(target, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, "utf-8");
}
console.log(`${Object.keys(files).length} files written to ${target}`);
