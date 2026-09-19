# Project Hub graph integration

Status: the Graph half of Checkpoint 2 is working; the later Wiki consumer is
recorded in [`hub-wiki-readonly.md`](hub-wiki-readonly.md)

This slice connects Lane A's freshness and recovery foundation to the local
Project Hub. It provides real Code search, symbol inspection, traversal, graph
Health, and explicit refresh/rebuild jobs. It does not integrate Wiki, change
graph ranking or protocol-v3 output, add package-root exports, alter Activity or
Catch Up, or make ordinary reads maintain the graph.

This page records the completed Graph slice. The earlier
[`project-hub-foundation.md`](project-hub-foundation.md) remains the Lane B
foundation record; its Graph-pending boundary is superseded here. The separate
Wiki integration record supersedes this slice's original Wiki-pending boundary.
The later [`graph-v4-compatibility.md`](graph-v4-compatibility.md) record defines
how the released v0.7.3 compact store and the Wiki-grounding lineage coexist.

## Ownership and flow

`RepositoryGraphPort` is an internal, repository-bound implementation of the
frozen `GraphPort`. The Hub creates one adapter and injects it into read services
and graph job executors. Hub code calls Lane A modules directly: it never shells
out to `mex graph`, accepts raw SQL callbacks, or exposes a SQLite handle.

```text
authenticated Hub request
  -> private Zod request contract
  -> repository GraphPort adapter
  -> stable fresh status observation
  -> one inode-bound immutable SQLite/source session
  -> complete bounded in-memory projection
  -> final database + snapshot + source freshness validation
  -> private Zod response contract
  -> response, or one safe problem with no partial graph data
```

The adapter's two package-private batch operations make the snapshot boundary
explicit:

- `searchBundle()` reads symbol and source search groups under one session while
  retaining group-local cursor failures.
- `readSymbolWorkspace()` reads canonical symbol identity, indexed source, and
  exactly one selected traversal under one session.

These types remain implementation details and are absent from `src/index.ts`
and the generated public library declarations. `packages/hub-contracts` is also
private and is bundled into the CLI rather than published as a runtime workspace
dependency.

## Exact freshness handshake

Every Search or Code response follows the same six-step rule:

1. Inspect a stable graph and require the status to be `fresh`.
2. Adopt one immutable SQLite connection bound to the inspected graph inode and
   exact `graph_snapshot_v1` bytes.
3. Read graph facts from that connection. Read source through a contained,
   identity-stable file descriptor and require its decoded SHA-256 to match the
   indexed `files` row.
4. Build the complete bounded response in memory. Nothing is streamed or
   released while facts are still being assembled.
5. Revalidate database identity, sidecar absence, snapshot provenance, Git and
   semantic source freshness, and every source binding immediately before return.
6. Return the complete projection, or discard it entirely and report
   `OPERATION_INTERRUPTED`.

The handshake performs at most one initial and one final full freshness
observation per Hub Search or Code request. It protects against live WAL or
rollback-journal activity, database replacement, source/database ABA races,
symlink escape or retargeting, and final invalidation. Ordinary reads do not
create, migrate, checkpoint, refresh, rebuild, stage, or commit anything.

## Search and Code APIs

`GET /api/v1/search` keeps `wiki`, `symbols`, and `sources` as independent
groups. Wiki is explicitly unavailable. Symbol and source results retain the
graph engine's order; the Hub performs no reranking or cross-domain score
fusion. A malformed or request-mismatched group cursor can fail that group
without erasing the other. A final freshness failure invalidates both graph
groups because neither buffered result is trustworthy.

`GET /api/v1/code/symbols/:id` accepts one selected view:

- `overview` returns symbol identity and its exact indexed source window;
- `callers` and `callees` preserve individual deterministic callsite relations;
- `impact` retains Lane A's bounded transitive-caller/blast-radius meaning.

Source continuation uses UTF-8 byte offsets. Traversal cursors and source
cursors are independent but are bound to the same graph snapshot and normalized
workspace view, so a cursor cannot be replayed across views or operations.

Opaque cursors are canonical base64url JSON:

```json
{"v":1,"operation":"nodes","snapshotHash":"…","requestHash":"…","offset":25}
```

The request hash includes normalized filters, bounds, page limit, and (for a
workspace source cursor) the selected view. A request mismatch is
`VALIDATION_FAILED`; a graph snapshot mismatch is `REVISION_CONFLICT`.
`nextCursor` reports another normal page, while `truncated` reports an omitted
safety- or content-bounded remainder.

## Health and explicit maintenance

Graph capability is structural: read, refresh, and rebuild are registered when
the adapter/executors are installed even when the current index is missing.
Health reports the current index status and observation time, indexed/current
branch and HEAD, schema/extractor/grammar versions, parse totals, bounded source
changes and diagnostics, active graph job, allowed job kinds, and an optional
recommended repair.

For a non-fresh graph, repair controls come only from safe executable Lane A
remediation:

- `mex graph refresh` enables `graph_refresh`;
- `mex graph rebuild` (and the legacy safe `mex graph` alias) enables
  `graph_rebuild`;
- no executable remediation means no repair control.

A fresh graph can explicitly allow both operations without recommending either.
Unsafe prerequisites, active writer state, or an observation race expose no
operation. Parse-only degradation remains explanatory and does not invent a
recommended repair, while a structurally fresh graph may still expose both
explicit operations. The server re-inspects eligibility immediately before it
creates a job.

Refresh and rebuild are user-launched only. Refresh is confirmation-free;
rebuild uses an explicit browser confirmation dialog. Both executors receive the
durable job's `AbortSignal` and call Lane A directly. They persist only values
from the fixed phase allowlist

```text
discover, stage, parse, resolve, validate, publish
```

and trustworthy numeric counts. Free-text progress, paths, source, commands,
prompts, transcripts, diffs, and raw errors are discarded. The existing Hub
generation binding, one-active-index-job constraint, repository process lease,
SSE delivery, cancellation state, restart reconciliation, and late-callback
rejection remain authoritative. Lane A's separate cross-process lock arbitrates
Hub and CLI graph writers. Hub shutdown gives graph work up to 60 seconds to
reach a safe boundary, then fails closed.

The Lane A phase allowlist introduced `.mex/local/team.db` schema v3; the later
workflow schema v4 preserves it together with configured members, Catch Up
cursors, and bounded workflow drafts through transactional migration. Reads
still never create or migrate local state; explicit Hub startup owns migration
and stale-job reconciliation.

## Stable failures and bounds

All API failures use bounded `application/problem+json` with a request ID.
Internal SQLite, Git, filesystem, recovery, stderr, and diagnostic details are
replaced by safe projections.

| Condition | Stable MEX code |
|---|---|
| Missing graph | `INDEX_MISSING` |
| Stale graph | `INDEX_STALE` |
| Incompatible graph | `MIGRATION_REQUIRED` |
| Corrupt graph | `INDEX_CORRUPT` |
| Degraded observation or invalidated read | `OPERATION_INTERRUPTED` |
| Stale snapshot cursor | `REVISION_CONFLICT` |
| Missing symbol or indexed file | `NOT_FOUND` |
| Invalid graph ID, query, or cursor | `VALIDATION_FAILED` |
| Unsafe repository path | `PATH_OUTSIDE_PROJECT` |

Important private API bounds are:

| Resource | Bound |
|---|---:|
| Search query | 256 characters |
| Encoded cursor | 4 KiB |
| Search page | default 25, maximum 50 per graph group |
| Search safety corpus | 500 results per graph group |
| Source-search preview | 40 lines and 2 KiB per match |
| Symbol source response | 200 lines and 128 KiB, then `sourceCursor` |
| Callers/callees | default 25, maximum 50 |
| Impact | default depth 2, maximum depth 4 and 100 nodes |
| Health paths / diagnostics | 25 paths / 50 diagnostics |
| Serialized API response | 1 MiB |

## Security, privacy, and compatibility

Graph routes inherit the Hub's exact Host and process-memory session checks.
Job mutations additionally require exact Origin, JSON content type, and the
in-memory CSRF token; no CORS or proxy trust is added. Source text is returned
only by the explicitly bounded Search/Code read models. It is never persisted
in job state or included in Health diagnostics.

The packaged production UI contains no graph fixtures and makes no outbound
requests. Successful graph jobs invalidate
the browser's Search, Code, Health, Jobs, and capability queries so subsequent
reads prove freshness again.

This integration does not change graph ranking, the protocol-v3 JSONL command
surface, the existing TUI, Activity, Catch Up, or package-root exports.

## Verification

Adapter and integration coverage exercises ranking parity, all relation and
code-reference outcomes, cursor binding, UTF-8/source limits, missing/stale/
degraded/incompatible/corrupt states, WAL activity, database and source ABA,
final invalidation, safe diagnostics, job eligibility/contention/cancellation,
recognized v1/v2 and dual-v3 lineage migration to schema v4 with rollback, read
non-mutation, real packed Search/Code/Health, and explicit packed
refresh/rebuild. Browser coverage adds the Code
workspace, job confirmation, accessibility, reduced motion, zero outbound
requests, and deterministic 1024/1440 screenshots.

The existing graph protocol goldens, evaluator suite, TUI regressions,
declaration-leak check, package smoke, and diff hygiene remain release gates.
