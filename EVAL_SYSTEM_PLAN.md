# MEX Evaluation System Plan

Status: graph-fix milestone implemented on `codex/graph-eval-system`
Immediate priority: make code-graph retrieval evaluation trustworthy before changing retrieval
Broader scope: project memory, lifecycle, and long-term agent evaluation after the graph milestone

Implementation entry points and operating instructions now live in `evaluate/README.md`. The
broader memory milestones below remain deferred; the deterministic graph runner, exact gold
schemas, integrity metrics, branch comparison, and optional cache-aware Claude/Codex pilot are the
implemented scope.

## Why this document exists

MEX currently has several evaluation scripts that were built for different questions at different
times. Some are useful historical smoke tests, but together they do not form a reliable system for
deciding whether `mex graph scope <natural-language query>` improved.

The immediate product problem is graph retrieval:

- natural-language queries often fail to surface the declaration an agent needs;
- agents compensate with repeated variations of `graph scope`;
- repeated retrieval increases token and latency cost;
- the agent eventually falls back to Read/Grep, defeating the purpose of the graph; and
- the existing hard gates mostly exercise exact identifier lookup, so they can stay green while
  this behavior remains broken.

We should therefore build the evaluation foundation needed for the graph fix first. The broader
memory benchmark plan remains valuable, but it is a later milestone and should not block retrieval
work.

## Evaluation principles

1. **A suite must test the claim it is used to support.** Exact-symbol lookup cannot validate
   natural-language retrieval.
2. **Retrieval and answer quality are separate.** Measure whether the graph surfaced the evidence
   before asking whether an agent answered correctly.
3. **Missing results are failures.** A missing rank must never be dropped from an average.
4. **Evidence is exact.** A declaration is identified by symbol, kind, and repository-relative
   path, not by substring occurrence somewhere in serialized JSON.
5. **Compact but irrelevant output is not a win.** Quality gates come before payload savings.
6. **Compare matched work.** Report total retrieval across retries and fallbacks, not only the first
   `scope` response.
7. **Compare paired token deltas, not absolute session totals.** Headless sessions can reuse
   provider-side prompt caches that the harness cannot reliably flush. Absolute token composition
   remains visible, but the comparison signal is the within-task delta between matched arms.
8. **Deterministic checks gate CI; stochastic agent runs support release decisions.**
9. **Every result is reproducible.** Repository, suite, CLI bundle, graph index, prompts, model,
   settings, schedule, and grader identities must be recorded.
10. **No single MEX score.** Retrieval quality, graph integrity, efficiency, memory behavior, and
   agent outcomes are separate dimensions.
11. **External benchmark names are used only for official protocols.** Adapted or shortened suites
    must be labeled as MEX-native adaptations.

## What is wrong with the current graph evaluation

The current deterministic harness is useful as a historical compactness smoke test, but it has the
following decision-critical gaps:

- six hard-gated tasks are exact identifiers such as `runGraphScope` and `runImpact`;
- no natural-language retrieval metric is hard-gated;
- recall accepts broad `qualifiedName` substring matches;
- `where-defined` presence is gated, but rank is not;
- caller/callee counts are reported without correctness labels;
- the grep baseline charges the full contents of three files and is not representative of a
  competent file-search agent;
- CLI failures are frequently ignored by callers;
- stale fixtures are not mechanically rejected;
- the scripted end-to-end driver is transport instrumentation, not an answer-quality evaluation;
- the older real-model runner lacks strong isolation, raw usage accounting, repeats, and a
  no-graph control; and
- the controlled comparison runner has stronger mechanics, but its grading, rank aggregation,
  resume identity, and final win rule are not yet trustworthy.

Existing evaluation output should be treated as unproven unless its full provenance is available.

## Target evaluation system

The eventual organization should have a shared core instead of independent scripts reimplementing
process execution, grading, manifests, and reporting:

```text
evaluate/
  core/                 process runner, scheduling, manifests, hashing, isolation
  schemas/              suite, task, evidence, result, and run-manifest schemas
  graders/              retrieval, relationship, evidence, answer, and code-test graders
  adapters/
    systems/            files-only, released-mex, candidate-mex, memory variants
    benchmarks/         external benchmark adapters
  suites/
    native/
      graph/
      memory/
      lifecycle/
      grounding/
      agent/
    external/
  fixtures/
    repositories/
    histories/
  reports/
  tests/
  legacy/               retained historical benchmarks, not product gates
```

This does not all need to be built before the graph fix. The graph-first milestone below is the
required subset.

---

# Milestone 1: graph-fix evaluation

## 1. Shared run identity and CLI execution

Build one black-box CLI runner used by every graph suite.

It must:

- execute a selected MEX CLI against a selected subject repository;
- capture stdout, stderr, exit code, signal, timeout, and elapsed time;
- reject malformed JSONL and structured CLI error records;
- never grade a failed command as an empty successful result;
- support immutable output directories and safe resume;
- validate resume against the complete run identity; and
- preserve raw command output for debugging.

Each run manifest must record:

- subject repository remote, commit, dirty state, and relevant tree hash;
- suite file hash and fixture revision;
- full MEX runtime bundle hash, including CLI, schema, WASM, and supporting assets;
- graph database hash and build summary;
- Node and dependency/runtime versions;
- exact command, flags, budgets, and environment allowlist;
- prompt hash for agent runs;
- agent/model/judge versions and settings when applicable; and
- schedule, random seed, start/end time, and harness Git identity.

## 2. Strict task and gold-evidence schema

Every retrieval task should specify mechanically verifiable gold evidence:

```json
{
  "id": "graph-budget-enforcement",
  "category": "natural-language-symbol",
  "query": "How does graph retrieval enforce its output token limit?",
  "gold": [
    {
      "symbol": "BudgetLedger",
      "kind": "class",
      "path": "src/graph/agent-protocol.ts"
    }
  ],
  "acceptableAlternates": [],
  "mustNotReturn": []
}
```

Preparation must fail when:

- the task ID is duplicated;
- a required field is missing;
- a gold declaration cannot be found exactly;
- multiple definitions are ambiguous and the fixture does not disambiguate them;
- the fixture is empty;
- a path is outside the subject repository; or
- an expected symbol has been renamed or deleted.

Gold discovery is validation, not gold generation. The author must still decide which declarations
actually answer the task.

## 3. Graph task taxonomy

The graph suite should contain the following categories.

### Exact symbol lookup

Keep a small exact-identifier suite as a basic regression check. It should no longer stand in for
natural-language retrieval.

### Natural-language concept to declaration

Queries should describe behavior without copying the target identifier. Include:

- architecture questions;
- debugging/failure-location questions;
- implementation questions;
- configuration and setup behavior;
- state/budget/lifecycle behavior; and
- user-facing feature language that differs from project vocabulary.

### Paraphrase robustness

Each important task should have several meaning-preserving queries:

- plain English;
- terse agent shorthand;
- vocabulary that does not overlap the symbol name;
- singular/plural and verb/noun variants; and
- camel/snake/kebab concepts where relevant.

Report variance within each paraphrase family. A retrieval fix should not work only for the exact
wording used while developing it.

### Multi-symbol and flow retrieval

Some questions require more than one declaration. Examples include request flow, graph build/read
flow, source expansion, and budget enforcement. Grade all required evidence rather than accepting
one mentioned symbol.

### Relationship queries

Hand-label caller/callee and path expectations for:

- `where-defined`;
- `who-calls`;
- `what-calls`;
- bounded call paths; and
- import/export or framework relationships where supported.

### Impact and blast radius

Use known repository changes with expected direct and transitive dependents. Grade both recall and
false-positive expansion.

### Negative and ambiguity cases

Include:

- nonexistent concepts;
- duplicated symbol names in different files;
- symbols present only in tests;
- incidental mentions in comments/signatures;
- local variables that should not outrank declarations;
- file nodes whose basename matches a concept; and
- queries whose evidence is genuinely insufficient.

The correct behavior may be an explicit low-confidence/no-result response. Hallucinated certainty
must fail.

### Language coverage

Use at least TypeScript/JavaScript, Python, and Rust fixtures because MEX claims support for all
three families. The first retrieval iteration can run primarily on TypeScript, but shared metrics
must not bake in TypeScript-only assumptions.

## 4. Deterministic graph metrics

### Retrieval quality

- exact evidence Recall@1, Recall@5, and Recall@10;
- MRR with misses scored as zero reciprocal rank;
- nDCG for tasks with multiple relevant declarations;
- Precision@k or irrelevant-result rate;
- complete-evidence rate for multi-symbol tasks;
- no-result/abstention accuracy;
- test-file and local-variable pollution rate; and
- paraphrase-family worst-case recall and rank.

### Relationship quality

- caller/callee precision and recall;
- edge/path recall;
- impact-set precision and recall;
- unresolved-target rate; and
- duplicate/dangling edge rate.

### Graph integrity

- extracted declarations versus stored nodes;
- node-ID collision/overwrite count;
- extracted call references versus resolved call edges;
- unresolved reference count and rate;
- declarations with unexpectedly no incoming/outgoing relationships;
- duplicate identities; and
- deterministic rebuild/output hashes.

These integrity metrics are important because retrieval ranking cannot recover declarations or
relationships that never made it into the stored graph.

### Efficiency

- response characters and deterministic approximate tokens;
- fact count;
- p50 and p95 latency;
- truncation and budget compliance;
- relevant facts per 1,000 output tokens; and
- cumulative output across retries.

Quality gates must be evaluated before efficiency. Returning nothing is small but useless.

## 5. Baselines and branch comparison

For the immediate investigation, prepare the same subject/index fixture for:

1. `main`;
2. `feat/code-graph-retrieval`;
3. `fix/graph-symbol-lookup`; and
4. a file-search baseline where relevant.

The comparison should have two levels.

### Retrieval-only comparison

Run every query directly through each graph CLI. This is deterministic, cheap, and diagnostic. It
should be the primary development loop for ranking, candidate generation, graph completeness, and
payload changes.

### Agent outcome comparison

After retrieval-only metrics are trustworthy, run fresh agents under matched conditions:

- files-only control;
- released/current graph;
- candidate graph.

Use the same model, task, tools, budget, isolation, and answer schema. Balance arm order and run at
least three repetitions per task before treating token/cost differences as evidence.

Run two distinct policies rather than conflating them:

1. **Forced-first diagnostic:** the graph arm must begin with `graph scope`. This measures what
   happens after a known graph attempt.
2. **Optional-availability product test:** the agent is told the graph exists but may choose its
   strategy. This measures whether the graph is useful enough to be selected naturally.

Report these separately.

## 6. Agent-level graph metrics

- final task correctness and evidence correctness;
- first-scope target rank and miss rate;
- number of `graph scope` calls;
- semantically distinct scope retries;
- `graph get`, query, and impact calls;
- Read/Grep/Glob and shell-file-search fallback;
- fallback after graph versus files-only behavior;
- raw source/tool-result characters pushed into context;
- paired per-task delta in new tokens, where the adapter can establish the fields as uncached input
  + output + cache creation/write;
- absolute uncached input, output, cache creation/write, cache read, and reported total tokens for
  every session;
- paired cache-read delta and cache-use ratio as secondary diagnostics;
- raw provider/CLI usage fields alongside normalized fields so normalization remains auditable;
- turns, wall time, cost, timeouts, and tool errors; and
- paired per-task differences between arms.

The central outcome is substitution: does graph use replace raw repository exploration, or does it
add retrieval calls before the same exploration occurs?

## 6.1 Headless-session token and cache accounting

Claude and Codex evaluations run through locally authenticated headless CLI sessions rather than
direct model APIs. Their transcript schemas and available usage fields can differ, so each CLI gets
an adapter that preserves the original usage record and maps only semantically established fields
into a common schema:

```json
{
  "usage": {
    "uncachedInput": 0,
    "cacheWrite": 0,
    "cacheRead": 0,
    "output": 0,
    "reportedTotal": 0,
    "reportedCostUsd": null,
    "raw": {}
  }
}
```

Unavailable or ambiguous fields remain `null`; the harness must not infer them from cost or invent
a model-independent conversion.

For a task `t`, repetition `r`, baseline arm `b`, and candidate arm `c`, report paired deltas:

```text
newTokens       = uncachedInput + cacheWrite + output
deltaNewTokens  = newTokens(c, t, r) - newTokens(b, t, r)
deltaCacheRead  = cacheRead(c, t, r) - cacheRead(b, t, r)
deltaTotal      = reportedTotal(c, t, r) - reportedTotal(b, t, r)
deltaCost       = reportedCost(c, t, r) - reportedCost(b, t, r), when available
```

The exact provider-reported categories remain separate in every raw result and aggregate table.
The report must show, per arm and per task:

- absolute median and distribution of every token category;
- total cached tokens loaded;
- total tokens written to cache;
- uncached input and output;
- cache-use ratio using a documented denominator;
- paired deltas with confidence intervals across repetitions; and
- reported cost and cost delta when the CLI exposes them.

Fresh CLI sessions prevent conversational state carryover but do not guarantee a cold
provider-side prompt cache. The evaluation therefore must:

- balance arm order across tasks and repetitions;
- avoid running every baseline before every candidate;
- keep shared prompts and tool descriptions identical where the experiment permits;
- record timestamps, order, model, CLI version, and all cache fields;
- avoid claiming that cache reads simply cancel when the arms take different numbers of turns or
  have different tool/prompt prefixes; and
- use paired new-token/cost deltas as the primary comparison while treating absolute cache traffic
  as an important operational diagnostic.

## 7. Grading rules

- A task requiring multiple declarations passes only when all required declarations are supported.
- Symbol matches use exact normalized identity, kind, and path.
- Evidence paths and lines must exist and contain the cited declaration or supporting source.
- Unsupported claims are recorded and can invalidate answer correctness.
- `complete: false` cannot receive full-credit completeness.
- Negative tasks require an explicit abstention/no-result behavior.
- Initial-scope misses remain in aggregate metrics.
- Invalid sessions are excluded from performance aggregates and make the experiment incomplete.
- Manual blind review, when used, becomes the final correctness label after adjudication rather
  than merely unlocking a report based on the old automatic label.

## 8. Harness self-tests

Before trusting a product result, the harness must test itself against adversarial fixtures:

- CLI nonzero exit cannot pass;
- malformed/empty output cannot pass;
- one of two required symbols cannot receive full credit;
- a symbol substring in an unrelated qualified name cannot match;
- a missing retrieval rank cannot improve the mean;
- empty fixtures and stale gold must fail preparation;
- invalid evidence paths/lines must fail;
- duplicated or partial result files cannot make a run complete;
- resume with a changed model, suite, CLI, prompt, or index must fail;
- a stale manual-review file cannot attach to new runs;
- denied, failed, attempted, and successfully executed tool calls remain distinct; and
- graph-only compactness cannot pass when retrieval recall collapses.

## 9. Initial graph gates

Thresholds should be calibrated after a trusted baseline run, but the initial gate families should
be:

- graph integrity does not regress;
- exact-symbol lookup remains intact;
- natural-language Recall@5 and MRR do not regress against the released baseline;
- no critical-task top-k miss is introduced;
- multi-symbol complete-evidence rate does not regress;
- relationship/impact recall does not regress;
- negative-query false-positive rate stays below its ceiling;
- output respects hard budgets; and
- quality improvements are not purchased with an unacceptable p95 payload or latency regression.

Absolute minimum floors and paired no-regression checks should both be used. A branch should not
pass merely because the task average hides a severe regression on one important task.

## 10. Required repositories and task sets

For the first graph-fix milestone:

1. **MEX native suite:** realistic questions about this repository, including the known failure
   classes already investigated.
2. **Small synthetic fixture repository:** deliberately constructed ambiguity, collisions,
   comments, duplicate names, test pollution, and known call/impact edges.
3. **One external real repository:** enough scale and unfamiliar vocabulary to expose overfitting
   to MEX. Keep its revision pinned and its acquisition separate from normal CI.
4. **Holdout query set:** not used while tuning ranking weights. Run it before accepting a fix.

The first two can gate CI. The external and holdout suites can run in release or explicit research
jobs.

## Graph-fix milestone acceptance criteria

We are ready to change retrieval when:

- task and evidence schemas reject stale or ambiguous gold;
- all harness adversarial tests pass;
- the same pinned graph fixtures can be evaluated across all three branches;
- natural-language Recall@k, MRR, precision, and miss rate are reported correctly;
- graph integrity and relationship coverage are visible;
- output budget and latency metrics are recorded;
- raw outputs and manifests make every number reproducible; and
- a small end-to-end agent pilot can distinguish graph-only success, graph-then-files fallback,
  files-only behavior, command failure, and permission denial.

This is the minimum trustworthy foundation for choosing and refining the graph fix.

---

# Deferred milestones: broader MEX memory evaluation

These are important, but they should begin after the graph retrieval milestone is usable.

## Native MEX memory lifecycle suite

Evaluate:

- current project-state recall;
- decision history and supersession;
- knowledge updates and rollback;
- temporal questions;
- procedural pattern reuse;
- transfer of discovered gotchas;
- invalid-premise awareness;
- selective forgetting and daily-memory cleanup;
- routing precision;
- grounding, rename/move reconciliation, and drift;
- memory growth and write precision; and
- whether memory substitutes for source rediscovery.

A representative scenario spans several fresh sessions: discover a non-obvious rule, record it,
reuse it in a later task, change the repository so part becomes stale, and require a later agent to
distinguish historical rationale from current truth.

## External memory benchmarks

### LongMemEval-S

First external adapter. It has 500 questions covering information extraction, multi-session
reasoning, knowledge updates, temporal reasoning, and abstention.

- Paper/repository: <https://github.com/xiaowu0162/longmemeval>
- Role: recognizable long-term-memory baseline and category diagnostics.

### MemoryAgentBench

Core capability benchmark for accurate retrieval, test-time learning, long-range understanding,
and selective forgetting/conflict resolution.

- Paper: <https://arxiv.org/abs/2507.05257>
- Code: <https://github.com/HUST-AI-HYZ/MemoryAgentBench>
- Role: decisions, updates, reusable learning, and conflict behavior.

### LoCoMo

Widely used conversational-memory benchmark with evidence annotations, temporal/multi-hop
questions, and event summaries.

- Repository: <https://github.com/snap-research/locomo>
- License: CC BY-NC 4.0; download a pinned copy rather than vendoring it.
- Role: external comparability, not primary product fit.

### LongMemEval-V2

The closest conceptual fit to MEX. It tests static state, dynamic state, workflow knowledge,
environment gotchas, and invalid-premise awareness using long agent-trajectory histories.

- Paper: <https://arxiv.org/abs/2605.12493>
- Harness: <https://github.com/xiaowu0162/LongMemEval-V2>
- Role: release/research benchmark for whether memory creates an experienced colleague.

### SWE-Bench-CL

Chronologically ordered software issues for measuring transfer, retention, forgetting, and tool
efficiency in coding agents.

- Paper: <https://arxiv.org/abs/2507.00014>
- Role: experimental end-to-end coding-memory benchmark after native scenarios work.

### BEAM

Large-scale memory stress test with contradiction resolution, updates, event ordering, abstention,
instruction following, and summarization across 128K to 10M-token histories.

- Repository: <https://github.com/mohammadtavakoli78/BEAM>
- Role: later capacity/stress testing, beginning with the 128K tier.

### MemBench

Separates factual from reflective memory and participation from observation.

- Paper/code: <https://aclanthology.org/2025.findings-acl.989/>
- Role: optional diagnostic for MEX state, decisions, patterns, and cross-agent observations.

## External benchmark modes

Each imported benchmark should distinguish:

1. **Oracle/mechanical write:** ingest all history without answer labels to isolate retrieval and
   reading.
2. **Agent write:** a fixed agent incrementally decides what to store, consolidate, supersede, or
   discard, followed by a fresh reader agent.

Official, unmodified protocols produce externally comparable scores. Adapted subsets and
repository-themed transformations are reported under MEX-native names.

## Broader agent-memory arms

- stateless agent;
- raw complete history;
- MEX memory;
- oracle evidence upper bound where appropriate.

Metrics include evidence retrieval, answer correctness, update/conflict accuracy, stale-fact
exposure, abstention, write precision/recall, memory growth, cleanup retention, task success,
tokens, latency, raw exploration, and source-substitution rate.

---

# Recommended implementation order

## Now: required for the graph fix

1. Shared schemas, strict CLI runner, provenance manifest, and immutable results.
2. Exact evidence validation and adversarial harness tests.
3. MEX natural-language, paraphrase, ambiguity, multi-symbol, relationship, impact, and negative
   graph tasks.
4. Retrieval quality, graph integrity, relationship, payload, and latency metrics.
5. Reproducible comparison of `main`, `feat/code-graph-retrieval`, and
   `fix/graph-symbol-lookup`.
6. Small repeated agent pilot with files-only/current/candidate arms.

## Immediately after a retrieval candidate is selected

7. External real-repository and holdout graph suites.
8. Broader repeated agent evaluation and calibrated regression thresholds.

## Later: broader MEX evaluation

9. Native memory lifecycle and substitution suite.
10. LongMemEval-S and MemoryAgentBench adapters.
11. LongMemEval-V2 and SWE-Bench-CL release/research runs.
12. LoCoMo, BEAM, and MemBench comparability or scale suites.

The graph-first work should produce reusable core infrastructure, so the later memory system can be
added as suites and adapters rather than another disconnected collection of scripts.
