# Code graph resource investigation

Investigation date: 2026-09-09 (Asia/Kolkata). Source: `codex/0.8.1` at `35bfc075888706d6b105b39b0d711ff7a588b551`. This is the historical investigation before implementation; the experiments below did not change production code. Implementation follows on `codex/0.8.1-graph-performance`, targeting the release branch. Telemetry remains separate.

## Finding and recommendation

A full refresh of MEX's own repository spent **238.4 of 312.9 seconds saving fingerprints**. Computing those fingerprints took only **1.4 seconds**. The dominant delay was SQLite's native savepoint/journal bookkeeping, not parsing or hashing.

An isolated experiment that reused the graph publisher's existing outer transaction reduced fingerprint persistence to **4.35 seconds** and the full engine refresh to **99.45 seconds**. All 12 normalized data tables and four representative ranked full-text queries matched. Independent smaller experiments reproduced poor scaling and verified rollback on injected failures. These are local diagnostic measurements, not promised timings for every repository.

Prioritize that small storage correction, then bounded statement ownership and the remaining compiler working set. Keep heavy graph maintenance off the Hub HTTP thread through a separately reviewed candidate-builder process. True incremental indexing and a language rewrite are larger projects; the evidence does not require them to fix the measured bottleneck.

## What was measured

The Hub was stopped before investigation. Its existing index remained untouched. A closed, quiescent copy of `.mex/graph.db` seeded each independent experiment under the OS temporary directory. The engine read the real repository and installed dependencies, staging its output into those temporary databases. No live Hub or network telemetry was used in the profiling runs.

Environment: macOS 26.0.1 arm64; Node 22.17.1; V8 12.4.254.21-node.27; bundled SQLite 3.50.0; TypeScript 5.9.3; web-tree-sitter 0.25.10. The input was **708 source files**, with 10,591,819 bytes in the compiler input batch. Extraction produced **33,121 nodes, 87,048 edges, 23,376 fingerprints and 748,032 LSH buckets**; all 708 files parsed successfully. The seed index held 681 files and 32,143 nodes.

The profiler bundled the current internal engine with stage markers, counted native statement preparations, captured V8 CPU samples every 2 ms, and independently sampled RSS/CPU once per second. An external supervisor watched for 600 seconds or 4,608 MiB sampled RSS. This is a diagnostic guard, not a strict OS memory quota. The original supervisor checked its deadline after successful `ps` calls; monitoring failure could therefore weaken that guard. Completed runs had successful samples and stayed below it. The final heap-budget experiment used an improved supervisor that enforced the deadline independently and escalated termination after two seconds.

These measurements cover `engine.sync`, including its database transaction, but exclude the outer maintenance service's candidate-copy/validation/atomic-file-publication overhead and Hub/browser costs. Instrumentation has overhead. Runs were sequential; a parity check briefly overlapped the start of the first repeated-cycle series, so that series is retained-memory evidence rather than a calibrated timing comparison. macOS caching, compression, scheduling and I/O introduce variance. Release performance claims need unprofiled repetitions on the pinned runner.

### Original and transaction experiment

| Engine stage | Current code | Outer transaction experiment |
|---|---:|---:|
| Compiler extraction | 46.15 s | 48.12 s |
| Fingerprint computation | 1.40 s | 1.39 s |
| Fingerprint persistence | 238.39 s | 4.35 s |
| Full engine refresh | 312.94 s | 99.45 s |
| Subsequent unchanged refresh | 0.311 s | 0.394 s |
| Lifetime peak RSS | 2,010 MiB | 1,786 MiB |
| Heap after close and diagnostic GC | 51.7 MiB | 49.7 MiB |

The fingerprint write was about **55 times faster**, and full refresh time fell about **68%**. Compiler work did not improve. Both runs made **400,510 native statement preparations**, including the subsequent no-op check. Do not attribute the entire modest RSS difference to the transaction change: compiler GC and host behavior varied.

The baseline native sample also recorded **3.4 GB peak macOS physical footprint**. The earlier Hub observation recorded 3.5 GB peak physical footprint. Physical footprint, RSS and live V8 heap are different metrics; those numbers must not be mixed into a claimed memory reduction. Node documents the separate memory categories and lifetime peak semantics in its [process API](https://nodejs.org/download/release/v22.17.1/docs/api/process.html#processmemoryusage).

## Why SQLite becomes slow

The graph publication transaction already owns rollback for all derived rows. Inside it, [`FingerprintStore.upsertMany`](../../src/graph/fingerprint-store.ts) creates another savepoint covering the entire fingerprint corpus. [`configureConnection`](../../src/graph/db/database.ts) forces `temp_store=MEMORY`.

The native sample during fingerprint insertion spent 1,233 of 1,513 main-thread samples in `memjrnlTruncate`, beneath `sqlite3PagerSavepoint`, statement completion and `sqlite3_step`. This is approximately 81.5% of that sample window, not of the entire refresh. The whole-run V8 profile attributed approximately 242 seconds to the SQLite `run` wrapper.

The exact [SQLite 3.50.0 memory-journal implementation](https://github.com/sqlite/sqlite/blob/version-3.50.0/src/memjournal.c#L260) stores journal data in linked chunks. Truncating to a nonzero retained position walks from the head to that position. The [pager implementation](https://github.com/sqlite/sqlite/blob/version-3.50.0/src/pager.c) retains pages required by the outer user savepoint while releasing internal statement savepoints. MEX's temporary-store setting forces this subjournal to stay in RAM, disabling its usual spill threshold. Repeated writes can therefore repeatedly traverse a growing retained prefix. This source-backed mechanism matches both the sample and the scaling experiment. SQLite explains why [statement journals](https://www.sqlite.org/tempfiles.html#statement_journal_files) are needed for partial-statement rollback.

The temporary full-repository variant removed only the four inner savepoint/rollback statements. Every insertion, constraint, graph transaction and graph output rule remained the same. That is an experiment, not the proposed public API: **generic fingerprint writes must keep independent batch atomicity**, including when a caller catches an error and continues its transaction. A production bulk-write entry point should explicitly belong to the graph publisher's owning transaction, with failures escaping to its rollback. Do not infer that ownership just from “a transaction exists.”

### Independent SQLite scaling and failure checks

Disk-backed WAL databases using MEX's fingerprint schema were seeded with prior data, then replaced using four transaction strategies. Entries had 32 buckets each. Values below are single-run fingerprint write times.

| Fingerprints | Current nested savepoint, RAM journal | Outer transaction only | 250-entry savepoints | Nested savepoint, disk journal |
|---|---:|---:|---:|---:|
| 1,000 | 56 ms | 33 ms | 39 ms | 174 ms |
| 2,000 | 268 ms | 64 ms | 85 ms | 270 ms |
| 4,000 | 1,679 ms | 141 ms | 210 ms | 564 ms |

Four times the input produced roughly 30 times the current write time, versus 4.3 times with outer ownership. At 4,000 entries, measured process peak before final validation was 222 MiB versus 158 MiB; those peaks include identical seeding and checksum warmup, not just the journal.

All variants produced identical ordered fingerprint/bucket hashes and zero foreign-key violations. All four injected mid-write foreign-key failures restored the exact pre-write hash through the owning outer rollback. Smaller savepoints still rely on outer rollback for whole-batch atomicity. Disk temporary storage preserves the nested transaction structure and helps larger cases, but has an I/O cost and was slower than explicit outer ownership. It was not tested on the full repository.

An exact-schema `EXPLAIN` also ruled out a proposed missing-index explanation for the parent fingerprint UPSERT: it does not scan `lsh_buckets`, and adding a `ref` index did not change that statement's plan. Bulk deletion of fingerprint/LSH rows before graph node deletion is already implemented. Neither should be advertised as a new fix.

The relevant memory-journal and pager functions remain unchanged in the inspected upstream source. A newer SQLite version is worth compatibility testing, but upgrading alone is not an evidenced cure for this operation pattern.

## Memory: what is established, and what is still uncertain

A large transient working set is established. A persistent multi-gigabyte JavaScript leak is not established by these runs.

After the baseline refresh, live JS heap fell from about 2,308 MiB to 52 MiB after engine close and three diagnostic GCs separated by event-loop turns. A repeated experiment ran three equivalent full-corpus refreshes in the **same process**, reopening and closing the engine each time. It used the transaction improvement, with a nonempty source hint to force full staging while leaving source bytes unchanged. This is repeated-work retention evidence; it is not an actual-edit/invalidation test.

| Cycle | Full engine refresh | Post-GC heap | Post-GC RSS |
|---|---:|---:|---:|
| 1 | 90.24 s | 51.7 MiB | 1,238 MiB |
| 2 | 79.19 s | 51.6 MiB | 1,011 MiB |
| 3 | 82.68 s | 52.5 MiB | 1,473 MiB |

The live heap returns to essentially the same level, while RSS remains high and variable. Three cycles cannot exclude a slow leak, native leak or repository-specific problem. They support collectible compiler/staging allocations rather than a retained multi-gigabyte JS graph. No native allocator dominator analysis or long soak was performed. Forced GC is solely a diagnostic tool, not the recommended production solution.

A separate bounded statement-reuse experiment cached at most 256 native statements per database and cleared the cache on close. The first forced refresh made **42 preparations instead of 399,092**; three refreshes used 124 in total instead of 1,103,322. Their durations were 75.62, 67.49 and 80.05 seconds. Normalized graph data and the four FTS query sets matched the baseline after all three cycles. This supports reusable bulk statements as a compute improvement, although these are single series with host/GC variance.

It did **not establish a memory improvement**: post-GC heap was 51.7, 51.6 and 52.4 MiB, post-GC RSS was 1,862, 1,710 and 1,212 MiB, and lifetime peak RSS reached 2,522 MiB. SQL allocation churn is real, but it does not explain away the compiler working set. The experimental generic cache is not a ready implementation: production reuse must account for concurrent iterators, statement settings, transaction boundaries and database lifetime.

Finally, the optimized temporary engine was run with `--max-old-space-size=1024`. It **aborted from V8 heap exhaustion after about 48 seconds**, during root-project compiler extraction, before fingerprint persistence or graph publication. The macOS crash record for the exact child PID contained `node::OOMErrorHandler` and `V8::FatalProcessOutOfMemory`. Last sampled peak RSS was about 1,269 MiB; this was a failed experiment, not a successful 1 GiB operating target.

The failed experiment database remained byte-identical to its seed (SHA-256 `0b6dd1f8e161f19e4a15111f125a83d2245f01c01e791f21e38f2c8a4a61af41`) with an empty WAL. A 10.6 MB source spool survived the fatal exit because `finally` cannot run after process abort; that exact experiment spool was removed. This adds a concrete process-isolation requirement: the supervisor must own or know the temporary workspace and clean it safely on crash/OOM. Merely setting a low heap cap or wrapping the current call in `try/catch` is not a solution.

The source audit found concrete amplification that remains relevant:

- Programs are processed sequentially, but each can load many dependency files. Declared project roots/loaded SourceFiles/owned graph files were 7/292/7, 95/929/96, 6/289/6 and 442/1,216/442. An inferred program processed the remaining compiler candidates. Dependencies outside the source corpus do not count against the compiler source-byte ledger. The 128 MiB compiler-source cap is not a RAM cap.
- Compiler programs and tree-sitter trees already have release boundaries. Captured compiler data is plain records; per-file WASM trees are deleted in `finally`. No obvious unbounded global AST owner was found. Recommending those existing releases again would not address the current cost.
- Publication eagerly loads all old nodes and fingerprints. Alias generation then reloads all fresh nodes and creates lookup maps while staged and old data are still live. Continuity logic usually accepts a surviving ID before it needs fingerprint matching; demand-driven old fingerprint reads and reuse of staged nodes are promising follow-ups that must preserve ambiguity and rename rules.
- Resolved compiler references are omitted from SQLite since PR #174, but an extra corresponding record is still retained in the staged heap. It may be removable after necessary resolution/validation, with fallback import hydration preserved.
- Rich strings have measurable size: signatures totaled 3.59 million characters, with one 272,441-character signature; edge evidence totaled 27.13 million characters, plus 7.22 million metadata characters. These are potential allocation and serialization costs. Truncating canonical signatures without a compatibility design can change identities or evidence.

Compiler extraction remains the next major compute cost. Inclusive CPU-profile ancestry attributed approximately 23.5 seconds to call-reference capture, including 15.0 seconds rendering resolved call signatures and 6.5 seconds resolving signatures. These sampled inclusive values overlap and exclude GC attribution; do not sum them with wall-clock stage totals. A suspected repeated callback-body scan used only about 0.59 seconds. It is redundant work, but not a priority for this repository.

## Why the Hub can look stuck

[`src/hub/jobs/index.ts`](../../src/hub/jobs/index.ts) schedules the executor with a Promise microtask; [`graph.ts`](../../src/hub/jobs/graph.ts) directly invokes the repository graph adapter. The compiler and [Node `DatabaseSync`](https://nodejs.org/download/release/v22.17.1/docs/api/sqlite.html#class-databasesync) execute synchronously on that same thread. Declaring these methods async does not let the HTTP server run during the work.

Current maintenance progress mostly reports discovery, staging, validation and publication. Cancellation checks occur at coarse engine hooks; a queued HTTP or IPC cancellation message cannot itself interrupt synchronous compiler/SQLite work. Existing tests cover mocked pending work and already-aborted signals, not responsive cancellation during a real compiler run. No new end-to-end HTTP latency measurement was taken in this investigation because the Hub remained stopped.

The first mitigation improves time but leaves tens of seconds of same-thread work. A single disposable child process for candidate construction is justified for responsiveness, cancellation and releasing native/JS process state at exit. That boundary does not itself reduce total compute or peak aggregate memory. Avoid a worker pool or serializing complete graph objects; exchange a candidate path and bounded, coalesced stage/count messages.

Prefer parent ownership of the existing repository lease, final source/identity validation and atomic publication. Keep expensive staging and candidate inspection off the HTTP thread where practical. A failed/killed child must leave the previous graph usable, with no orphan writer and no late publication after cancellation. Parent death, shutdown, OOM and Windows open-file/sidecar cleanup need real tests. [Worker resource limits](https://nodejs.org/download/release/v22.17.1/docs/api/worker_threads.html#new-workerfilename-options) constrain the JS engine, exclude external allocations and do not prevent whole-process OOM; a worker is not a hard native memory boundary.

## How this relates to issue #140

The [original report](https://github.com/mex-memory/mex/issues/140) described MEX 0.7.2 on macOS arm64 with Python, JavaScript and Svelte: widely varying build times and a `check` reaching roughly 12 GB before being killed. In the [reporter's later 0.7.3 follow-up](https://github.com/mex-memory/mex/issues/140#issuecomment-5445828682), `check` completed in 3.3 seconds without memory ballooning and repair recovered the graph, but rebuilds still took 11m34s to more than 30 minutes. Those are the reporter's historical observations, not current reproduction timings.

[PR #147](https://github.com/mex-memory/mex/pull/147) already fixed important read-path, compiler/WASM lifetime and fingerprint storage costs. [PR #174](https://github.com/mex-memory/mex/pull/174) already removed persisted resolved-reference duplication and added corpus exclusions. Both are ancestors of this branch. JavaScript without a tsconfig can still enter MEX's inferred TypeScript program, as verified in current source.

The reporter's repository was not available locally. We cannot assign its remaining rebuild variance to the newly demonstrated savepoint path without a matching profile. We can say that current code still contains a severe, independently reproduced graph-build bottleneck and substantial memory amplification.

## Proposed release work, in order

1. **Storage correction — small and focused.** Add an explicit bulk path owned by the graph publisher's existing transaction; preserve generic fingerprint atomicity, duplicate handling, stable integer refs, constraints and every row value. Include exact-output parity and failures after both a fingerprint write and a bucket write, plus existing graph transaction/publication recovery tests. No schema or public protocol change is needed.
2. **Bound statement lifetime and reduce proven overlap — small to medium.** Reuse fixed prepared statements within a bulk operation/connection. Avoid a global cache; handle active iterators and close/reopen correctly. Then measure demand-driven continuity reads and staged-node reuse individually. Keep speculative compiler caches, identity changes and broad storage redesign outside this checkpoint.
3. **Isolate Hub graph construction — medium, separately reviewed.** One internal candidate-builder process, small progress protocol, supervised cancellation and safe failure. Preserve the graph adapter and publication contract. Plan this for 0.8.1 because the reported Hub stall remains after the storage fix; if it expands into a recovery redesign or cannot pass Windows/package tests, ship the storage correction independently and explicitly schedule isolation immediately afterward. Do not call the Hub issue fully fixed while heavy work still blocks it.
4. **Representative regression coverage alongside those changes.** Keep current budgets intact. Add a realistic multi-project/dependency fixture, repeated changed work, real HTTP/cancel responsiveness, and total Hub-plus-child CPU/RSS if isolation is introduced. Calibrate new gates on the pinned runner, not from this laptop.

Do not put true dependency-aware incremental indexing, a persistent compiler daemon or a native engine rewrite into this small release. A nonempty supported-source change currently triggers whole-corpus staging to preserve cross-file semantic convergence; incremental updates must account for imports, exported types, moves/deletes, configuration, aliases and provenance. TypeScript's [builder API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API#writing-an-incremental-program-watcher) does not maintain MEX's graph semantics automatically. The inspected [native TypeScript project](https://github.com/microsoft/typescript-go) lists its compiler API as not ready, so it is not a demonstrated drop-in replacement. The dominant work found here already runs in SQLite's native C.

## Why the existing performance gate missed this

The release fixtures contain **4, 16 and 48 tiny source modules**, one tsconfig, and no installed dependency graph. Their “large” designation means the largest synthetic fixture. The current 1,812 ms refresh budget and 604,061,696-byte refresh RSS ceiling are regression bounds for that fixture, not a resource promise for a 708-file dependency-heavy repository.

Maintenance timing runs in one warmed Hub, but RSS is retained only for the first five of ten repetitions. The benchmark does not currently enforce stage CPU, post-cleanup retained-memory trends, concurrent HTTP latency or actual cancellation latency. Its sampler watches only the Hub PID: moving work to a child without changing that sampler would hide the cost. The polling loop also needs request timeouts so a blocked fetch cannot bypass its overall deadline.

Add representative coverage without widening existing calibrated budgets. For storage, test clean build, unchanged refresh, meaningful changed refresh and failure rollback. For process isolation, verify real extraction-time HTTP responses, cancellation acknowledgment plus actual stop, child crash/OOM, parent shutdown and no late publish. Keep Windows/macOS/Linux packaging and ownership tests because process and temporary-file behavior differ.

## Evidence retained and validation boundary

[Measurement summary](code-graph-resource-investigation.json) retains runtime versions, source provenance, stage/memory observations, normalized table hashes, microbenchmark results and experiment limitations. Local raw CPU profiles, RSS JSONL, native samples, bundles and comparison scripts remain under `/tmp/mex-graph-investigation-20260909`; they were not added to Git. These contain repository paths/source-related profiler information and were not uploaded.

To reproduce: check out the recorded commit, install matching dependencies, stop maintenance, verify the seed DB has no authoritative WAL, copy it to temporary storage, and bundle the internal engine outside the indexed corpus. Compare the same `sync` input and seed with only the targeted transform enabled. Record wall/CPU, memory categories, source/config/dependency identity and output digests. For retention, reopen/close the engine within one process and force equivalent full staging several times; use diagnostic GC only in the profiler. For release numbers, repeat without CPU profiling and synchronous stage logging.

Successful data comparison included nodes, edges, files, unresolved references, import bindings, aliases, source chunks, fingerprints, LSH joins by semantic node identity, grounding baselines, schema versions and metadata. Exclusions were generated row IDs and operational write/index timestamps; snapshot source/config/compiler/grammar digests and Git coordinates remained compared. Both databases passed `quick_check` and foreign-key checks. Four ranked node/source FTS query result sets matched. This does not claim byte-identical database files, exhaustive FTS/API equivalence, or production failure-path coverage.

Verification for this investigation:

- Public API and emitted declarations: unchanged.
- Ordinary reads, authority and snapshot publication: production code unchanged; experiments wrote only temporary copies.
- Bounds: no production limits changed; sequential temporary runs used the diagnostic supervisor described above.
- Focused validation: full-data parity, SQLite scaling/failure checks and repeated-process observations completed. Typecheck/full tests were not run because no production TypeScript changed.
- Build/evaluator: no package or graph protocol change; no production rebuild or evaluator regeneration performed.
- Working tree: report and focused MEX context notes only; generated databases, profiles, local state and builds remain untracked/ignored outside the change.
- Protocol and recovery: current behavior preserved; proposed implementation still requires the targeted tests listed above.

MEX context used: architecture, `safe-graph-snapshot-evolution`, `release-performance-gate`, and `fresh-graph-hub-integration`. Historical Timeline search returned no matching notes. The investigation does not re-baseline grounding or promote speculative optimization claims as implemented behavior.
