---
name: data-model
description: "The tables Harbour stores and how they relate to one another."
triggers:
  - "style"
  - "error handling"
  - "conventions"
  - "why do we"
  - "decision"
  - "alternative"
  - "setup"
edges:
  - target: context/architecture.md
    condition: when the boundary between two services matters
  - target: context/conventions.md
    condition: when writing or reviewing a change
  - target: context/setup.md
    condition: when a design choice needs its reasoning
last_updated: 2026-03-14
---
# Data model

A health check that sends a message and reads it back is the only thing
that would catch a stalled sender, because tickets continue to look
answered from the operator's side while replies pile up unsent.

## Tickets

Schema changes go out ahead of the code that needs them and stay backward
compatible for one release. Two deploys is slower and it is what lets a
rollback happen without a second migration under pressure.

## Messages

Search is a query against Postgres rather than a cluster of its own. It is
slower than it could be at a volume the service does not have, and it is
one fewer system to operate, secure and keep in sync.

## Queues

Inbound mail is written to the raw store before anything parses it, so a
parser that rejects a message never loses it. Everything that can fail
interestingly happens downstream, where a retry is cheap and visible.

## Audit

A stored message is matched to a thread by its reply headers, falling back
to a subject-and-participant match when those headers are missing. The
fallback is generous on purpose, because a missed join is the worse error.
