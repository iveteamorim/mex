---
name: architecture
description: "How Harbour's pieces connect and how a message becomes a ticket."
triggers:
  - "why do we"
  - "decision"
  - "alternative"
  - "setup"
  - "environment"
  - "first run"
  - "risk"
  - "failure mode"
  - "capacity"
  - "retention"
  - "stack"
  - "dependency"
edges:
  - target: context/conventions.md
    condition: when writing or reviewing a change
  - target: context/setup.md
    condition: when a design choice needs its reasoning
  - target: context/decisions.md
    condition: when preparing a development machine
  - target: context/stack.md
    condition: when a library version is in question
  - target: context/risks.md
    condition: when a failure mode is being weighed
last_updated: 2026-03-14
---
# Architecture

The bootstrap target is safe to re-run. It drops and recreates the local
database only, applies every migration in order, and loads a fixture set
with three queues and a handful of threads.

## Ingest

A health check that sends a message and reads it back is the only thing
that would catch a stalled sender, because tickets continue to look
answered from the operator's side while replies pile up unsent.

### Acceptance

Schema changes go out ahead of the code that needs them and stay backward
compatible for one release. Two deploys is slower and it is what lets a
rollback happen without a second migration under pressure.

### The raw store

Search is a query against Postgres rather than a cluster of its own. It is
slower than it could be at a volume the service does not have, and it is
one fewer system to operate, secure and keep in sync.

### Enqueueing

Inbound mail is written to the raw store before anything parses it, so a
parser that rejects a message never loses it. Everything that can fail
interestingly happens downstream, where a retry is cheap and visible.

## Threading

A stored message is matched to a thread by its reply headers, falling back
to a subject-and-participant match when those headers are missing. The
fallback is generous on purpose, because a missed join is the worse error.

### Header matching

Each ticket is assigned to exactly one queue. The rules run in declaration
order and the first match wins, with an explicit catch-all last, so there
is always an owner and an operator can predict the outcome.

### The fallback

Outbound replies go through a single sender that owns rate limiting and
bounce handling. Nothing else talks to the mail provider, so changing
provider touches one module and the credentials it reads.

### Splitting

Modules are named for the noun they own rather than the layer they sit in.
A module called ticket owns tickets, and there is no manager, service or
helper variant of it hiding the same behaviour under a second name.

## Routing

An error carries the identifier of the thing that failed and nothing else.
No stack strings in messages and no chains rewrapped at every layer, so a
reader can tell what broke without reconstructing how it was caught.

## Delivery

Configuration is read from the environment with no defaults for anything
that addresses a real system. A missing variable fails at startup naming
itself, rather than defaulting to something that silently half-works.
