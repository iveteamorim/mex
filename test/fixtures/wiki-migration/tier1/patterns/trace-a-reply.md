---
name: trace-a-reply
description: "Trace a reply that never reached the customer. Follow this rather than working it out again."
triggers:
  - "why do we"
  - "decision"
  - "alternative"
  - "setup"
  - "environment"
edges:
  - target: context/architecture.md
    condition: when the boundary between two services matters
  - target: context/conventions.md
    condition: when writing or reviewing a change
last_updated: 2026-03-14
---
# Trace a reply that never reached the customer

A health check that sends a message and reads it back is the only thing
that would catch a stalled sender, because tickets continue to look
answered from the operator's side while replies pile up unsent.

## Context

Schema changes go out ahead of the code that needs them and stay backward
compatible for one release. Two deploys is slower and it is what lets a
rollback happen without a second migration under pressure.

## Steps

Search is a query against Postgres rather than a cluster of its own. It is
slower than it could be at a volume the service does not have, and it is
one fewer system to operate, secure and keep in sync.

## Gotchas

Inbound mail is written to the raw store before anything parses it, so a
parser that rejects a message never loses it. Everything that can fail
interestingly happens downstream, where a retry is cheap and visible.

## Verify

A stored message is matched to a thread by its reply headers, falling back
to a subject-and-participant match when those headers are missing. The
fallback is generous on purpose, because a missed join is the worse error.

## Debug

Each ticket is assigned to exactly one queue. The rules run in declaration
order and the first match wins, with an explicit catch-all last, so there
is always an owner and an operator can predict the outcome.

## Update Scaffold

Outbound replies go through a single sender that owns rate limiting and
bounce handling. Nothing else talks to the mail provider, so changing
provider touches one module and the credentials it reads.
