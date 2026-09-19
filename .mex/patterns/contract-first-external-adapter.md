---
name: contract-first-external-adapter
description: Freeze a consumer boundary safely when an independently owned implementation is missing or still in progress.
triggers:
  - "external adapter"
  - "contract lock"
  - "teammate implementation"
  - "consumer port"
edges:
  - target: "context/architecture.md"
    condition: "when deciding dependency direction and ownership boundaries"
  - target: "context/decisions.md"
    condition: "when a provisional boundary becomes a durable project decision"
grounds_to: []
last_updated: 2026-09-03
mex:
  id: mx_01M1M0CJHQ2W47KM6K176ZYYPA
  type: pattern
  status: promoted
  revision: 2
  title: contract-first-external-adapter
  relations:
    - type: related_to
      target: mx_01M1M0CJ5C5XQV0HM5VM787WQS
      note: when deciding dependency direction and ownership boundaries
---

# Contract-First External Adapter

## Context

Use this pattern when MEX consumers must progress before an independently owned
engine or service has an identifiable implementation revision. A design or build
spec establishes intent, but it does not establish type or runtime parity.

## Steps

1. Pin the MEX base, every available reference revision, and the exact hash of
   supplied specifications. Record any missing implementation branch/commit.
2. Define application projections and ports without importing storage rows,
   database handles, Markdown ASTs, or unrestricted mutation clients.
3. Keep canonical and derived state separate. Preserve semantic revisions and
   content hashes as distinct concurrency signals.
4. Separate caller proposals from engine-produced patch plans. Require an exact
   preview digest, current revision checks, typed errors, and idempotency keys on
   apply.
5. Build a realistic behavioral mock and an adapter-neutral conformance suite.
   Test bounds, deterministic ordering, read non-mutation, write scope, failure
   atomicity, explicit repair, and canonical ownership.
6. Freeze any pre-existing public protocol that must not regress with focused
   goldens at the actual boundary being claimed.
7. Label the contract provisional until the real implementation is pinned and
   registered against the same suite. Do not claim parser, filesystem, database,
   or integration behavior from the mock alone.

## Gotchas

- A mock can prove consumer semantics, but not real parsing, atomic filesystem
  replacement, symlink containment, index recovery, or graph provenance.
- Handler-level serializer goldens are not full-process CLI goldens.
- A parser may read another lane's canonical Markdown without becoming its
  mutation owner; keep writers path-partitioned.
- Index inspection and ordinary reads must not perform hidden refreshes.
- Lexical path validation is insufficient at a filesystem boundary; adapters
  must also enforce realpath containment.
- A real adapter needs a generation-bound read session, not a sequence of safe
  individual queries. Buffer the whole projection, then revalidate the bound
  database and canonical corpus before returning it.
- Keep semantic entity revisions separate from exact containing-file hashes.
  CRLF/LF or BOM-only changes can preserve meaning while invalidating byte
  offsets and optimistic file expectations.
- Opaque application plans should not serialize source or audit bodies. Store
  the executable plan behind a bounded process-lifetime handle. If nothing was
  published, restart requires a new preview. If a non-atomic writer can leave a
  durable prefix, persist a separate bounded body-free manifest before apply and
  resume only after operation-specific audit and exact current-byte proof.

## Verify

- [ ] Focused contract and golden suites pass.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes without concurrent-build timing interference.
- [ ] `npm run eval:test` passes when graph behavior is in scope.
- [ ] `npm run build` passes.
- [ ] If an implementation revision exists, the real adapter is registered
      against the same consumer suite with no skips.
- [ ] Only intended paths are staged, especially in a dirty worktree.

## Debug

When a consumer and mock disagree, typecheck the internal contract barrel and
the mock first. When a real adapter disagrees, compare the pinned upstream types
and conversion functions before changing the consumer projection. Never weaken
the suite merely to accommodate an unpinned implementation.

## Update Scaffold

- [ ] Update `.mex/ROUTER.md` "Current Project State" if the boundary changes.
- [ ] Record durable ownership or contract decisions in
      `.mex/context/decisions.md` once the real adapter is pinned.
- [ ] Update this pattern when a real integration exposes a new failure mode.
