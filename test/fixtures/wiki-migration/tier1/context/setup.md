---
name: setup
description: "Preparing a machine to run and test Harbour locally."
triggers:
  - "retention"
  - "stack"
  - "dependency"
  - "version"
  - "testing"
  - "fixtures"
  - "operations"
  - "runbook"
  - "on call"
edges:
  - target: context/architecture.md
    condition: when the boundary between two services matters
  - target: context/conventions.md
    condition: when writing or reviewing a change
  - target: context/decisions.md
    condition: when preparing a development machine
  - target: context/stack.md
    condition: when a library version is in question
last_updated: 2026-03-14
---
# Setup

Schema changes go out ahead of the code that needs them and stay backward
compatible for one release. Two deploys is slower and it is what lets a
rollback happen without a second migration under pressure.

## Prerequisites

Search is a query against Postgres rather than a cluster of its own. It is
slower than it could be at a volume the service does not have, and it is
one fewer system to operate, secure and keep in sync.

Inbound mail is written to the raw store before anything parses it, so a
parser that rejects a message never loses it. Everything that can fail
interestingly happens downstream, where a retry is cheap and visible.

## First-time setup

A stored message is matched to a thread by its reply headers, falling back
to a subject-and-participant match when those headers are missing. The
fallback is generous on purpose, because a missed join is the worse error.

Each ticket is assigned to exactly one queue. The rules run in declaration
order and the first match wins, with an explicit catch-all last, so there
is always an owner and an operator can predict the outcome.

## Environment variables

Outbound replies go through a single sender that owns rate limiting and
bounce handling. Nothing else talks to the mail provider, so changing
provider touches one module and the credentials it reads.

Modules are named for the noun they own rather than the layer they sit in.
A module called ticket owns tickets, and there is no manager, service or
helper variant of it hiding the same behaviour under a second name.

## Running the workers

An error carries the identifier of the thing that failed and nothing else.
No stack strings in messages and no chains rewrapped at every layer, so a
reader can tell what broke without reconstructing how it was caught.

Configuration is read from the environment with no defaults for anything
that addresses a real system. A missing variable fails at startup naming
itself, rather than defaulting to something that silently half-works.

## Loading fixtures

The work queue is a table in the same database as everything else. That
costs throughput nobody is currently asking for and buys one thing to
back up, one thing to restore, and one place a stuck job can be found.

Operators reassign rather than share. Cross-team tickets move between
queues, which means reassignment has to be one action and has to leave a
trail that answers who moved it and when.

## Common issues

Every test names the behaviour it protects in its title. A test that
cannot fail is deleted rather than kept for coverage, and one that needs
two fixtures to explain itself is usually testing two things.

Retention is the open question. The raw store keeps every message and has
no expiry, so the volume fills on a schedule nobody has written down and
ingest starts refusing when it does.
