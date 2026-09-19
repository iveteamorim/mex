# Project Hub Foundation

Status: Lane B foundation complete; Graph and Wiki integrations recorded separately

This document records the Lane B foundation as it originally landed. Its
Graph- and Wiki-unavailable statements are historical slice boundaries,
superseded by [`hub-graph-integration.md`](hub-graph-integration.md) and
[`hub-wiki-readonly.md`](hub-wiki-readonly.md).

Functional reference: TencentDB-Agent-Memory commit
`97f94654280b2932c35ba4806a491999ed244cc9`, limited to explicit asynchronous
status/progress, bounded workbench summaries, and partial-failure visibility.
Its visuals, remote topology, credentials, response envelope, and product
taxonomy are not adopted.

The Project Hub is a desktop-oriented, local control room for one repository.
It adds a browser surface without changing the public library API, terminal UI,
or code-graph retrieval behavior. At the Lane B boundary, production data
remained truthful: repository context, local job history, and repository-backed
team activity could be shown, while unavailable Graph and Wiki capabilities
were labelled rather than simulated.

## Runtime flow

```text
mex hub
  -> acquire repository Hub lease and reconcile local jobs
  -> bind 127.0.0.1 on an assigned or explicit port
  -> create one-use five-minute bootstrap token
  -> browser fragment posts token to /api/v1/session/bootstrap
  -> HttpOnly process-memory session + in-memory CSRF token
  -> authenticated same-origin API and bounded job SSE
```

The fragment keeps the bootstrap secret out of HTTP request targets and server
logs. It is accepted once, exchanged for a 12-hour absolute session, and removed
from the visible URL. The server trusts neither forwarded-host headers nor CORS.
Mutation routes additionally require the exact loopback Origin, JSON media type,
and `X-MEX-CSRF` value.

## Components and ownership

- `packages/hub-contracts` owns the private, runtime-validated wire schemas. It
  is bundled into the CLI and does not become a package-root export.
- `src/hub` owns the Hono application, native loopback listener, security,
  manifest-only static serving, honest read projections, and job orchestration.
- `packages/hub-web` owns the React shell, route states, shared-contract client,
  and development-only visual fixture.
- `.mex/local/team.db` owns per-user job summaries, the repository Hub lease,
  and bounded schema-v4 Team workflow state. A separate mode-0600 local signing
  key authenticates exact identity/Activity previews across CLI and Hub
  processes. Checkpoint C Hub startup provisions that key and creates/migrates
  local state through the shared write-side initializer; pure service reads do
  not initialize either surface.

The browser receives direct resource bodies. Failures use RFC-style
`application/problem+json` with stable MEX codes and request IDs. Adapter error
details are projected through a safe allowlist so local paths, stderr, and stack
traces cannot cross the HTTP boundary.

The Activity read model combines Lane C's canonical event artifacts with
Project notes stored in `decisions.jsonl` without rewriting either source. Its
cursor is bound to a deterministic timeline revision.
Pagination and source safety truncation remain separate, canonical metadata
and legacy cwd/trace/origin fields are omitted, and recorded actors are returned
alongside—not replaced by—their current alias resolution. Home reports only the
exact trusted canonical-event count.

## Job lifecycle

Jobs use the frozen states:

```text
queued -> running -> succeeded | failed | interrupted
```

Graph refresh/rebuild and Wiki refresh/rebuild kinds are registered, but Lane B
ships no production executors for them. Starting an unavailable kind returns
`CAPABILITY_UNAVAILABLE`. A transactional partial unique index permits one
active index mutation per scaffold. A token-bound process lease prevents a
second live Hub from reconciling or releasing the first process's work.

Executors receive an `AbortSignal` and emit allowlisted phases with monotonic
numeric counts. Unknown totals remain indeterminate. User cancellation requests
abort but keep the active slot until the executor settles; restart and shutdown
interruptions have distinct reasons. Late callbacks are generation-checked and
ignored. Persisted records are bounded and never contain source bodies, prompts,
transcripts, diffs, arbitrary commands, or secrets.

## Browser experience

The shell represents every planned route, with complete Home, Search, Health,
Jobs, Members, and Activity states. Members exposes bounded canonical reads,
effective actor resolution, local selection, and exact preview/apply for the
Checkpoint C mutations. Activity is a date-grouped, read-only feed of MEX
records and Project notes with bounded provenance, revision-safe
pagination, and explicit partial-read diagnostics. Schema-v2 MEX records expose
their service-owned workflow/custom origin and optional human label; schema-v1
records remain unchanged and appear with unknown origin. Direct Activity
recording remains a structured CLI/private-API workflow rather than a manual
Hub composer. Knowledge and Code remain read-only index workspaces. Checkpoint D supersedes the original Workstreams and
Specs placeholders with a canonical Workstream preview/apply workbench and a
fresh-index, read-only Spec hierarchy. Playbooks, Inbox, and Relays remain
capability-aware foundations rather than fake CRUD.
Search keeps Wiki, symbol, and source groups independent, including independent
partial failure, and never fuses their scores.

The UI is desktop-only at 1024 pixels and wider. It uses a persistent sidebar,
compact repository context, a balanced dashboard grid, self-hosted fonts, CSS
Modules, semantic design tokens, keyboard/focus handling, and reduced-motion
support. Fixture data is compile-time development/test input and is absent from
the production bundle.

## Original Lane B boundaries

- No remote bind, proxy trust, hosted authentication, telemetry, or outbound assets.
- Graph status and maintenance were deferred to the later Graph integration.
- Wiki read, search, health, and maintenance were deferred to the later Wiki
  integration.
- No Workstream, Inbox, Relay, Spec, or Playbook mutation in Lane B.
- No Activity creation or Catch Up cursor advancement in the read-only Hub slice.
- No change to `src/index.ts`, graph retrieval/ranking, protocol-v3 JSONL, or `mex tui`.

Checkpoint C supersedes the historical Activity-creation and member-UI
boundaries above. Checkpoint D additionally supersedes the Workstream and
read-only Spec placeholder boundaries. Spec authoring, Catch Up, and every later
team workbench remain unavailable.

## Verification

The release gates cover API contracts and limits, security expiry and rejection,
static-path containment, job leases and lifecycle, schema migration/rollback,
browser routes and accessibility, deterministic visual baselines, production
fixture absence, packed-install bootstrap, public declaration leaks, existing
graph protocol goldens, TUI regressions, evaluator tests, and diff hygiene.
