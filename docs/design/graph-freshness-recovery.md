# Graph freshness and recovery

Status inspection and graph maintenance are intentionally separate. Ordinary
reads call the immutable inspector and never create, migrate, checkpoint,
refresh, or rebuild `.mex/graph.db`. Maintenance happens only after a user runs
an explicit graph command or another already-mutating workflow such as setup or
grounding sync acquires the same maintenance lease.

## Commands

- `mex graph status` inspects repository, corpus, compiler inputs, schema,
  snapshot provenance, graph invariants, fingerprints, and SQLite sidecars.
- `mex graph refresh` restages the semantic corpus through the existing
  correctness-first sync path. “Refresh” is not a claim of incremental speed.
- `mex graph rebuild` builds a same-directory candidate, validates it, and
  atomically publishes it. Bare `mex graph` is a compatibility alias.

Refresh accepts only a compatible, inspectable live index. Rebuild also handles
missing, incompatible, and corrupt indexes. A per-project owner-token lock spans
staging, publication, and any subsequent grounding writes. Candidates and
rollback copies use uniquely owned ignored paths. Before publication, MEX
revalidates the live database, candidate identity, exact snapshot bytes, and
absence of authoritative WAL or rollback-journal data. A failed operation leaves
the prior trustworthy graph byte-identical; a replaced corrupt or incompatible
database is retained locally as `.mex/graph.db.recovery-*`.

## Targeted retrieval handshake

`graph get`, `graph query`, and `impact` first require a stable status
observation that is either `fresh` or config-drifted (below). They then adopt one immutable SQLite connection for graph and
grounding reads, bind it to the inspected inode and exact `graph_snapshot_v1`
bytes, and buffer the complete JSONL response. Source ranges come from one
contained, fd-stable byte buffer whose UTF-8 decoded hash matches the indexed
file row. Immediately before output, MEX repeats freshness and database identity
validation; any mismatch discards the whole response and emits one bounded
`GRAPH_UNAVAILABLE` record.

`graph scope` deliberately retains its existing stale-file text-only fallback.
It uses a single stable immutable database snapshot, but it does not claim
that stale live text is an indexed graph fact. It is not bound to the exact
freshness handshake: that fallback is what lets it answer while source files
are being edited, and binding it would turn one edited file into a refused
retrieval. It classifies build identity through the same predicate as the
targeted commands and refuses through the same record. Retrieval ranking and
successful protocol-v3 records remain unchanged.

## Reading a store that is not provably fresh

The build manifest folds seven inputs. Six are engine identity — schema,
compiler, extractor and resolver versions, grammar, and corpus policy — and a
difference in any of them means the store was written by code that is no longer
here. The seventh is the content of every `package.json`, `tsconfig*.json` and
`jsconfig*.json` in the repository, which moves for reasons that change nothing
about the graph: a dependency version, a script, a reformat.

Collapsing all seven into one comparison made a dependency bump indistinguishable
from an incompatible store, and both refused every structural read until a full
rebuild. A store is now classified as config-drifted when it would read `fresh`
except that its config inputs moved: engine identity reproduces from the current
inputs and that store's recorded config hash, the indexed corpus, branch, corpus
digest and grammar all still match, parse health is clean, and every inspection
completed. Anything short of that still refuses.

Two further shortfalls are bounded in the same way. A store whose files parsed
partially is *incomplete* rather than out of date — every fact in it is still
true — so it is read and the response reports how many files are affected and
which failed. A store whose indexed source has changed is read by excluding the
complete set of drifted paths and answering from the rest; the response names
every file it left out, a node whose own file drifted is reported as excluded
rather than missing, and a target that resolves only into excluded files says
so. Completeness of that set is the safety property, so it is bound to the
change-path ceiling: a truncated change list cannot be exhaustively excluded
from and refuses as before.

A degraded store is bound and read exactly like a fresh one, and the response
says so. Definitions, containment and returned source are unlabelled:
they do not depend on compiler configuration, and the source bytes are already
proven identical to what was indexed. Resolution does depend on it — `paths`,
`moduleResolution`, `references` and a package `type` decide what a reference
binds to — so callers, call relations, flows and unresolved references carry
`stale: true`, and the response opens with a `status` record naming the drift
and the recovery command. Every one of those fields is absent while the graph is
fresh.

Publication applies the same judgement in the other direction. A candidate whose
only fault is a file the corpus policy skipped, or one that parsed partially, is
published: refusing would discard every other file's facts to punish a gap a
rebuild would reproduce exactly. Corpus-wide breaches and incomplete inspections
still block, because those mean the observation itself is untrustworthy.

Config inputs are identified by the fields that decide what the compiler
resolves, not by their bytes, so a dependency version, a script or a reindent
does not invalidate an index. Anything unparseable or unrecognized falls back to
exact bytes: over-invalidation is noisy, but under-invalidation would serve a
stale index as current with nothing to say otherwise.

Reading a drifted store writes nothing to it. The label is not a substitute for
`mex graph refresh`; it is what the graph can honestly say until then.

## Evaluator identity

The normalized evaluator hash includes all semantic snapshot fields: schema,
compiler/extractor/resolver versions, grammar/config/manifest hashes, source
corpus identity, semantic positive and negative inputs, and parse health. It
excludes only indexing timestamps, Git branch/HEAD, and the metadata row
timestamp. Malformed, unknown, or future snapshot shapes fail closed.

## Performance characterization

Run the non-gating benchmark after a build:

```bash
npm run benchmark:graph-status
```

The harness creates deterministic committed TypeScript repositories, performs
an explicit rebuild, warms the CLI, and reports fresh `graph status --json`
latency plus source/database sizes and the full Node/SQLite/OS/CPU environment.
It never applies a wall-clock pass/fail threshold.

An Apple M4 / Node 22.17.1 / SQLite 3.50.0 characterization on 2026-08-23 used
two warmups and seven measured fresh-status processes per fixture:

| Sources | Source bytes | Graph DB | Status median | Status p95 | Rebuild |
|---:|---:|---:|---:|---:|---:|
| 100 | 81,329 | 9,715,712 B | 579 ms | 656 ms | 1,211 ms |
| 400 | 326,129 | 38,195,200 B | 714 ms | 1,035 ms | 4,037 ms |

These numbers include CLI process startup and are a local trend reference, not a
release claim. The 400-file graph was roughly four times the stored graph size;
fresh status remained sub-second at the median on this machine. Larger source
corpora and graphs still require ongoing measurement.
