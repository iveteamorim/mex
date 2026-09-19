# Project Hub read-only Wiki integration

Status: the Wiki half of Checkpoint 2 is working

This slice connects the repository-bound WikiPort adapter to the local Project
Hub. It provides real Wiki Search, Knowledge browse/detail, explicit
Code-to-Knowledge links, structured Wiki Health, and explicit refresh/rebuild
jobs. It does not add Wiki editing, migration or synthesis UI, drift/review
workbenches, Workstreams, Specs, Playbooks, Inbox, Relays, Catch Up, or public
package-root exports.

## Private application boundary

Production creates one `RepositoryWikiPort` with the repository's normalized
Wiki exclude/read-only configuration and the package-private fresh Graph
grounding bridge. Hub services receive a narrow structural read interface; job
executors receive the concrete adapter. Neither layer opens Wiki or Graph
SQLite directly, shells out to a CLI, or accepts a raw query callback.

```text
authenticated Hub request
  -> strict private Zod request contract
  -> repository WikiPort batching method
  -> immutable, inode-bound Wiki read session
  -> optional fresh Graph grounding snapshot
  -> complete bounded in-memory projection
  -> final Wiki, corpus, and Graph revalidation
  -> private JSON response (at most 1 MiB)
```

The authenticated private routes are:

- `GET /api/v1/wiki/entities`
- `GET /api/v1/wiki/entities/:id`
- `GET /api/v1/wiki/entities/:id/relations`
- `GET /api/v1/wiki/entities/:id/backlinks`
- `GET /api/v1/code/symbols/:id/knowledge`
- the independent Wiki group in `GET /api/v1/search`

List, relation, backlink, and Code-link cursors stay opaque and are bound to the
normalized request and exact indexed generation. Ordinary paging failures keep
already trusted rows. Revision conflicts never combine generations and remain
latched until a complete newest read succeeds.

## Bounded, private projections

Knowledge summaries expose identity, lifecycle, exact containing-file revision,
bounded topics/source types, current grounding health, repository-relative
location, safe diagnostics, and a local route. Detail adds at most 128 KiB of
plain body text plus bounded provenance, evidence, grounding resolutions,
relation count, and backlink count. Relations and backlinks page independently.
Code links are emitted only for explicit Wiki groundings; graph and Wiki scores
are never fused or reranked.

Hub responses omit extension metadata, agent session identifiers, raw engine
diagnostics, absolute paths, source dumps, prompts, transcripts, and arbitrary
errors. Canonical source text is rendered as text, not markup. Development
fixtures are build-time substituted with a null production boundary, make no
outbound requests, and cannot appear in packaged assets.

## Health and explicit maintenance

Wiki capability availability is structural: a missing or corrupt index still
has a real rebuild executor. Health projects the stable index state, schema,
indexed revision/time, bounded safe diagnostics, active job, allowed operations,
and optional recommendation.

- fresh allows an explicit no-op refresh or rebuild, with no recommendation;
- stale allows refresh or rebuild and recommends refresh;
- missing, corrupt, or rebuild-required allows and recommends rebuild;
- degraded, migration-required, or otherwise unsafe observations offer no
  automatic repair action.

Eligibility is revalidated immediately before a durable job is created. Refresh
discovers the exact added, modified, and deleted canonical paths inside one
immutable Wiki session, then calls targeted `refreshFiles`. Rebuild is always
confirmed in the UI. Both pass the durable job `AbortSignal` and fixed safe
phases to the adapter. The repository Wiki lease arbitrates Hub and CLI writers;
ordinary reads never launch maintenance.

Successful jobs invalidate Knowledge, the Wiki Search group, Code-linked
Knowledge, Health, Jobs, and capability queries. The durable job manager retains
its one-active-index-job rule, generation binding, SSE behavior, cancellation,
restart interruption, and late-progress rejection.

## Interface and verification

`/knowledge` is a URL-backed browse/search workbench with singular kind, topic,
lifecycle, grounding, and source-type filters. `/knowledge/:id` uses the existing
polished Hub system as a dense field notebook: identity, exact body, and
grounding/evidence/provenance form three columns at 1440 px and stack without
horizontal overflow at 1024 px. Workstreams, Specs, and Playbooks remain
independently unavailable even when Wiki reads are installed.

Verification covers the private contracts, real adapter/API integration,
authentication and Host/query rejection, symlink containment, diagnostic and
metadata privacy, byte/mtime read non-mutation, exact targeted refresh, corrupt
rebuild, packed-install operation, component state and focus behavior, axe,
reduced motion, 1024/1440 layout, deterministic screenshots, fixture exclusion,
and zero outbound requests. Graph ranking/protocol/TUI and Activity behavior are
unchanged.
