# Relay Handoff Contract

Status: 0.8.1 team-audience and Member recovery extension in progress; pinned release enforcement remains gated

This brief freezes the repository-native Relay product: a checkout-local draft
becomes one canonical handoff, one eligible recipient takes it, and the original
sender or claimant closes it. A Relay is standalone team memory. It can carry
structured progress and related context, but it does not belong to a Workstream,
deliver messages, start agents, notify external systems, or execute work.

Repositories publishing open-to-team schema-v4 Relays must use the 0.8.1-capable
CLI across the team. Older binaries cannot parse this new strict format.
Existing schema-v1, v2, and v3 Relays retain their original named recipients
and are never rewritten or backfilled.

## Lifecycle and authority

The only lifecycle is `local draft -> published -> acknowledged -> closed`.
The Hub calls acknowledgement **Take handoff**. Published content, recipients,
sender, and publication context are immutable. There is no decline, withdrawal,
unclaim, reassignment, reopen, administrative override, or direct close from
`published`.

Draft reads and save/update/delete are checkout-local. They require no current
Member, Git identity, Wiki index, Workstream service, GitHub access, or network
request. A new draft requires only:

- an intended audience and an optional selection of up to 32 unique Member
  recipients (an empty array is valid locally); and
- a non-empty bounded, single-line summary.

The optional `completed`, `inProgress`, `decisions`, `blockers`,
`unresolvedQuestions`, `changedFiles`, `code`, `evidence`, and `nextActions`
collections normalize immediately to arrays. Normalization happens before
command hashing, preview, persistence, and publication, and canonical reads
always return arrays. Decisions, files, code, commits, entity references,
external HTTP(S) URLs, and manual notes are related context, not authority or
freshness dependencies. A Relay may be published without any of them.

Runtime compatibility parsing accepts the old local-draft `workstream` field,
removes it, and prepends equivalent entity evidence unless the same evidence is
already present. Reads do not rewrite SQLite. An explicit Save writes the
translated payload; Publish consumes the translated form. A legacy draft with
64 evidence entries may use one migration-only 65th slot for this prepended
Workstream entity. Caller-authored evidence and every other shape remain capped
at 64 entries.

Publication resolves the current actor to one active canonical Member, through
either the explicit checkout-local selection or one unique active Git alias. It
also proves that every named recipient is active. An explicit `team` audience
requires an empty recipient array and only the exact local draft revision.
A `members` audience requires one to 32 named recipients at publication; an
omitted audience retains this legacy meaning. Its exact expectation set is the
local draft revision plus every unique recipient Member revision: no Workstream,
duplicate, omission, semantic revision, or unrelated target is accepted. The
same facts are checked under the repository workflow lease immediately before
publication and when an unpublished intent is recovered.

Any listed active recipient may Take a named Relay. An open-to-team Relay allows
any current active project Member, including one who joined after publication.
Exact Relay-revision
conflict semantics make the first successful acknowledgement the sole claimant.
Two unsynchronized clones can still attempt claims and later encounter a Git
conflict; Relay does not provide a global network lock. Close requires
`acknowledged`; the active recorded sender or active recorded claimant may
close, and both recorded principals must remain active. Closing only removes
the handoff from open attention and does not complete or modify a Workstream or
task. Authorization compares stable `memberId` values, never display names or
whole actor objects. Legacy Git, unknown, or inactive principals remain
readable but cannot act. Explicit `member.reactivate` restores an inactive
Member with the same ID through a revision-bound preview/apply and one
`member.reactivated` Activity. Alias collisions and stale state fail closed;
reactivation never rewrites recorded actors or changes local Member selection.

## Canonical artifacts and Activity

Relay artifacts are a strict schema-discriminated union:

- schema v1 requires `workstream` and has neither `published_at` nor
  `published_repo_state`;
- schema v2 requires `workstream` and `published_at`, with no
  `published_repo_state`;
- schema v3 rejects `workstream` and requires both `published_at` and
  `published_repo_state`;
- schema v4 has the same standalone publication context, requires
  `audience: team`, and requires an empty recipient array.

Named publications still write schema v3; open-to-team publications write v4.
Their public Hub and CLI projections expose `schemaVersion: 1 | 2 | 3 | 4`,
optional `audience`, `workstream: EntityRef | null`, and
`publishedRepoState: RepoState | null`. Legacy v1/v2 values retain their
recorded Workstream and return no publication repository state. V3 returns a
null Workstream and its immutable publication state. Acknowledge and Close
preserve the original schema and publication fields byte-for-byte.

The canonical `published_repo_state` object is copied exactly from the signed
publication authority's existing repository observation:

```json
{
  "branch": "feature/handoff",
  "head": "0123456789abcdef0123456789abcdef01234567",
  "dirty": true,
  "observedAt": "2026-08-30T10:15:30.000Z"
}
```

`branch` and `head` may each be null, honestly representing detached or unborn
states. Publishing from a dirty working tree is valid. The preview warns that
MEX recorded only that local changes existed; it did not record their paths,
diff, or contents. HEAD identifies committed state only, so this metadata is
not a reproducible source snapshot. Preview/apply revalidation detects branch,
HEAD, or clean/dirty changes, but cannot detect dirty tree A changing into dirty
tree B.

Publication writes the v3 or v4 Relay and exactly one `relay.published` Activity
before deleting the exact local draft. That Activity has the Relay as subject,
omits Workstream, and records the same timestamp and repository state as the
Relay publication. Take and Close each write exactly one Activity with their
own action-time repository state; they never change `publishedRepoState`.
Lifecycle Activity for legacy v1/v2 Relays retains the recorded Workstream.
Service-owned authority supplies time, actor, branch, HEAD, dirty state, IDs,
and Activity bytes.

MEX observes Git read-only. Relay never stages, commits, pushes, pulls, creates
branches, inspects remotes, stores a repository root or remote URL, or makes a
network request. The human or external test harness publishes generated Relay
and Activity files through Git.

## Signed portable operations

The internal facade exposes `getRelayDraft`, `listRelayDrafts`, `getRelay`,
`listRelays`, `previewRelay`, and `applyRelay`. Its closed action union contains
only draft save/delete, publish, acknowledge, and close.

Relay receipts retain schema version 1 and the independent signing domain
`mex.team.relay.receipt.v1`. The aggregate envelope is limited to 64 KiB; the
receipt to 8 KiB, depth eight, 128 nodes, two generated purposes, 30 minutes of
age, and five seconds of future clock skew. A valid stored draft can therefore
still receive a typed envelope-too-large preview failure.

Generated purposes are exact and canonically sorted:

- new draft: `relay-draft`;
- draft update/delete: none;
- publish: `activity`, `relay`;
- acknowledge/close: `activity`.

Apply accepts only the complete signed envelope, revalidates its presentation,
purpose IDs, authority, root, repository state, and exact dependencies, and
retains generic workflow journaling, lease, containment, recovery, replay, and
privacy guarantees. A signer lost before intent requires a new preview; once
intent exists, bounded journal effects authenticate exact recovery.
Pre-v3 Publish requests or signed previews with a Workstream dependency fail
closed with guidance to preview again. An interrupted operation that already
created durable intent recovers its previously recorded exact bytes instead of
being reinterpreted as v3.

## CLI and agent discovery

The registered machine tree is `mex relay contract --json`, `mex relay draft
list|show|save|delete`, `mex relay list|show`, `mex relay publish`, `mex relay
acknowledge`, and `mex relay close`. Mutations preview a caller-authored JSON
request and apply only the complete successful wrapper through
`--apply <preview-envelope>`; request fragments, altered wrappers,
reconstructed receipts, and mismatched action commands are rejected before a
repository service is opened.

New local drafts also support `mex relay draft save --from <draft.json>
[--operation-id <id>] --json`. The bounded file contains only sparse draft
content. Omitted audience and recipient fields default to open-to-team; an
explicit named audience remains named even when its local recipient selection
is empty. The shortcut performs the same signed preview/apply internally and
requires a preview that only creates one local draft. It cannot publish, update,
or delete. Before applying, it saves the exact preview in an owner-only file
under `.mex/local/relay-previews/`; new saves stop at 64 occupied entries,
each limited to 64 KiB. Recovery permits one additional private staging file
left between atomic publication and cleanup. Staging files remain inert and
count against new-save capacity. Successful saves remove their exact pending file.
Interrupted saves retain it and can resume using the same operation ID and
unchanged content, or the returned exact `--apply` command. Conflicting requests
never replace an existing receipt. This content remains checkout-local and is
excluded from Git; it is not added to the metadata-only workflow journal.

Because Relay was not merged to `origin/main`, included in a release tag, or
externally released before v3 implementation, the pre-release request/catalog
v1 identifiers are updated in place. The static resolver still publishes
`https://mex.dev/contracts/team-relay-request-v1.json` and
`https://mex.dev/contracts/team-relay-preview-envelope-v1.json`, along with the
full command inventory, standalone sparse examples, runtime-only invariants,
and Team exit codes. It works without Git, Home state, or `.mex`, is capped at
64 KiB, and is included in packed installs. Ordinary
`mex capabilities --json` advertises only the `team_relay` availability record
and compact `relay.contract` resolver descriptor.

## Reads and perspectives

Canonical reads accept `mine | sent | all`, lifecycle states, the legacy-only
Workstream filter, limit, and a revision/filter-bound cursor. The service
default is `all`. `mine` includes a published Relay addressed to the current
Member and an acknowledged or closed Relay claimed by that Member. `sent`
compares recorded sender `memberId`. Without an active current Member, `mine`
and `sent` return `UNAUTHORIZED`; `all` and local draft operations remain
available.

The `workstreamId` filter matches only schema-v1/v2 Relays. Standalone v3
Relays never match it. Filters run before pagination. Timestamped Relays sort
by `publishedAt` descending and ID descending; legacy null timestamps follow,
ID descending. Drafts sort by `updatedAt` and ID descending. Cursors bind
perspective, state, legacy Workstream filter, current Member, filter, and
corpus revision.

## Two-clone acceptance

The repository conformance flow uses two ordinary clones. Alice publishes a
standalone v3 Relay, then commits and pushes its Relay and Activity files. Bob
pulls, Takes the handoff, commits, and pushes. Alice pulls and Closes it. The
test asserts that the original publication branch, HEAD, dirty flag, and
observation time remain unchanged across all three states, while publication,
Take, and Close Activity each retains its own action-time repository state.
No Workstream artifact, lookup, dependency, or Activity association participates
in the flow. Git mutations belong exclusively to the test harness, never the
Relay service.

## Bounds, errors, and exclusions

Relay retains the workflow foundation's 64 KiB artifact, 2,048-record,
32 MiB corpus, 4,096-directory-entry, 100-result, 100-diagnostic, 4 KiB cursor,
512-local-draft, 8 KiB summary, 4 KiB item, and 64-entry structured collection
bounds, except the single migration-only evidence slot described above. The
recipient bound is 32. Local draft identifiers use the checkout-local ASCII
identifier grammar and are limited to 128 bytes.

Malformed lifecycle or dependency sets use `VALIDATION_FAILED`; absent targets
use `NOT_FOUND`; changed authority or revision uses `REVISION_CONFLICT`; absent
Member authority or the wrong principal uses `UNAUTHORIZED`. Reads never
initialize or migrate local state, rebuild Wiki/Graph data, invoke a model, or
make outbound requests.

This contract adds no GitHub integration, Git mutation, multi-repository
identity, notification, external delivery, MCP tool, packaged skill, Workstream
page change, agent execution, package-root export, or hosted coordination.
