# Graph schema v4 compatibility boundary

Status: integration record for main v0.7.3 and the human-team branch

This record explains how MEX combines the compact graph released in v0.7.3
with the generalized grounding and freshness guarantees developed on
`integration/human-team-memory-v1`. It does not change graph ranking, the
protocol-v3 JSONL surface, grounding anchors in Markdown, or package-root
exports.

## Why v4 exists

Two independently developed database layouts were both labelled schema v3:

- the released v0.7.3 layout stores 256-byte MinHash sketches as BLOBs and LSH
  buckets through integer fingerprint references;
- the integration layout generalizes `_mex_grounded_source` from the historical
  scaffold-file key to `subject_kind` plus `subject_id` so Wiki groundings can
  share one trustworthy graph snapshot.

The version integer alone therefore cannot identify a v3 database. Schema v4
means that both complete shapes and their invariants are present. Readers require
v4 and never mutate an older store as a side effect.

## Structural lineage detection

Writing maintenance inspects the real SQLite shape before choosing an upgrade:

| Lineage | Required evidence |
|---|---|
| Released main v3 | `node_fingerprints.ref`, BLOB `minhash`, and `lsh_buckets.ref` |
| Integration v3 | `_mex_grounded_source.subject_kind` and `subject_id` |
| Complete hybrid v3 | Both complete sets of evidence |
| v4 | Both complete sets plus a validated v4 schema marker |

Missing columns, mixed old/new fingerprint keys, the wrong MinHash storage
class, or a partially generalized grounding table are not guessed through. They
are classified as requiring a safe rebuild.

## Lossless upgrade rules

Recognized upgrades run only against a same-directory candidate while the
existing graph maintenance lease is held:

1. v1 and v2 take the ordered combined structural migration to v4. A v1
   candidate remains marked `rebuild_required` because that lineage predates
   the identity and grounding evidence needed for a trustworthy lossless repair;
   explicit rebuild replaces its derived facts.
2. Released main v3 retains compact fingerprints and LSH rows while grounding
   keys are generalized.
3. Integration v3 retains generalized grounding rows while fingerprints and LSH
   rows are converted to the compact representation.
4. A complete hybrid is validated and stamped v4 without rewriting facts that
   are already in the final representation.
5. An already-v4 store is validated as an idempotent no-op.

The v4 marker is written only after SQLite integrity, foreign keys, fingerprints,
LSH membership, grounding rows, and graph invariants pass. Publication then uses
the established candidate validation, exact-generation check, atomic rename,
rollback, and recovery path. A failed upgrade never makes the candidate the
trusted graph and never edits the prior database bytes.

## Runtime and repair behavior

Ordinary Graph, Wiki, and Hub reads open the last published database immutably,
bind it to its snapshot provenance and exact source identities, and revalidate
freshness before releasing buffered output. A recognized v1/v2/v3 store reports
`rebuild_required` to readers with bounded remediation; reads do not upgrade,
checkpoint, refresh, or rebuild it.

`mex graph repair` is an explicit writer. It uses the same cross-process lease
and candidate-publication boundary as other maintenance, checkpoints and
validates the candidate, and performs a recognized lossless v4 upgrade when
possible. A v1, partial, ambiguous, or corrupt store leaves the published bytes
untouched and requires `mex graph rebuild`. Repair is deliberately not a
separate Hub job kind.

## Engine authority

The graph engine uses the v0.7.3 extraction and storage implementation:

- one TypeScript program at a time;
- compiler-project crash isolation with Tree-sitter fallback;
- explicit Tree-sitter/WASM tree disposal;
- opt-in semantic diagnostics;
- duplicate declaration ordinal disambiguation;
- compact fingerprint and LSH storage;
- extractor version `typescript-5.9-v2`.

Those behaviors run inside the integration branch's source-spooling,
parse-failure preservation, cancellation/progress, immutable-read, freshness,
maintenance-lock, candidate-validation, recovery, Hub, and Wiki-grounding
boundaries. Ranking, graph protocol output, TUI behavior, and grounding anchor
serialization remain compatibility gates.

## Verification boundary

Fixtures cover v1, v2, both v3 lineages, a complete hybrid, malformed hybrids,
and v4 replay. Every lossless migration must preserve graph facts, query order,
fingerprint matches, LSH candidates, grounding baselines, and snapshot meaning.
Failure injection covers migration, validation, publication, and recovery. The
released compiler-crash, sequential-program, tree-disposal, duplicate-identity,
compact-storage, and repair regressions run alongside the integration freshness,
source-race, maintenance, protocol, ranking, Wiki, Hub, package, browser, and
release-performance gates without widening their budgets.
