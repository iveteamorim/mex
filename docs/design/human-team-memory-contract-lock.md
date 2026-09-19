# Human-Team Memory Contract Lock

Status: Checkpoints E1-E4 and F0-F4 implemented; pinned Checkpoint F release calibration applied and final enforcement remains gated

This brief records the application boundary for the MEX OSS human-team memory
program. The contract remains an internal, provisional API until a separate
public-semver decision is made. It is an implementation aid, not authorization
to widen the product scope described in the user-approved build program.

## Source authority and pins

Sources are applied in this order:

1. The user's request and explicit scope decisions.
2. `wiki-engine-build-spec.md`, supplied by the user, SHA-256
   `4a79b2d679a35bda1243ac736edb320da16e8ca54129dac3186df93bf12aa0b8`.
3. `PLAN.md`, the human-team delivery program and its exclusions.
4. The OSS roadmap for Markdown-canonical, deterministic, migration,
   evaluation, and privacy principles. Its versions and timeline are not part
   of this implementation contract.
5. Reference implementations, only within the limits below.

Reference revisions:

- MEX base: `48da30ceea54c8716b561c7ba08541df99024e9b` (`v0.7.2`).
- TencentDB-Agent-Memory `feat/server_team`:
  `97f94654280b2932c35ba4806a491999ed244cc9`.
- Local `mex-mono` knowledge-graph reference:
  `fa64878f05a4dde85a02c3da9e39a336cd2e2646`.

The Tencent source is control-panel, backend-for-frontend, explicit-job, and
health/error UX inspiration only. No Tencent service topology, central database,
repository cloning, scheduled synchronization, agent hierarchy, proxy, or
business-response envelope is adopted.

The Wiki engine dependency is pinned at
`1b5da62c84ae8f65e897e6958985a658e408315c`. The integration branch carries the
remaining consumer-contract closure and a repository-bound adapter. The
behavioral mock and the real adapter both run the same consumer-owned
conformance suite without skips, including the final canonical team paths.

## Integration ownership

This feature branch is the integration owner for shared conflict hotspots:
root manifests and lockfile, CLI registration, root exports, `.gitignore`,
templates, compatibility documentation, and final cross-workstream wiring.
Checkpoint 0 intentionally changes none of those hotspots.

The internal contract surface is under `src/team/contracts`. It is not exported
from the package root yet; doing so would create a public semver commitment
before the provisional team API has stabilized.

## Provisional consumer boundary

The contract files define:

- shared entity, code, actor, repository, revision, lifecycle, grounding,
  job, diagnostic, pagination, diff, and problem types;
- canonical, derived, local, and ephemeral ownership rules;
- `WikiPort`, `GraphPort`, `GitPort`, `TeamWorkflowPort`, and `HealthPort`;
- strictly explicit index mutation methods;
- no database handle, SQL row, generic shell command, Git mutation, or
  unrestricted file-write escape hatch.

The Wiki read projection exposes the stable fields needed by consumers: body,
summary, exact source location, lifecycle, semantic revision and content hash,
topics, relations and backlinks, sources, provenance, canonical groundings,
checkout-local grounding resolution, and diagnostics. Engine-only extensions,
operation-specific payloads, patch plans, and migration plans remain generic.
Consumer code must not reproduce the engine's Markdown AST or SQLite schema, or
open `.mex/wiki.db` directly.

Canonical mutation ownership is path-partitioned. The Wiki adapter owns its
context, pattern, Spec, topic, and accepted-operation paths. It may parse and
index team-workflow Markdown, but `TeamWorkflowPort` remains the only canonical
writer for member, Workstream, Inbox, Relay, activity, and Playbook paths.

### Required adapter normalization

The real Wiki adapter must normalize these differences without leaking them to
Hub or workflow consumers:

- Wiki `entity.type` becomes `EntityRef.kind`.
- Entity versions retain both the Wiki engine's numeric semantic revision and a
  lower-case SHA-256 hash of the exact containing canonical file bytes.
  Operation preconditions revalidate both values for an existing entity.
- Wiki grounding health maps as follows:
  - `fresh` -> `fresh`;
  - `stale` -> `changed`;
  - `missing` -> `missing`;
  - unresolved with multiple candidates -> `ambiguous`;
  - unresolved, ungrounded, or unavailable graph -> `unverified`;
  - a successfully reconciled rename or move -> `fresh`.
- Entity lifecycle is never derived from grounding health.
- Canonical groundings remain separate from checkout-local resolution. The
  shared application health mapping is retained for filtering while the
  authoritative `fresh | stale | missing | unresolved | ungrounded` resolution
  state remains visible per grounding.
- Aggregate grounding health uses deterministic worst-first precedence:
  `missing`, `ambiguous`, `changed`, `unverified`, then `fresh`; an entity with
  no canonical grounding is `unverified`.
- Engine-specific failures normalize to stable MEX error codes while retaining
  detailed diagnostics.
- Auto-rebuild is disabled at the adapter boundary. Reads, search, validation,
  health, doctor, and Hub page loads never rebuild or launch an agent.
- Filesystem adapters must validate lexical repository-relative paths and then
  verify realpath containment; a symlink must not escape the repository or
  scaffold root.

Operation proposal and patch plan are separate types. The caller provides the
authoritative typed envelope with an engine-owned payload; preview returns the
engine-produced opaque patch plan plus exact diff. Apply requires that plan and
preview hash and immediately revalidates current canonical revisions. The Wiki
engine may expose a durable multi-file prefix only at a simulated/process-death
boundary. Before publication, it therefore also returns a bounded, body-free
recovery manifest containing only operation IDs, generated entity IDs, paths,
revisions, hashes, and audit transitions. A restart requires a new preview when
nothing landed; otherwise it resumes only the exact operation-specific audit
prefix and proves every final byte against that manifest. An exact accepted
operation retry is idempotent; altered reuse is a validation failure.

## Repository Team workflow foundation

Checkpoint B makes the provisional workflow boundary concrete without exposing
it from the package root or registering product commands/routes:

- strict schema-v1 codecs and repositories own Workstreams, portable Inbox
  proposals, Relays, Playbooks, and manual Playbook runs;
- canonical files are limited to 64 KiB, 2,048 records and 32 MiB per kind,
  4,096 directory entries, 100 diagnostics, 100 results per page, and 4 KiB
  revision/filter-bound cursors; members use equivalent corpus ceilings;
- `.mex/local/team.db` schema v4 adds bounded Inbox/Relay drafts, one attested
  repository workflow lease, and a 256-row terminal operation journal with at
  most 16 metadata-only effects per operation;
- journal phases are `intent -> canonical_published -> local_finalized ->
  complete`; pure reads never initialize/migrate storage, while the first
  explicit local mutation or workflow apply does so transactionally;
- the production factory derives one tracked scaffold identity and constructs
  Git and Wiki adapters against one physically guarded repository root;
- actor, timestamp, branch, HEAD, and dirty state are service-owned. Canonical
  publication precedes local cleanup, exact replay is idempotent within the
  documented bounded journal window, and altered reuse or divergent recovery
  state fails closed;
- Wiki authoring hard-reserves `team/**`, `workstreams/**`, `inbox/**`,
  `relays/**`, `playbooks/**`, and `events/activity/**`. Wiki can read supported
  team entity kinds and prefixes but still mints only existing `mx_` IDs and
  never becomes their canonical writer.

## Consumer-owned verification

`test/contracts/wiki-port.contract.ts` is a reusable Vitest conformance suite.
Both the in-memory behavioral mock and the repository adapter register the same
suite rather than replacing it with adapter-owned expectations.

The mock proves consumer-facing ordering, filtering, bounds, read non-mutation,
preview/apply conflicts, idempotency, scoped refresh behavior, typed failures,
and abstract migration behavior. The pinned repository adapter and its
integration fixtures additionally cover the Markdown parser, byte-range
patcher, SQLite publication/recovery, filesystem atomicity, symlink defense,
graph-produced grounding provenance, and apply-time ULID generation. The
integration architecture is recorded in
[`wiki-port-integration.md`](wiki-port-integration.md).

The populated fixture exercises a payment-reliability knowledge slice with
topics, Specs, requirements, acceptance criteria, current and deprecated
decisions, patterns, risks, evidence, typed relations, backlinks, and every
consumer grounding-health state. A separate legacy scaffold preserves existing
prose, frontmatter, `edges`, `grounds_to`, `mex://` links, paths, and the legacy
decision event stream during migration testing.

The graph protocol goldens independently freeze the exact protocol-v3 JSONL
emitted by the graph command handlers for:

- default source-bearing `mex graph scope`;
- `mex graph get` with found and missing IDs;
- `mex graph query who-calls`;
- meta-first, summary-last framing and canonical single-line JSON encoding.

These tests exercise the serializer/handler boundary through injected graph
dependencies. Commander registration and process-level CLI wiring remain covered
by the existing CLI suites; they are not represented as full-process goldens.
The new tests do not change graph retrieval, ranking, token budgets, or existing
CLI serialization.

## Identity and canonical Activity product boundary

Checkpoint C exposes the first repository workflow surfaces without widening
the package root:

- `mex member list|show|current` and `mex activity list|show` are bounded,
  structured reads that do not initialize local state, write global state, or
  invoke the Hub;
- member add/update/deactivate/select and direct Activity record are previewed
  from strict 64 KiB request files and applied only from the exact complete
  schema-v1 preview envelope;
- selecting or clearing the current member is checkout-local and emits no
  Activity; each successful canonical member mutation and direct record emits
  exactly one immutable canonical Activity event;
- new canonical Activity is schema v2. The service records either the exact
  governed workflow operation that emitted the event or `custom` for an
  explicit direct record, plus an optional bounded human label. The stored
  action remains authoritative; a custom action that resembles a workflow
  action does not acquire workflow semantics;
- existing schema-v1 Activity remains byte-preserving. Reads project its
  creation origin as `unknown` and its label as `null`; neither ordinary reads
  nor later workflow mutations rewrite historical events;
- the service captures actor, timestamp, branch, HEAD, and dirty state. A
  repository-local 32-byte HMAC key authenticates cross-process preview
  receipts. The first explicit identity/Activity preview, or Hub startup,
  creates only that mode-0600 key under `.mex/local`; ordinary reads and generic
  workflow previews remain noninitializing;
- missing/lost signer state requires re-preview. Once a journal intent exists,
  exact bounded journal effects authenticate recovery while branch, HEAD,
  revision, and canonical Activity integrity still fail closed;
- canonical Activity is capped at 64 KiB per event, 2,048 records, 32 MiB
  aggregate, 4,096 directory entries, and 100 diagnostics. Requested corrupt
  events are typed failures rather than false `not found` results;
- the authenticated private Hub adds member/current-actor reads, exact Team
  preview/apply routes, a lazy Members workbench, and a bounded read-only
  Activity timeline. Direct Activity recording remains available through the
  structured CLI and exact private API contract, but the browser does not
  expose a manual recorder. No Workstream, Inbox, Relay, Playbook, Catch Up, or
  Wiki editing route is made available by this checkpoint.

## Workstream and read-only Spec product boundary

Checkpoint D adds only the next two product surfaces while retaining the
internal package boundary:

- `mex workstream list|show` and the private Hub Workstreams page expose bounded
  canonical reads with revision-bound cursors and honest source diagnostics;
- create, update, and dedicated one-way archive operations use strict 64 KiB
  request files and the same repository-bound signed preview/apply receipt used
  by Checkpoint C. Apply revalidates exact revisions and publishes exactly one
  immutable Activity event;
- legal Workstream transitions permit planned work to activate or archive,
  active work to block, complete, or archive, blocked work to resume, complete,
  or archive, and completed work to archive. Archival retires blocker state;
  archived records are immutable and cannot be reached through an ordinary
  update patch;
- `mex spec list|show` and the private Hub Specs workspace are read-only aliases
  over canonical Wiki schema-v1 entities. Lists contain only root `spec`
  entities; detail projects only explicit requirement, constraint,
  acceptance-criterion, and refinement relations;
- a Spec detail and its hierarchy are read under one immutable Wiki session and
  one grounding snapshot. Non-fresh index states return typed availability with
  no data and never trigger refresh, rebuild, synthesis, or Graph mutation;
- Workstream and Spec commands are advertised through the versioned capability
  manifest only after their concrete services and root CLI registrations exist.
  No package-root export is added.

Checkpoint D does not add Spec authoring. Spec writes remain Inbox-governed and
belong to Checkpoint E.

## Inbox-governed Spec authoring contract boundary

Checkpoint E0 locks the product contract. Checkpoint E1 implements its internal
repository service, exact governed Wiki authoring seams, signed portable
preview/apply, lifecycle recovery, and real consumer conformance without
claiming CLI, capability, Hub, browser, compatibility, fixture, or performance
implementation.
The exact boundary is recorded in
[`inbox-spec-authoring-contract.md`](inbox-spec-authoring-contract.md).

- E is constrained to expose only a Team Inbox facade for bounded local draft
  and canonical proposal summary/detail reads plus signed
  `previewInbox`/`applyInbox`.
- Each proposal contains exactly one non-batch typed Spec change: create one
  service-ID-derived `.mex/specs/<mx-id>.md`, or update only title, summary, and
  body on one exact existing Spec-family target.
- Create is limited to `spec`, `requirement`, `constraint`, or
  `acceptance_criterion`, status `in_flight | promoted`, bounded topics, and
  at most one create-time relation in Checkpoint D's exact four-family direction
  table. Sources, groundings, metadata, adoption, archive, post-create relation
  changes, properties, type conversion, move, supersede, inline replacement,
  and adapter `payload.operations` batches are absent.
- At publish, repair, mark-stale, and approval, existing update targets and
  create-time relation/topic endpoints are resolved and exact-revision checked
  in one fresh Wiki view. Local draft save/delete does not require that view.
- Proposal staleness is explicit: only the service may preview
  `pending -> stale` after proving target drift, a failed approval writes
  nothing, and repair is only `stale -> pending`.
- The signed portable receipt carries at most two generated-purpose IDs from
  `inbox-draft`, `proposal`, `activity`, and `spec-entity`, and retains the
  128-node receipt ceiling. A package-private Wiki seam forces the reviewed
  create ID during exact cross-process re-plan; no executable plan or handle
  becomes portable.
- Once product E ships, direct `mex wiki propose` and `mex wiki apply` reject
  Spec-family creates/targets, type conversions, inline replacements, hidden
  batch items, and `.mex/specs/**` writes. Non-Spec Wiki administration and
  declared migration/maintenance remain separately gated.
- Inbox capability descriptors use stable public request/preview `$ref` roots
  and name the static `mex inbox contract --json` resolver. Those roots require
  the resolver catalog; its bounded repository-independent envelope contains
  the complete strict schemas, both examples, exact apply-envelope requirement,
  and unchanged Team exit table even before repository readiness.
- Relay, Playbook, Catch Up, new MCP, agent, Git mutation, hosted, and direct
  Wiki/Spec editing surfaces remain outside E.

## Relay handoff product boundary

Checkpoint F is the final repository-native handoff surface in this program.
Its exact contract is recorded in
[`relay-handoff-contract.md`](relay-handoff-contract.md).

- A Relay moves only from checkout-local draft to published, acknowledged, and
  closed. Published handoff content is immutable; there is no decline,
  withdrawal, reassignment, reopen, administrative override, notification,
  external delivery, or agent execution.
- Draft reads and writes remain local, sparse-input tolerant, and
  authority-independent. They require recipients and summary only; optional
  structured collections normalize to arrays. A legacy local-draft Workstream
  becomes entity evidence without a read-side SQLite rewrite.
- Publication binds one active sender and one to 32 active Member recipients to
  the local draft plus recipient-only exact revision set. It neither resolves
  nor depends on a Workstream. Any listed active recipient may win the single
  acknowledgement claim; only the active recorded sender or active claimant
  may close.
- New Relay artifacts use strict schema v3, omit Workstream, and store
  service-owned `published_at` plus `published_repo_state` copied from signed
  authority. Dirty, detached, and null-HEAD publication states are valid and
  honest, but do not capture source bytes. Strict schema-v1/v2 artifacts retain
  their Workstreams, remain byte-preserving and actionable, and are never
  backfilled with current checkout state. Every teammate must update MEX before
  a repository begins publishing strict v3 artifacts.
- A v3 `relay.published` Activity omits Workstream and uses the same publication
  repository state. Take and Close preserve that state while their Activity
  records the action-time repository observation. Legacy lifecycle Activity
  retains the legacy Relay's Workstream association.
- The internal facade and registered CLI use a Relay-specific signed portable
  receipt. Draft, Relay, and Activity IDs are purpose-bound so exact envelopes
  apply across processes; actor, repository, dependency, containment, and
  revision checks repeat under the workflow lease before publication and in
  intent recovery.
- `mex relay` exposes bounded local-draft and canonical reads plus explicit
  preview/apply mutations. Its complete strict request and envelope schemas live
  in the repository-independent static resolver; ordinary capabilities retain
  the existing schema version and byte ceiling.
- The authenticated private Hub adds only the six Relay API routes and a lazy
  workbench. `For you` is the actionable recipient/claimant queue; `Sent`,
  `Team`, and `Drafts on this device` remain explicit perspectives. Without
  active Member authority, Team and draft reads stay available while canonical
  actions fail honestly. Workstream filtering remains a legacy v1/v2 read
  compatibility surface only.
- The deterministic release fixture adds two Members, one local Relay draft,
  and one published Relay while reusing one existing Activity slot. Relay route
  assets, two list APIs, and browser heap are the only ordinary F calibration
  leaves; unrelated budgets remain frozen.

Checkpoint F does not add Playbooks, Catch Up, package-root exports, new MCP,
Git mutation, GitHub or other network integration, hosted behavior, or any
delivery mechanism. Workstreams remain an independent product surface.

## Explicit exclusions

Do not implement as part of this program:

- Context Compiler, Context Plans, Context Packets, delta packets, or Task State;
- agent context injection;
- changes to code-graph retrieval or ranking;
- automatic knowledge promotion;
- background semantic reconciliation or dreaming;
- scheduled agents or continuous model work;
- automatic contradiction claims;
- centralized team code graphs;
- authentication, permissions, SSO, or multi-tenancy;
- CRDT or multiplayer editing;
- raw transcript storage;
- executable Playbooks;
- new team MCP tools;
- Docker, Compose, remote Hub exposure, or hosted MEX behavior;
- Git staging, commits, pushes, checkouts, or branch creation by the MEX product.

The last item constrains runtime product behavior. It does not prevent normal
developer branching and commits explicitly requested for this implementation.

## Checkpoint status

Checkpoint 0 is closed with:

- source revision pins and ownership record;
- shared application contracts and stable required error codes;
- complete Wiki read projections, bounded relation APIs, and explicit index
  refresh/rebuild methods;
- typed operation metadata with engine-owned operation and migration payloads;
- populated behavior mock and legacy fixture;
- reusable Wiki conformance suite;
- pinned Wiki engine implementation and repository adapter;
- mock and real-adapter conformance registrations with no skips;
- protocol-v3 graph golden regressions;
- explicit exclusions and integration-owner assignment.

Production consumers use the repository adapter. The mock remains a bounded
test double for consumer behavior, not an alternate storage or mutation
implementation. Checkpoint 2's completed read-only Hub integration is recorded
in [`hub-wiki-readonly.md`](hub-wiki-readonly.md).

Checkpoint B is closed with a consumer-owned `TeamWorkflowPort` conformance
suite registered against the real filesystem, Git adapter, SQLite local state,
canonical repositories, behavioral Wiki, and repository Wiki adapter. The
suite covers filtering and bounds, preview/apply, authority capture, exact
revision coverage, idempotent replay, all four journal phase boundaries,
tamper/root/containment failures, lease contention, journal privacy, two-clone
portability, real Wiki approval, and interrupted Wiki batch recovery. Product
Checkpoint C adds a second consumer-owned conformance suite for member and
Activity reads, signed cross-process preview/apply, v1-v4 apply-side migration,
actor fallback, local-selection privacy, immutable recorded actors, exact
replay, contention, two-clone convergence, and source truncation. Checkpoint D
adds bounded Workstream lifecycle and cross-process preview/apply coverage plus
fresh-only Spec projection tests against the real Wiki adapter. Checkpoint E1
adds the internal governed Inbox/Spec service and real repository conformance,
including local drafts, portable proposals, exact Spec create/update approval,
stale/repair, crash recovery, containment, privacy, and two-clone transfer. E2
registers the guarded CLI and bounded static contract resolver, E3 registers the
private Hub and lazy Inbox workbench, and E4 adds the deterministic fixture plus
release measurements. Inbox's numeric release candidates are pinned from the
retained Ubuntu report, and a clean enforcing CI run is required without
widening earlier thresholds. F1 adds the signed Relay facade, strict
schema-v1/v2/v3 artifact lifecycle, and real repository conformance; F2
registers the guarded
CLI and bounded static resolver; F3 registers the private Hub and lazy Relay
workbench; F4 adds the deterministic two-Member/Relay fixture and owned release
measurements. Relay numeric candidates require retained pinned provenance and a
separate clean enforcing run. Playbook and Catch Up remain assigned to later
checkpoints.

## Verification commands

```bash
npx vitest run test/wiki-port-mock.contract.test.ts
npx vitest run test/wiki-port-real.contract.test.ts
npx vitest run test/team-workflow-port-real.contract.test.ts
npx vitest run test/team-identity-activity-real.contract.test.ts
npx vitest run test/team-inbox-spec-authoring-real.contract.test.ts
npx vitest run test/team-relay-handoff-real.contract.test.ts
npx vitest run src/team/workflow/__tests__/repository-team-workstreams.test.ts
npx vitest run src/team/specs
npx vitest run src/graph/__tests__/protocol-v3-golden.test.ts
npm run typecheck
npm test
npm run build
```
