# Inbox-Governed Spec Authoring Contract

> **0.8.1 extension:** Inbox also accepts explicit contributions to existing
> project knowledge. The additive contract below supersedes the Spec-only
> product scope; the original Spec format and its safety rules remain supported.

## 0.8.1 knowledge contributions

Inbox is the deliberate proposal/review path into canonical Wiki knowledge.
It adds no knowledge category and does not require routine GROW or ordinary
non-Spec Wiki upkeep to go through review.

- `knowledge.create` accepts `entityKind` (architecture, component, convention,
  decision, pattern, guide), title, body, optional summary/topics, and status
  (`in_flight` or `promoted`). MEX mints the ID and path: patterns use
  `patterns/<id>.md`; other kinds use `context/<kind>-<id>.md`.
- `knowledge.update` accepts one exact `target` (id, kind, optional title) and a
  nonempty `patch` of title, summary, or body. A target can be an existing
  document or section. The existing dependency revision rules apply.
- Knowledge creates have no relation editor. The closed legacy Spec relation
  rules below still apply to existing Spec workflows.
- New knowledge requests use `mex.team.inbox.knowledge-change.v1`; existing
  `mex.team.inbox.spec-change.v1` bytes are not migrated. The compatibility-named
  private types, receipt domain, and `spec-entity` minted-ID receipt purpose are
  retained for both create families. These are implementation tokens, not UI
  categories.
- Approval carries a proposal source link and captured evidence into knowledge;
  corrections append sources while retaining prior attribution and grounding.
  Publication-time author and reviewer remain distinct in proposal history.
- The Inbox skill searches existing Wiki records before creating a duplicate.
  `mex inbox target <entity-id> --json` provides a bounded immutable projection
  of target text and exact `version.contentHash`/`semanticRevision` values.
- Local drafts are checkout-only. Publishing creates proposal Markdown in the
  working tree. Approval writes canonical knowledge and review/audit artifacts.
  Commit/push/pull remain the Git sharing steps.

Existing bounds, exact preview/apply, containment, stale/repair, recovery, and
legacy Spec guards below continue to apply. The default Hub composer now uses
knowledge contributions, while older Spec drafts and proposals retain their
original review path.

Status: Checkpoints E1-E4 implemented; pinned calibration applied and enforcing CI required

This brief freezes the minimum product boundary for checkout-local Inbox drafts,
portable canonical proposals, and explicitly reviewed Spec changes. E0 remains
the locked contract. E1 implements the internal repository service, exact Wiki
authoring seams, and real consumer conformance; E2 registers the CLI, capability
resolver, and direct-Wiki bypass guard; E3 registers the private Hub and lazy
Inbox workbench; and E4 implements deterministic fixtures and release
measurement. Numeric Inbox budgets still require a retained pinned Ubuntu
characterization report followed by a green enforcing rerun.

The authority order, repository pins, provisional-package policy, canonical
ownership rules, stable errors, and exclusions in
[`human-team-memory-contract-lock.md`](human-team-memory-contract-lock.md)
remain controlling. This document narrows the generic Checkpoint B workflow
foundation into one product-only Team Inbox facade. It does not expose the
generic workflow port or the Wiki engine's mutation payloads.

## Scope and ownership

Checkpoint E has one ordinary product path:

```text
typed Spec change
  -> checkout-local Inbox draft
  -> canonical portable Inbox proposal
  -> exact signed approval preview
  -> human-approved apply
  -> Wiki-owned canonical Spec bytes
```

- `TeamWorkflowPort` remains the canonical writer for `.mex/inbox/**`, the
  associated Activity record, and local Inbox draft state.
- The repository Wiki adapter remains the canonical writer for `.mex/specs/**`
  and `.mex/events/operations.jsonl`.
- Drafts remain checkout-local under `.mex/local/team.db*` and are ignored by
  Git. Publishing creates a canonical proposal before deleting the exact local
  draft revision.
- Proposals contain declarative, authority-free intent. They never contain an
  executable patch plan, process handle, caller-supplied actor, timestamp, or
  repository state.
- All ordinary MEX product-initiated Spec mutations require Inbox publication,
  explicit preview, and approval. Declared migration and maintenance remain
  separate, explicitly gated administrative workflows; they do not become
  Inbox authoring shortcuts.
- The product does not stage, commit, push, check out, or create a branch.

Relay, Playbook, manual Playbook run, and Catch Up behavior is not part of this
checkpoint. The existing read-only `mex spec list|show` and Hub Specs workspace
remain read-only projections; they do not become an alternate authoring path.

## Product facade and lifecycle

The internal E service is a narrow facade, not a newly public package-root API.
It provides:

- `getInboxDraft` and `listInboxDrafts` with separate summary and detail
  projections;
- `getInboxProposal` and `listInboxProposals` with separate summary and detail
  projections;
- `previewInbox(command)` returning one signed, human-readable exact envelope;
- `applyInbox(envelope)` accepting only that complete successful envelope.

List projections never include full bodies, evidence, or diffs. A draft summary
contains its service-minted ID, update time, exact local revision, change kind,
target or proposed entity kind, and a bounded rationale excerpt. A proposal
summary contains its `proposal_` ID, lifecycle state, author/reviewer summary,
change kind, target or proposed entity kind, canonical path and revision, and a
rationale excerpt capped at 240 UTF-8 bytes. The draft excerpt has the same
240-byte ceiling. Detail reads contain the strict bounded proposal or draft
fields required for review.

The facade accepts only these workflow actions:

- `inbox.draft.save` creates or exact-revision updates one local draft;
- `inbox.draft.delete` exact-revision deletes one local draft;
- `inbox.publish` creates one pending canonical proposal and then deletes the
  exact local draft;
- `inbox.approve` applies the proposal's one reviewed Spec change and marks the
  proposal approved;
- `inbox.reject` records a required review rationale and marks a pending
  proposal rejected;
- `inbox.withdraw` marks a pending proposal withdrawn, with an optional bounded
  rationale;
- `inbox.mark-stale` changes only `pending -> stale`, and only when the service
  proves that an update target, topic endpoint, or create-time relation endpoint
  drifted from its exact published revision;
- `inbox.repair` replaces the declarative intent of only a stale proposal and
  changes `stale -> pending` while clearing prior review authority.

Approved, rejected, and withdrawn proposals are immutable. A failed approval
preview or apply writes nothing and does not implicitly mark a proposal stale.
Staleness is an explicit separately previewed and applied transition; the caller
cannot assert drift without the service proving it.

Every successful publish, approval, rejection, withdrawal, stale transition,
and repair emits exactly one immutable Activity event. Local draft save/delete
emits none.

## Exact minimum Spec change contract

Each draft and proposal carries exactly one non-batch product `SpecChange`. Its
complete union is:

- `spec.create`, mapped internally to one Wiki `create-entry`;
- `spec.update`, mapped internally to one Wiki `update-entry` and limited to
  `title`, `summary`, and `body`.

No other Wiki operation is part of E. Archive, post-create relation mutation,
source mutation, grounding mutation, property mutation, type conversion, move,
supersede, inline replacement, adoption, metadata, migration, regeneration, and
ordered batches are deferred. The product schema rejects a hidden adapter
`payload.operations` array at every nesting level rather than treating it as a
single change.

### Create

Create produces exactly one new file:

```text
.mex/specs/<service-minted-mx-id>.md
```

The caller supplies neither an entity ID nor a path. The service mints one
`mx_` ULID, derives the path from it, and pins the same ID into Wiki planning.
Create never adopts existing prose, inserts into an existing file, or embeds an
inline replacement. Allowed entity kinds are exactly:

- `spec`;
- `requirement`;
- `constraint`;
- `acceptance_criterion`.

Initial status is explicitly `in_flight` or `promoted`. Title and body are
required; summary is optional. Topics are a bounded typed collection and a
create may carry at most one hierarchy relation. Sources, groundings, and
arbitrary metadata are forbidden.

Every topic and create-time relation endpoint must already exist. The proposal
carries its exact semantic revision and exact containing-file SHA-256 revision;
a create cannot create an endpoint in the same proposal.

### Update

Update targets one existing Spec-family entity and changes at least one of
`title`, `summary`, or `body`. It cannot change kind, status, topics, relations,
sources, groundings, identity, path, or metadata. The proposal carries the
target's exact semantic revision and exact containing-file SHA-256 revision.

### Fresh exact view and hierarchy directions

Draft save/delete validates only the bounded product schema and exact local
draft revision. It remains usable and noninitializing when the Wiki index is
missing or stale.

Before returning any valid publish, repair, or approval preview, the service
opens one fresh immutable Wiki view, resolves every existing target, topic, and
create-time relation endpoint, proves the required Spec-family kinds, validates
every optimistic expectation, and revalidates that same view before release. A
mark-stale preview uses the same exact view to prove instead that at least one
published expectation no longer matches. Apply repeats the applicable proof
while holding the Team workflow lease and immediately before publication.
Index freshness never causes an implicit refresh, rebuild, migration, or model
invocation.

Only the four relation families already projected by Checkpoint D are accepted
at create time:

| Relation | Source kind | Target kind | Parent -> child projection |
|---|---|---|---|
| `derived_from` | `requirement` | `spec` | target -> source |
| `verified_by` | `acceptance_criterion` | `spec` or `requirement` | target -> source |
| `constrained_by` | any Spec-family kind | `constraint` | source -> target |
| `refines` | `requirement` | `requirement` | target -> source |

For relations stored on the newly created entity, the new entity must occupy
the source position required by this table. No other relation type or direction
is accepted.

## Exact portable preview and apply

`previewInbox` and `applyInbox` follow the C/D signed-envelope model with a
separate Inbox signing domain. The repository-local mode-0600 HMAC key may be
shared as key material, but the signed domain and envelope type are distinct.

The schema-v1 envelope contains:

- the exact authority-free `TeamInboxCommand` request;
- a public preview with validity, `canonical | local | mixed` scope, exact file
  changes, checkout-local changes, and bounded diagnostics;
- a receipt containing service-owned actor, time, branch, HEAD, dirty state,
  purpose IDs, request revision, presentation revision, and signed preview
  revision.

Purpose IDs are sorted, unique, limited to two (`maxPurposeIds = 2`), and the
receipt remains limited to 128 structural nodes (`maxReceiptNodes = 128`).
Their only purposes are `inbox-draft`, `proposal`, `activity`, and
`spec-entity`. The ceiling holds for every allowed action:
publish mints proposal plus Activity; Spec create approval mints Spec entity
plus Activity; local draft create mints only its draft ID; all other canonical
actions mint at most Activity.

The Wiki engine currently mints create IDs inside an opaque process plan. E
therefore requires one package-private Wiki preview seam that accepts the
receipt-pinned `spec-entity` ID. It is not exported through the Wiki port, CLI,
Hub, or package root. Cross-process apply verifies the HMAC and preview age,
proves current authority/repository state, forces the pinned ID, re-plans the
one Wiki change, and byte-compares the complete public preview and purpose IDs.
Any difference is a revision conflict. No opaque plan or handle crosses the
process boundary.

Apply accepts only a valid complete envelope no older than 30 minutes, with at
most five seconds of future clock skew. Exact replay is idempotent only within
the existing retained 256-operation journal window; altered operation-ID reuse
is a validation failure.

## Bounds

All ceilings are UTF-8 byte or count ceilings and are enforced before writes:

| Resource | Bound |
|---|---:|
| CLI request file / Hub mutation body / complete preview envelope | 64 KiB |
| Receipt | 8 KiB, depth 8, 128 nodes, 2 purpose IDs |
| Portable declarative Spec request | 32 KiB |
| CLI JSON structure | depth 32, 4,096 nodes |
| Declarative payload structure | depth 8, 1,024 nodes |
| Any declarative payload string / Spec body | 16 KiB |
| Title / summary / relation note | 512 B / 2 KiB / 2 KiB |
| Proposal rationale / review rationale / manual evidence note | 8 KiB / 8 KiB / 4 KiB |
| Topics / evidence / revision expectations | 64 each |
| Create-time hierarchy relation | 1 |
| Local draft / canonical proposal artifact | 64 KiB |
| Drafts per scaffold | 512 |
| Workflow effects / serialized effect metadata | 16 / 64 KiB |
| Canonical proposal records / corpus / directory entries | 2,048 / 32 MiB / 4,096 |
| CLI page default/max; Hub page default/max | 50/100; 25/100 |
| Cursor | 4 KiB |
| Hub diagnostics / complete JSON response | 50 / 1 MiB |

Operation IDs are canonical ASCII identifiers of at most 128 bytes. Proposal
and Spec IDs are exact prefixed ULIDs; local draft IDs are service-minted
canonical local identifiers. Revision expectation sets are unique and cover
every existing artifact, entity, topic, and create-time relation endpoint
touched by the action.

The 64 KiB envelope is an aggregate limit. A valid 64 KiB stored draft can
still receive a typed envelope-too-large failure at preview because exact Spec,
operation-ledger, proposal, and Activity diffs count toward that aggregate. No
approval diff, detail response, or diagnostic corpus is silently truncated into
an apparently approvable result.

## CLI surface

When E is implemented, the registered product command tree will be:

```text
mex inbox draft list [--cursor <cursor>] [--limit <n>] [--json]
mex inbox draft show <draft-id> [--json]
mex inbox draft save [request-file] [--apply <preview-envelope>] [--json]
mex inbox draft delete [request-file] [--apply <preview-envelope>] [--json]

mex inbox proposal list [--state <state>] [--cursor <cursor>] [--limit <n>] [--json]
mex inbox proposal show <proposal-id> [--json]
mex inbox proposal approve [request-file] [--apply <preview-envelope>] [--json]
mex inbox proposal reject [request-file] [--apply <preview-envelope>] [--json]
mex inbox proposal withdraw [request-file] [--apply <preview-envelope>] [--json]
mex inbox proposal mark-stale [request-file] [--apply <preview-envelope>] [--json]
mex inbox proposal repair [request-file] [--apply <preview-envelope>] [--json]

mex inbox publish [request-file] [--apply <preview-envelope>] [--json]
```

Preview requires the strict request file. Apply forbids a simultaneous request
file and consumes only the complete successful JSON envelope emitted by
preview. All commands retain the schema-v1 Team response envelope and existing
exit codes: `0` success, `1` validation, `2` usage, `3` unavailable, `4`
conflict, and `5` refused. Reads remain noninitializing.

There is no `mex spec create|update` command. Once E ships, both direct
`mex wiki propose` and `mex wiki apply` must reject:

- a create whose kind is any Spec-family kind;
- any operation whose primary target or relation endpoint resolves to a
  Spec-family entity;
- type conversion into or out of the Spec family;
- a supersede/inline replacement whose existing target or replacement is in
  the Spec family;
- any mutation path under `.mex/specs/**`;
- any hidden adapter `payload.operations` item matching these cases.

Non-Spec Wiki administration outside this boundary remains separately gated.
Declared migration/maintenance keeps its own explicit authority and cannot be
invoked as an ordinary product authoring bypass.

## Capability discovery

E2 adds two installed capability identities to capability
schema v1:

- `team_inbox` for bounded draft/proposal reads and the Inbox lifecycle;
- `spec_authoring` for the governed create/update product boundary.

Read, preview, and apply descriptors are advertised only after their concrete
root command and production service registrations exist. `team_inbox` draft
reads/save/delete and proposal reads depend only on safe repository Team state;
a missing or stale Wiki index never suppresses them. Publish, repair,
mark-stale, and `spec_authoring` approval additionally require a compatible
Wiki adapter, and their execution must open one exact Wiki-owned view. That
package-private authoring view may disregard drift solely under the
engine-reserved Team-owned Markdown roots, so publishing the reviewed proposal
and Activity does not invalidate its own approval. Every Wiki-owned path,
requested entity byte, index generation, root, and containment binding remains
strict; public Wiki reads and previews retain their ordinary whole-corpus
freshness semantics. Command arrays remain the exact source of partial
availability.

A compact `team.inbox.request.v1` and
`team.inbox.preview-envelope.v1` machine contract is discovered through the
static, repository-independent `mex inbox contract --json` resolver. The
capability manifest publishes stable public `$ref` roots and marks every Inbox
descriptor with that resolver; those roots are deliberately unusable until the
advertised resolver catalog is loaded. The bounded resolver envelope carries
the complete strict JSON Schema 2020-12 catalog, both request examples, the
exact-envelope apply requirement, and the exact Team exit table. The resolver
is advertised in every repository lifecycle state and never opens Git, `.mex`,
or the workflow service. Keeping this E-only catalog out of line preserves the
existing Team v1 examples and exit semantics while the complete
`mex capabilities --json` envelope remains within 32 KiB. Raw Wiki Spec
mutation is neither described nor advertised as Spec authoring.

E1 activates the internal real-adapter Inbox/Spec consumer conformance suite.
E2 advertises the installed capability, command descriptors, compact contract
roots, and their repository-independent resolver without weakening the 32 KiB
capability-discovery bound.

## Private Hub contract

E3 adds only these authenticated loopback Hub routes:

```text
GET  /api/v1/inbox/drafts
GET  /api/v1/inbox/drafts/:id
GET  /api/v1/inbox/proposals
GET  /api/v1/inbox/proposals/:id
POST /api/v1/inbox/operations/preview
POST /api/v1/inbox/operations/apply
```

Draft/proposal collection routes return summaries; detail routes return one
full bounded projection. Proposal lists accept the closed proposal-state enum;
all list routes use revision/filter-bound cursors. The dedicated mutation routes
use the same product command and envelope as the CLI rather than widening the
C/D Team-operation union.

E3 Hub capabilities add:

```text
inbox.read
inbox.draftMutation
inbox.proposalMutation
inbox.specApproval
```

`specApproval` is unavailable unless exact planning and apply dependencies are
ready. Home's Inbox count means actionable canonical proposals (`pending` plus
`stale`), never private local drafts. Unavailable reads have a reason and no
invented zero count.

All APIs retain loopback-only Host validation, one-use bootstrap sessions,
HttpOnly cookies, exact Origin, JSON content type, CSRF, no CORS/proxy trust,
bounded request/response validation, safe Problem Details, and `Cache-Control:
no-store`. Request bodies, proposal contents, and diffs are not logged.

## Hub workbench and accessibility

Checkpoint E3 changes only `/inbox` from its honest placeholder to a lazy
`InboxPage`. Relay and Playbook routes remain placeholders. Inbox has its own
navigation capability; it does not reuse a broad `team` switch.

The minimum desktop workbench has a local-draft rail, an actionable canonical
proposal queue, and selected detail/review content. It fetches at most 25
summaries initially, loads more explicitly, and fetches a full detail only on
selection. It does not preload every body or page.

- Draft authoring uses typed create/update fields; no raw JSON Wiki editor is
  exposed.
- Publish states that rationale, evidence, and change intent become canonical
  Git-trackable proposal content and that the exact local draft is removed only
  after publication.
- Approval displays immutable proposal fields, all exact Spec/operation-ledger/
  proposal/Activity diffs, captured actor/repository state, and preview digest.
- The final action says `Approve proposal and write Spec`; generic `Apply` copy
  is insufficient.
- Editing any field invalidates the prior preview.
- Dialogs and alert dialogs have programmatic titles/descriptions, visible
  labels, deterministic focus return, Escape behavior, and polite live status.
- Queue and draft selection are keyboard-operable and expose selected/current
  state without relying on color. Diff regions use labelled `<pre>` content and
  horizontal scrolling.
- Existing skip-link, route-change main focus, reduced-motion behavior, and the
  honest sub-1024-pixel desktop guard remain intact.

## Privacy, publication, and recovery

Pure Inbox reads do not create or migrate SQLite state, provision a signer,
touch canonical files, refresh an index, or invoke a model. Draft save/delete
also never opens, refreshes, or initializes the Wiki index. The first explicit
preview may provision only the repository-local signer after the complete
bounded envelope shape has passed validation; the first apply may initialize or
migrate local workflow state transactionally.

Before publish, draft content is local. Publish is an explicit privacy boundary
because request, rationale, and evidence become canonical. The Hub and CLI make
that consequence visible. Raw transcripts, prompts, source dumps, secrets,
credential URLs, process-local fields, and local absolute paths are rejected at
input and omitted from projections. The journal, receipt attestation, and Wiki
recovery manifest contain metadata only: IDs, paths, revisions, hashes,
authority, phases, and audit transitions—never request bodies, evidence, Spec
body, or diff text.

Approval preserves the existing publication order: Wiki-owned Spec and
operation-audit bytes publish before the proposal becomes approved; exact
workflow recovery then completes proposal state and Activity without
reconstructing an opaque plan. A bounded body-free manifest is persisted before
a non-atomic Wiki prefix can land. When nothing landed, restart requires a new
preview. When a prefix landed, recovery resumes only the exact operation ID and
proves every current and final byte, pinned generated ID, revision, and audit
transition. Divergent state fails closed.

## Performance and deterministic fixtures

Checkpoint E4 extends the deterministic small, medium, and large release
fixtures with exactly one checkout-local Inbox draft, one pending canonical
proposal, and a fresh root Spec/requirement/constraint/acceptance-criterion
slice under `.mex/specs/**`. Fixture IDs, contents, timestamps, Git identity,
and counts are fixed; indexes are built only during explicit fixture setup and
the browser makes no request outside the exact loopback Hub origin.

The release route manifest maps `/inbox` to the lazy `InboxPage`. Route
readiness asserts exact fixture draft/proposal content rather than only the
shell. The performance report records bounded
draft-list and proposal-list API reads plus `/inbox` browser heap for all three
profiles. It will not repeatedly apply a state-changing approval inside one
benchmark fixture.

Only affected route/API/asset candidates are characterized on the pinned
Ubuntu 24.04/Node 22 runner. Runtime budgets remain `ceil(p95 * 1.15)` and asset
budgets `ceil(bytes * 1.05)` from a retained healthy pinned report; unrelated
budgets are not widened and local wall-clock results are not calibration.

## Explicit non-goals

Checkpoint E does not add:

- archive, post-create relation mutation, source mutation, grounding mutation,
  property mutation, type conversion, move, supersede, inline replacement,
  adoption, raw Wiki payloads, hidden/explicit batches, arbitrary metadata,
  migration, or regeneration through Inbox;
- Relay authoring, acknowledgement, or closure;
- Playbook definitions, runs, or execution;
- Catch Up cursors, digests, narration, or actions;
- direct Spec or generic Wiki editing routes;
- new MCP tools, package-root team exports, remote Hub behavior, authentication
  systems, CRDT/multiplayer state, agents, automatic promotion/reconciliation,
  or background semantic work;
- Git staging, commits, pushes, checkouts, or branch creation.

E1 adds focused repository-contract, two-process portability,
failure-atomicity, containment, privacy, and two-clone coverage for the internal
service. E2-E4 add the HTTP security, accessibility, product fixture,
performance, packed-install, compatibility, capability, CLI, and Hub gates.
The exact Inbox asset, API, and heap candidates are calibrated from the
retained pinned Ubuntu report; clean enforcing CI remains mandatory while
every earlier threshold stays frozen.
