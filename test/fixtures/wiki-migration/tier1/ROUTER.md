---
name: router
description: "Session bootstrap and navigation hub for the Harbour ticketing service."
triggers:
  - "architecture"
  - "request flow"
  - "boundaries"
  - "queues"
  - "routing"
  - "threading"
  - "delivery"
  - "ingest"
  - "naming"
  - "style"
  - "error handling"
  - "conventions"
edges:
  - target: context/architecture.md
    condition: when the boundary between two services matters
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
  - target: context/testing.md
    condition: when adding or changing a test
  - target: context/operations.md
    condition: when running the service in anger
  - target: context/glossary.md
    condition: when a term is used without definition
  - target: context/data-model.md
    condition: when the shape of stored data matters
  - target: context/integrations.md
    condition: when a third party is involved
  - target: context/security.md
    condition: when the change touches credentials
  - target: context/performance.md
    condition: when latency or volume is the concern
  - target: patterns/INDEX.md
    condition: at the start of a task, to find a matching pattern
last_updated: 2026-03-14
---
# Session Bootstrap

Inbound mail is written to the raw store before anything parses it, so a
parser that rejects a message never loses it. Everything that can fail
interestingly happens downstream, where a retry is cheap and visible.

## Reading order

A stored message is matched to a thread by its reply headers, falling back
to a subject-and-participant match when those headers are missing. The
fallback is generous on purpose, because a missed join is the worse error.

Each ticket is assigned to exactly one queue. The rules run in declaration
order and the first match wins, with an explicit catch-all last, so there
is always an owner and an operator can predict the outcome.

## Routing table

Outbound replies go through a single sender that owns rate limiting and
bounce handling. Nothing else talks to the mail provider, so changing
provider touches one module and the credentials it reads.

Modules are named for the noun they own rather than the layer they sit in.
A module called ticket owns tickets, and there is no manager, service or
helper variant of it hiding the same behaviour under a second name.

## Working agreement

An error carries the identifier of the thing that failed and nothing else.
No stack strings in messages and no chains rewrapped at every layer, so a
reader can tell what broke without reconstructing how it was caught.

Configuration is read from the environment with no defaults for anything
that addresses a real system. A missing variable fails at startup naming
itself, rather than defaulting to something that silently half-works.
