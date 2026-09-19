# Repository WikiPort integration

Status: internal engine and adapter boundary complete. The read-only Project Hub
consumer is recorded in [`hub-wiki-readonly.md`](hub-wiki-readonly.md).

## Dependency direction

The consumer-owned `WikiPort` remains the stable application boundary. The
repository adapter is internal and deliberately absent from the package root:

```text
team/Hub consumer
  -> WikiPort
  -> RepositoryWikiPort
     -> immutable Wiki contract read session
     -> pinned operation and migration planners
     -> explicit Wiki refresh/rebuild maintenance
     -> package-private fresh RepositoryGraphPort grounding snapshot
```

Hub and Wiki code never receive SQLite handles or arbitrary query callbacks.
Wiki imports only a structural grounding-snapshot interface, so Graph does not
depend on Wiki and no graph-to-wiki module cycle is introduced.

## Canonical bytes and disposable index

Canonical Markdown is authoritative; `.mex/wiki.db` is disposable. Schema v3
stores two different revisions because they answer different questions:

- the entity semantic hash normalizes Markdown for optimistic entity edits;
- the file content hash covers the exact accepted UTF-8 bytes, including BOM
  and line-ending changes.

`indexedRevision` is derived deterministically from the sorted indexed paths and
their exact file hashes. A separate immutable-index digest binds cursors to the
complete projected generation, including derived grounding state.

Existing graph schema-v1/v2 indexes and either historical schema-v3 lineage are
not silently migrated by readers. They are reported as `rebuild_required`; only
explicit graph maintenance may publish the combined schema-v4 compact store and
grounding baseline described in
[`graph-v4-compatibility.md`](graph-v4-compatibility.md).

## Read handshake

Every repository Wiki read follows one fail-closed sequence:

1. inspect the index and canonical corpus without mutation;
2. bind the exact Wiki database inode and immutable SQLite connection;
3. project a bounded response entirely in memory;
4. re-observe the database identity, index generation, and canonical corpus;
5. return only if the observations still match, otherwise discard everything.

The index inspector distinguishes missing, fresh, stale, degraded,
rebuild-required, corrupt, and migration-required states. Stale and degraded
indexes remain readable where the frozen port permits it; unsafe states require
an explicit maintenance or migration action.

List, search, relation, and backlink cursors are base64url canonical JSON bound
to the operation, normalized request, exact index generation, and offset. Bad or
request-mismatched cursors are invalid requests; a replaced generation is a
revision conflict. Filters run before paging and token limits, and
`truncated` remains true whenever paging, token, or safety bounds omitted data.

Canonical source reads use descriptor-bound, no-follow containment checks. The
adapter rejects absolute paths, backslashes, NUL, traversal, retargeted parents,
symlinked `.mex` roots, and leaf swaps. Diagnostics and port errors do not expose
absolute paths, SQLite messages, recovery paths, or raw filesystem errors.

## Reviewed writes and maintenance

Operation preview creates one engine-owned batch plan containing exact before
and proposed bytes plus deterministic intent/completion audit bytes. Apply uses
that exact plan under the repository Wiki lease; it does not replan or remint
IDs. A caught write or completion-audit failure restores the whole ordinary
transaction, while the durable intent log supports exact replay after an
interruption.

Migration preview likewise pins its selected paths, topic mappings, complete
corpus expectations, generated identifiers, proposed bytes, and preview
revision. Apply rejects any intervening corpus change, executes the reviewed
plan, and supports exact replay without changing unrelated prose or legacy
artifacts.

The adapter exposes opaque process-lifetime plan handles rather than serializing
source bodies, paths, or audit bytes across the application boundary. A client
must request a new preview after process restart; the engine's persisted intent
and completion records retain crash-recovery and idempotency semantics.

Refresh and rebuild share one scaffold-wide cross-process lease. Both build a
same-directory candidate, validate it, refuse live sidecar activity, and publish
atomically while retaining or restoring the prior trustworthy generation on
failure. They accept `AbortSignal` and fixed progress phases. Reads never launch
maintenance.

## Grounding

Wiki grounding is resolved only inside `RepositoryGraphPort`'s fresh snapshot
callback. Every installed bridge supplies an exact Graph revision, the snapshot
is revoked when the callback ends, and Graph performs its normal final
database/source freshness validation before results escape. Graph accessor or
freshness failure degrades current grounding to `unverified`; it does not block
unrelated Wiki reads and never triggers Graph or Wiki maintenance.

Grounding-aware maintenance is two phase. Wiki prepares and preflights an opaque
candidate while the Graph snapshot is open; Graph then completes its final
freshness proof and commits the already-bound candidate before closing the
snapshot. On invalidation, the grounded candidate is discarded and maintenance
may publish a second candidate with explicitly unverified grounding. No
Graph-derived verdict is durable before the final Graph proof succeeds.

## Verification boundary

The real repository adapter is registered against the consumer-owned WikiPort
contract suite with no skips. Additional regressions cover exact CRLF/LF/BOM and
UTF-8 behavior, index and source ABA, cursor generation changes, diagnostics
filtering, path/symlink races, atomic operation batches, selective migrations,
rollback/recovery, cancellation, lock contention, Graph snapshot revocation,
and read non-mutation.

The adapter and its engine-only helpers remain private. The Hub consumes only
the bounded batching methods and frozen port surface described above. Wiki
editing, migration UI, synthesis, and review workbenches remain deferred.
