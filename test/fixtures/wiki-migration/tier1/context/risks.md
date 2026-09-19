---
name: risks
description: "Known risks in Harbour, what triggers each one, and what would reduce it."
triggers:
  - "version"
  - "testing"
  - "fixtures"
  - "operations"
  - "runbook"
  - "on call"
  - "architecture"
  - "request flow"
  - "boundaries"
edges:
  - target: context/architecture.md
    condition: when the boundary between two services matters
  - target: context/conventions.md
    condition: when writing or reviewing a change
  - target: context/setup.md
    condition: when a design choice needs its reasoning
  - target: context/decisions.md
    condition: when preparing a development machine
last_updated: 2026-03-14
---
# Risks

Rules are data and are reloaded without a restart, which took the deploy
out of the loop and put validation on the critical path. A malformed rule
set now reaches production with only the loader standing in front of it.

## Raw store growth

The bootstrap target is safe to re-run. It drops and recreates the local
database only, applies every migration in order, and loads a fixture set
with three queues and a handful of threads.

A health check that sends a message and reads it back is the only thing
that would catch a stalled sender, because tickets continue to look
answered from the operator's side while replies pile up unsent.

## Single outbound sender

Schema changes go out ahead of the code that needs them and stay backward
compatible for one release. Two deploys is slower and it is what lets a
rollback happen without a second migration under pressure.

Search is a query against Postgres rather than a cluster of its own. It is
slower than it could be at a volume the service does not have, and it is
one fewer system to operate, secure and keep in sync.

## Rule reload without validation

Inbound mail is written to the raw store before anything parses it, so a
parser that rejects a message never loses it. Everything that can fail
interestingly happens downstream, where a retry is cheap and visible.

A stored message is matched to a thread by its reply headers, falling back
to a subject-and-participant match when those headers are missing. The
fallback is generous on purpose, because a missed join is the worse error.

## Queue starvation

Each ticket is assigned to exactly one queue. The rules run in declaration
order and the first match wins, with an explicit catch-all last, so there
is always an owner and an operator can predict the outcome.

Outbound replies go through a single sender that owns rate limiting and
bounce handling. Nothing else talks to the mail provider, so changing
provider touches one module and the credentials it reads.

## Provider lock-in

Modules are named for the noun they own rather than the layer they sit in.
A module called ticket owns tickets, and there is no manager, service or
helper variant of it hiding the same behaviour under a second name.

An error carries the identifier of the thing that failed and nothing else.
No stack strings in messages and no chains rewrapped at every layer, so a
reader can tell what broke without reconstructing how it was caught.

## Operator error

Configuration is read from the environment with no defaults for anything
that addresses a real system. A missing variable fails at startup naming
itself, rather than defaulting to something that silently half-works.

The work queue is a table in the same database as everything else. That
costs throughput nobody is currently asking for and buys one thing to
back up, one thing to restore, and one place a stuck job can be found.
