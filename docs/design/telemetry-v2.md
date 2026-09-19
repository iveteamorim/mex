# MEX 0.8.1 telemetry

Branch: `codex/0.8.1-telemetry`, based on release commit `d64f171`.
This change targets `codex/0.8.1`; it does not authorize merging to main.
Draft PR: [#188](https://github.com/mex-memory/mex/pull/188).
The initial implementation and retained measurements are from `9cbfab8`.
The subsequently approved project-context additions are locally verified in
their separate addendum below; new full and platform CI remains required.

## Product questions and measurement definitions

The shared random installation UUID is explicitly approved for CLI and Hub.
The user subsequently approved restoring the existing scaffold UUID and adding
configured AI-tool names. An installation remains the repeat-use unit; multiple
installations using one scaffold provide a shared-project signal. This cannot
establish people, organizations, team membership, or team size. Agent-generated
command activity is included and cannot be reliably separated from human
invocations, and configured tools do not identify the invoking agent.

| Question | Definition |
| --- | --- |
| Which features get used? | Unique installations and completed invocations by `command`, or explicit Hub `action`; keep CLI/Hub source and stage visible. Report raw volume alongside unique installations so agent loops do not dominate adoption. |
| Where do operations fail? | Failures / completions for the same command/action/job kind and stage. Report job results separately from successful job-start requests. Invalid input rejected before dispatch is outside this denominator. |
| Are new installations activated? | First observed meaningful completion or Hub page visit, followed by a successful knowledge/graph use or applied contribution/Relay. “First observed” is not guaranteed first install because delivery is opt-out and best effort. |
| Do installations return? | UTC day-1/day-7 retention after first meaningful activity: another qualifying activity on that exact later day. Offer a separate rolling-week measure rather than calling both D7 retention. |
| Is use habitual? | DAU/WAU and DAU/MAU of qualifying installation activity; also active days per installation per week. Use completed calendar windows and original event timestamps. |
| Is the Hub useful? | Returning installations with page navigation or explicit actions; views by category; successful apply and terminal job outcomes. A session start, idle timer, polling request, or SSE reconnect is not active use. |
| Does a project appear to be shared? | During the last 28 completed UTC days, count distinct installation IDs with qualifying activity per nonempty `scaffold_id`. Two or more is a shared-project estimate. For an adoption percentage, divide qualifying scaffold IDs with at least two installations by all observed qualifying scaffold IDs; report missing-context coverage separately. |
| Which AI integrations are configured? | Break down observed project/installation activity by membership in `configured_ai_tools`. Label this configured-tool adoption, not actual agent usage. Selections can overlap, so percentages need not sum to 100%; state whether the denominator is distinct installations or distinct scaffold IDs. |

Qualifying CLI engagement is a completed product operation, including a failed
attempt. Exclude `commands`, `completion`, `feedback`, `log`, `heartbeat`,
`doctor`, `check`, `watch`, and launcher-only `mex`/`tui` from the primary
engagement view; keep them in diagnostic feature-use reports. This is an
analysis filter, not a claim about whether an action was automated. CLI
`preview` counts intent but not an applied change. Hub `replayed: true` applies
count as invocations, not additional mutations. CLI completion does not expose
replay detail, so CLI invocations must not be presented as unique mutations.

Shared-project estimates can overcount one person's several machines or copied
scaffolds that retain an ID, and undercount users sharing one installation.
Reset installation IDs also change the count. A scaffold UUID has no embedded
name, but anyone with access to a project's config can associate it with that
project. Do not present the signal as verified team accounts or anonymized
project identities. Missing context is unknown, not a new or single-user
project.

`configured_ai_tools` is the saved project selection: `claude`, `codex`,
`copilot`, `cursor`, `opencode`, and/or `windsurf`. Several selections are valid;
the payload uses a sorted, unique array of at most six names. No running
processes, parent shells, editor sessions, or account data are inspected. The
selection can be stale or differ from the agent actually invoking MEX.

Do not join voluntary research contact details to installation IDs. The CLI
and Hub open the same hosted form without identifiers in URL parameters.
The form fields and follow-up consent are managed outside this repository.

## Implementation

- `src/telemetry/schema.ts` defines the complete vocabulary and reconstructs
  allowlisted payloads. All six events accept optional `scaffold_id` and
  `configured_ai_tools`; a scaffold ID must be exactly a UUIDv4, and tool values
  come from the six-name catalog. Stored events are revalidated before delivery.
  These are additive fields in unreleased schema v2; older queued v2 events
  without them remain valid.
- `src/telemetry/project-context.ts` reads bounded existing config bytes through
  a read-only, file-identity-checked snapshot. It never initializes, repairs, or
  mints project identity. Missing, malformed, unreadable, or unsafe config omits
  metadata; invalid IDs and unknown tool names are excluded. Ordinary CLI
  operations reuse one snapshot, while setup/init reread at completion for newly
  saved configuration. The Hub binds a snapshot to its project on the first
  enabled event; subsequent config changes appear after Hub restart. No project
  names, Git remotes, paths, content, or contact details enter that projection.
  Graph maintenance/status metadata follows the exact selected root, honoring
  local `--root` before the parent option; Hub metadata also uses its exact root.
  A missing nested scaffold never falls back to an unrelated ancestor identity.
  Other CLI operations retain nearest-Git-root discovery.
- `src/cli-telemetry.ts` uses registered Commander ancestry, derives a closed
  stage value, and completes each action once. Action errors retain exit codes
  and output while allowing bounded telemetry cleanup. TUI/watch launcher
  completion describes startup, not eventual session termination.
- `src/hub/telemetry.ts` projects validated server actions. A strict, authenticated
  page-category POST is capped at 128 bytes and 60 events/minute. Browser requests
  have one in-flight operation and a two-second timeout. Query/hash changes,
  polling, normal reads, fixture APIs, and repeated renders stay silent.
- Owned jobs emit a terminal outcome once after durable terminal-state storage;
  reading or reconciling historical jobs does not create another completion.
- The per-user SQLite outbox uses zero busy wait, capped rows/bytes/age/file size,
  rollback journals, and expiring claims. No graph database is opened or rebuilt.
  The existing lazy SQLite adapter avoids loading native SQLite for opt-outs.
- Node HTTP sends fixed-origin batches with no SDK retries or detached process.
  CLI flush has a default 25 ms grace, capped at 50 ms for internal callers;
  Hub batches every 15 seconds with a two-second request timeout. Cancellation
  destroys sockets and cancels the dedicated DNS resolver.
- Explicit opt-out persists before queue cleanup and reports a busy/unavailable
  purge honestly. Its dedicated marker survives unrelated stale preference writes;
  only explicit enable removes it. Inspection never creates identities, repairs queues, or sends.

The complete privacy and delivery contract is [TELEMETRY.md](../../TELEMETRY.md).
Public package exports, emitted root declaration bytes, graph/Wiki protocols,
and repository artifact schemas are unchanged. `posthog-node` is removed from
production dependencies. The published package now includes `TELEMETRY.md`. The transport follows the documented
[PostHog capture API](https://posthog.com/docs/api/capture).

## Performance verification

The methodology below applies to future comparison runs. The retained results
are historical evidence for `9cbfab8`, before optional project context. The new
reader and added payload fields have separate measurements recorded in the
validation addendum.

The standalone benchmark runs actual built CLI entry points from process spawn
through natural close. It pairs a preserved release build with this candidate,
interleaves conditions, and compares telemetry off, healthy loopback delivery,
connection refusal, and a server that accepts requests but never responds.
Success (`mex commands`) and failure (`mex check --json` outside a project) are
both covered, along with pristine-home initialization. Repeated invocations
verify queued completion accounting, output/exit compatibility, bounded request
cleanup, and offline retention.

The harness redirects only the fixed telemetry ingestion origin to loopback
using a test-only Node preload, blocks other egress, and leaves the production
entry point unchanged. It does not measure internet/TLS latency; a separate
transport deadline test covers cancellation. These local measurements are
characterization, not a new portable release budget.

Run after preserving a baseline build and completing other heavy checks:

```sh
npm run benchmark:telemetry:test
npm run benchmark:telemetry -- --baseline /absolute/baseline/dist/cli.js --output test-results/telemetry.json
```

### Historical measured result: `9cbfab8`

[Retained evidence](telemetry-performance-results.json) includes raw samples and
paired differences. On the local Apple M4 / Node 22.17.1 host, each of 16 CLI
groups completed five warmups and 20 measured invocations. Times below are
paired enabled-minus-disabled differences, in milliseconds.

| Command result | Healthy p50 / p95 | Refused p50 / p95 | Hanging p50 / p95 |
| --- | --- | --- | --- |
| Success | 3.084 / 17.811 | 4.408 / 20.586 | 27.294 / 48.884 |
| Failure | 7.806 / 18.022 | 6.377 / 24.638 | 22.797 / 31.600 |

The short successful command's absolute median was 357.033 ms disabled,
360.396 ms with healthy local ingestion, and 386.629 ms with hanging ingestion.
The older implementation took 1029.530 ms with hanging ingestion; the paired
median improvement was 644.888 ms. The new failure path adds outcome capture
where the old process exited without delivering an event.

Capture-call p95 was at most 2.410 ms, with first queue initialization at most
3.210 ms. The longest observed flush was 29.114 ms, including local cleanup and
scheduling around the 25 ms network grace. These observed times are not hard
wall-clock guarantees on arbitrary disks, hosts, or schedulers.

Every tested healthy candidate command accounted for all 25 starts and 25
completions across warmups and samples, with an empty queue afterward. Refused
and hanging conditions retained all 50 events per command in a 45,056-byte
store, with no active delivery claim left. All processes exited naturally with
expected output/status, no sockets remained, and disabled pristine homes stayed
empty. Receipt and acknowledgement are distinguished; UUID set union prevents
received-but-still-queued events from being counted twice.

Internet/TLS latency and production delivery rates are not measured by the
loopback benchmark. Short-only usage can defer events repeatedly until enough
runtime is available for a send or a Hub session drains the queue. The local
measurements cover backlogs up to 50 events; maximum-cap queue timing is not
claimed. The initial implementation validation record follows below.

## Historical Verify Checklist: `9cbfab8`

These results belong to the original telemetry implementation, before the
scaffold/tool follow-up. They remain retained evidence, not a pass for the
current working tree.

1. **Public surface/declarations — pass.** `src/index.ts` and root emitted declaration bytes are unchanged; telemetry remains internal.
2. **Read and write safety — pass.** Pure reads skip capture; page input is authenticated and bounded; queued data is revalidated; explicit opt-out owns preference/cleanup.
3. **Deterministic bounds — pass.** Event vocabulary, request body/rate, queue rows/bytes/age/file size, claim life, requests and network grace are bounded. Tests include malformed data, unsafe paths, large SQLite pages, concurrent writers, active opt-out and real stalled DNS.
4. **Tests/typecheck — pass.** Final `npm test -- --maxWorkers=2`: 222 files, 3,500 passed, one skipped (657.24 seconds), with no concurrent build. Hub web: 434 passed. Playwright: two passed (Home screenshot/accessibility and production-Hub integration). Workspace typecheck and standalone benchmark harness (four tests) pass. The actual CLI benchmark passes. The first full run exposed two old-API architecture assertions and one aggregate containment timeout; the guard now covers the actual capture boundary, and the five containment fixtures run independently with their original assertions/timeouts.
5. **Packaging/evaluator — pass.** Full build and fresh packed-install/Project Hub/official-skills smoke pass. The packaged CLI hash matches the retained benchmark candidate. No evaluator or graph protocol change requires a new evaluator run.
6. **Diff and scope — pass.** `git diff --check` passes. Changes are limited to telemetry, feedback, supporting tests/CI and documentation. Generated indexes, checkout local state and dist remain unstaged; the real graph database hash is unchanged.
7. **Graph/Wiki protocols — pass.** Existing command, application-adapter, golden protocol, immutable-read and Hub integration suites pass. No graph/Wiki protocol, error, ordering, cursor, or maintenance contract changed. macOS/Windows CI and the pinned release-performance gate remain required before release.

## Project-context validation addendum

The follow-up adds only optional existing scaffold UUID/configured-tool context.
Its baseline is the initial telemetry revision `9cbfab8`, whose Node 22/24,
macOS/Windows, browser and release-performance CI all passed in run
`34361480149`. Those results are historical; the follow-up has separate local
checks and requires new CI before merge.

[Retained project-context measurements](telemetry-project-context-performance.json)
compare the preserved `9cbfab8` build against candidate CLI SHA-256
`99ebd1b40c434de47bcfdbe5db74af43a5be27afa84c96d0bc401cbdb52e067b`.
The Apple M4 / Node 22.17.1 run used five warmups and 20 samples for each of 16
groups, plus pristine-home and module probes. Pass `--project-context` to the
benchmark command above: this creates an isolated existing scaffold/tool
configuration and uses a deliberate missing source path for the failed check.

The enabled metadata helper measured p95 **0.221 ms** with healthy ingestion,
**0.210 ms** with refused connections and **0.659 ms** with hanging ingestion.
Capture-call p95 was at most **2.466 ms**, first capture at most **3.351 ms**,
and the longest observed flush was **29.130 ms**.

Whole-process timing was noisy, so it does not establish zero overhead or a
speedup. These are paired candidate-minus-`9cbfab8` differences in milliseconds:

| Command result | Disabled p50 / p95 | Healthy p50 / p95 | Refused p50 / p95 | Hanging p50 / p95 |
| --- | --- | --- | --- | --- |
| Success | -12.129 / 4.260 | 7.895 / 86.162 | -13.317 / -0.500 | 1.304 / 88.612 |
| Failure | -3.250 / 89.533 | -22.682 / 11.645 | -4.699 / 72.043 | -16.031 / 3.420 |

The disabled comparison itself includes a roughly 90 ms p95 difference, where
project config is not read. Retain this noise rather than treating positive
tails as measured metadata cost or negative medians as an optimization. The
module probe isolates the small metadata cost; the full CLI run verifies real
process cleanup, outputs and delivery under the tested conditions. These are
local observations, not a portable latency guarantee.

Every received and queued event passed exact existing UUID/tool checks and
private-field rejection. All processes exited naturally, sockets and delivery
claims were cleared, disabled pristine homes stayed empty, and canonical
fixture bytes were unchanged. Healthy success accounted for all 50 events;
healthy failure received 49 and retained the final completion locally, for a
50-event union. Refused/hanging queues retained 50 events in 49,152 bytes. This
also verifies the documented best-effort delivery boundary. All timing samples
are retained without event/installation/scaffold IDs or private fixture values.

1. **Public surface/declarations — pass.** `src/index.ts` is unchanged, and the final build's root declaration bytes match the preserved `9cbfab8` build. The new reader and metadata types remain internal.
2. **Read and write safety — pass.** Metadata reads never mint identity or modify project state. Opt-outs skip discovery; unavailable or unsafe config omits context. Tests cover nested projects, exact Graph/Hub roots, parent/local Graph option precedence, read-only inspection, setup completion refresh and independent Hub snapshots.
3. **Deterministic bounds — pass.** Discovery is capped at 64 ancestors and 64 KiB of config. Only an existing UUIDv4 and at most six known, sorted, unique tool names survive projection. File identity, UTF-8, schema, symlink/junction and hardlink checks remain enforced. Queue and transport bounds are unchanged.
4. **Tests/typecheck — pass.** This follow-up passed 353 distinct tests across 15 files covering schema, reader, capture, CLI, Hub wiring/actions/jobs, delivery, capabilities, feedback and architecture. The final root-attribution correction was rechecked with 142 tests across six files, followed by workspace typecheck. Seven standalone benchmark-harness tests pass. The previous full regression, web and browser counts above belong to `9cbfab8`; no new full-suite result is claimed here.
5. **Packaging/evaluator — pass for the changed scope.** Full build passes, and the final built CLI is exercised by the dedicated latency harness. Package layout, dependencies and frontend assets are unchanged by this follow-up; the initial packed-install smoke remains historical evidence. No evaluator or Graph protocol change requires another evaluator run.
6. **Diff and scope — pass.** `git diff --check` passes, including the retained benchmark report. Source, tests, CI and docs are the intended changes; generated indexes, local state and dist remain excluded. The real graph database still matches its pre-change SHA-256 `0b6dd1f8e161f19e4a15111f125a83d2245f01c01e791f21e38f2c8a4a61af41`.
7. **Graph/Wiki protocols — pass for the changed scope.** No Graph/Wiki payload, error, ordering, cursor or maintenance implementation changed. The focused CLI/capability/immutable-read regressions pass; the attribution correction changes only which safe telemetry context is selected. Fresh full and platform CI remains required before merge.

## Windows DNS test correction

At `e725551`, CI run `34375530581` passed Node 22/24, macOS portability,
browser and release-performance checks. Windows passed 522 tests and skipped
three; one real DNS cancellation test measured 174.8385 ms against its 150 ms
elapsed limit. The new scaffold/tool tests passed on Windows.

That test used a 10 ms sleep to assume dispatch had reached its loopback DNS
server. It now waits for the first observed UDP query and confirms it is still
pending before timing `flush`. This removes setup ambiguity without changing
the 25 ms production grace, 150 ms elapsed assertion, real `ECANCELLED` result,
stopped-query assertion or retained-event check. No production code changed.
The original log does not isolate whether cold setup, scheduling or local
cleanup caused its elapsed overrun; a fresh Windows run must verify the fix.

1. **Public surface/declarations — pass.** Test/documentation-only correction; public source and built declarations are unchanged.
2. **Read/write safety — pass.** Real DNS remains pinned to a loopback blackhole. Cancellation and retained queue assertions are preserved.
3. **Bounds — pass.** Existing runtime and elapsed bounds are unchanged; waiting for the first query has a one-second setup guard.
4. **Tests/typecheck — pass locally.** All 45 delivery tests and workspace typecheck pass. Windows verification is pending the new CI run.
5. **Packaging/evaluator — not affected.** No runtime, packaging, asset or evaluator changes; the retained built-CLI measurements remain applicable.
6. **Diff/scope — pass.** `git diff --check` passes. Only the delivery test, this validation record and the telemetry test guidance changed.
7. **Graph/Wiki protocols — not affected.** No Graph/Wiki code, database, protocol, error or maintenance change.
