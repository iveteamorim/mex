/**
 * The agent playbook — the one thing `mex wiki build` produces.
 *
 * Ported closely from the reference's build prompt, because its boundaries
 * section, its "prefer a few excellent, well-grounded units over many weak
 * ones", and its "prefer skip over a weak edge" all earn their place. What
 * changed is what the agent is told to *call*: the reference addressed nine MCP
 * tools, and mex has no MCP server — the agent channel here is JSONL over CLI
 * commands, which is what `mex graph scope` and every P9 read command already
 * speak. So every tool name became a command, and the step that asked the agent
 * to confirm its MCP tools were connected is gone: there is nothing to confirm,
 * and a step that always succeeds teaches an agent to skip steps.
 *
 * mex renders this and hands it over. It runs no model.
 */

/** What the playbook needs to know about the run it is describing. */
export interface PlaybookOptions {
  /** The repository the code graph was built from. */
  repoRoot: string;
  /** The scaffold the knowledge will be written into. */
  scaffoldRoot: string;
  /** Cluster names mex found, for the agent's checklist. */
  clusters: readonly string[];
  /** Restrict the run to one cluster. */
  cluster?: string;
}

const BOUNDARIES = `
IMPORTANT BOUNDARIES
- mex makes no model calls and holds no API keys. YOU run the model. mex selects scope,
  renders prompts, validates what you return, and turns valid candidates into operation
  plans that a human applies.
- Never invent knowledge the returned context does not support. Copy grounding node ids
  exactly as given; mex re-derives every one of them from the live code graph and drops
  any unit whose nodes it cannot produce.
- Prefer a few excellent, well-grounded units over many weak ones. An empty stage is a
  valid outcome and is better than a padded one.
- Prefer sparse, sharp relationships over noisy ones. Prefer skipping a pair to asserting
  a weak edge, and do not overuse related_to.
- Nothing you produce is written until a human reviews it. \`mex wiki propose\` plans by
  default and writes only when it is given --apply.
`.trim();

function clusterChecklist(clusters: readonly string[], only: string | undefined): string {
  if (only !== undefined) {
    return `SCOPE: build ONLY the cluster "${only}". Skip every other cluster.`;
  }
  if (clusters.length === 0) {
    return "mex found no clusters in this repository. Stop and report that: there is nothing to synthesize.";
  }
  return `mex deterministically found ${clusters.length} cluster(s):\n${clusters.map((name) => `  - ${name}`).join("\n")}`;
}

/** Render the playbook. Deterministic: same inputs, same bytes. */
export function renderPlaybook(options: PlaybookOptions): string {
  return `You are building a knowledge wiki for an already-indexed repository, using mex's CLI.

REPO:      ${options.repoRoot}
SCAFFOLD:  ${options.scaffoldRoot}

The code graph is already built. Your job is to propose knowledge entities and the typed
relationships between them, through the commands below. Do not edit files directly and do
not re-index.

${BOUNDARIES}

${clusterChecklist(options.clusters, options.cluster)}

Every command below accepts --json and returns {schemaVersion, ok, data, diagnostics}.
Read \`data\`; treat a non-empty \`diagnostics\` at error severity as a stop.

============================================================
A. PER-CLUSTER SYNTHESIS
============================================================
For each cluster, one at a time:
  1. Run: mex wiki prepare --cluster <name> --stage architecture_component --json
     It returns the cluster context and the exact system and user prompts to send.
  2. Send those two strings to your own model. Return JSON of the shape
     { "stage": "architecture_component", "cluster": "<name>", "units": [ ... ] },
     matching the schema the prompt states. Write it to a file.
  3. Run: mex wiki propose <file> --json
     mex validates every unit, re-derives its grounding from the live graph, and prints
     the operation plans. Add --apply once you or the user are satisfied.
  4. Repeat 1-3 for --stage pattern, then for --stage convention.
  5. A stage that yields zero valid units is fine. Continue to the next stage or cluster;
     never stop the whole build because one cluster was quiet.

============================================================
B. GLOBAL CROSS-CUTTING PASS
============================================================
Only after stage A's operations have been applied — this pass consolidates entities that
exist, so nothing applied means nothing to consolidate.
  1. Run: mex wiki prepare --stage global --json
     It returns deterministically grouped near-duplicate entities and the prompt.
  2. Judge each group with your model: merge, promote_one, keep_separate, or drop_weak.
     When unsure, keep_separate. Preserve the union of genuinely relevant grounding.
  3. Write { "stage": "global", "actions": [ ... ] } to a file and run
     mex wiki propose <file> --json. Review the plan before adding --apply.

============================================================
C. RELATIONSHIP FORMATION
============================================================
Only after B has been applied.
  1. Run: mex wiki prepare --stage relationships --json
     It returns high-precision candidate pairs, each with structural evidence and an
     allowedTypes menu, plus the prompt.
  2. For each candidate choose the MOST SPECIFIC valid type and the correct direction, or
     skip. You may only use a type from that candidate's allowedTypes. Honour the
     thresholds: at least 0.80 for every type, at least 0.90 for related_to.
  3. Write { "stage": "relationships", "judgments": [ ... ] } to a file and run
     mex wiki propose <file> --json. Review before --apply.

============================================================
FINAL REPORT
============================================================
Report, concisely:
  - clusters processed, and any skipped with the reason
  - units proposed and units accepted, by stage and by type
  - units mex refused, and the reason it gave for each
  - global-pass actions taken
  - relationships created, by type, and how many candidates you skipped
  - anything that failed and could not be resolved

Begin with A. Do not ask for confirmation between clusters or stages; proceed on your own
and stop only on an error you cannot resolve.`;
}
