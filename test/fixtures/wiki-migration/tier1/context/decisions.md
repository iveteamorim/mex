---
name: decisions
description: "The choices Harbour has made and the reasoning behind each one."
triggers:
  - "risk"
  - "failure mode"
  - "capacity"
  - "retention"
  - "stack"
  - "dependency"
  - "version"
  - "testing"
  - "fixtures"
  - "operations"
  - "runbook"
edges:
  - target: context/architecture.md
    condition: when the boundary between two services matters
  - target: context/conventions.md
    condition: when writing or reviewing a change
  - target: context/setup.md
    condition: when a design choice needs its reasoning
  - target: context/stack.md
    condition: when a library version is in question
  - target: context/risks.md
    condition: when a failure mode is being weighed
last_updated: 2026-03-14
---
# Decisions

An error carries the identifier of the thing that failed and nothing else.
No stack strings in messages and no chains rewrapped at every layer, so a
reader can tell what broke without reconstructing how it was caught.

## Decision Log

Configuration is read from the environment with no defaults for anything
that addresses a real system. A missing variable fails at startup naming
itself, rather than defaulting to something that silently half-works.

The work queue is a table in the same database as everything else. That
costs throughput nobody is currently asking for and buys one thing to
back up, one thing to restore, and one place a stuck job can be found.

### Store raw mail before parsing it

**Date:** 2026-01-12
**Status:** Active
**Decision:** stated in one sentence, so a reader can stop here.
**Reasoning:** the constraint that made the alternative worse.

Operators reassign rather than share. Cross-team tickets move between
queues, which means reassignment has to be one action and has to leave a
trail that answers who moved it and when.

Every test names the behaviour it protects in its title. A test that
cannot fail is deleted rather than kept for coverage, and one that needs
two fixtures to explain itself is usually testing two things.

### One queue owns a ticket

**Date:** 2026-01-30
**Status:** Active
**Decision:** stated in one sentence, so a reader can stop here.
**Reasoning:** the constraint that made the alternative worse.

Retention is the open question. The raw store keeps every message and has
no expiry, so the volume fills on a schedule nobody has written down and
ingest starts refusing when it does.

Rules are data and are reloaded without a restart, which took the deploy
out of the loop and put validation on the critical path. A malformed rule
set now reaches production with only the loader standing in front of it.

### Queue rules are data, not code

**Date:** 2026-02-09
**Status:** Active
**Decision:** stated in one sentence, so a reader can stop here.
**Reasoning:** the constraint that made the alternative worse.

The bootstrap target is safe to re-run. It drops and recreates the local
database only, applies every migration in order, and loads a fixture set
with three queues and a handful of threads.

A health check that sends a message and reads it back is the only thing
that would catch a stalled sender, because tickets continue to look
answered from the operator's side while replies pile up unsent.

### Keep the work queue in Postgres

**Date:** 2026-02-16
**Status:** Active
**Decision:** stated in one sentence, so a reader can stop here.
**Reasoning:** the constraint that made the alternative worse.

Schema changes go out ahead of the code that needs them and stay backward
compatible for one release. Two deploys is slower and it is what lets a
rollback happen without a second migration under pressure.

Search is a query against Postgres rather than a cluster of its own. It is
slower than it could be at a volume the service does not have, and it is
one fewer system to operate, secure and keep in sync.

### Two-phase schema changes

**Date:** 2026-02-23
**Status:** Active
**Decision:** stated in one sentence, so a reader can stop here.
**Reasoning:** the constraint that made the alternative worse.

Inbound mail is written to the raw store before anything parses it, so a
parser that rejects a message never loses it. Everything that can fail
interestingly happens downstream, where a retry is cheap and visible.

A stored message is matched to a thread by its reply headers, falling back
to a subject-and-participant match when those headers are missing. The
fallback is generous on purpose, because a missed join is the worse error.

### Search without a search cluster

**Date:** 2026-03-02
**Status:** Active
**Decision:** stated in one sentence, so a reader can stop here.
**Reasoning:** the constraint that made the alternative worse.

Each ticket is assigned to exactly one queue. The rules run in declaration
order and the first match wins, with an explicit catch-all last, so there
is always an owner and an operator can predict the outcome.

Outbound replies go through a single sender that owns rate limiting and
bounce handling. Nothing else talks to the mail provider, so changing
provider touches one module and the credentials it reads.

### A single outbound sender

**Date:** 2026-03-06
**Status:** Active
**Decision:** stated in one sentence, so a reader can stop here.
**Reasoning:** the constraint that made the alternative worse.

Modules are named for the noun they own rather than the layer they sit in.
A module called ticket owns tickets, and there is no manager, service or
helper variant of it hiding the same behaviour under a second name.

An error carries the identifier of the thing that failed and nothing else.
No stack strings in messages and no chains rewrapped at every layer, so a
reader can tell what broke without reconstructing how it was caught.

### Reassign rather than share ownership

**Date:** 2026-03-09
**Status:** Active
**Decision:** stated in one sentence, so a reader can stop here.
**Reasoning:** the constraint that made the alternative worse.

Configuration is read from the environment with no defaults for anything
that addresses a real system. A missing variable fails at startup naming
itself, rather than defaulting to something that silently half-works.

The work queue is a table in the same database as everything else. That
costs throughput nobody is currently asking for and buys one thing to
back up, one thing to restore, and one place a stuck job can be found.

## Open questions

Operators reassign rather than share. Cross-team tickets move between
queues, which means reassignment has to be one action and has to leave a
trail that answers who moved it and when.

Every test names the behaviour it protects in its title. A test that
cannot fail is deleted rather than kept for coverage, and one that needs
two fixtures to explain itself is usually testing two things.

### Raw store retention

**Date:** 2026-03-11
**Status:** Open
Nothing has been decided here yet. The section exists so the question is
written down rather than rediscovered, and it names what would settle it.

Retention is the open question. The raw store keeps every message and has
no expiry, so the volume fills on a schedule nobody has written down and
ingest starts refusing when it does.

Rules are data and are reloaded without a restart, which took the deploy
out of the loop and put validation on the critical path. A malformed rule
set now reaches production with only the loader standing in front of it.

### Multi-region ingest

**Date:** 2026-03-13
**Status:** Open
Nothing has been decided here yet. The section exists so the question is
written down rather than rediscovered, and it names what would settle it.

The bootstrap target is safe to re-run. It drops and recreates the local
database only, applies every migration in order, and loads a fixture set
with three queues and a handful of threads.

A health check that sends a message and reads it back is the only thing
that would catch a stalled sender, because tickets continue to look
answered from the operator's side while replies pile up unsent.
