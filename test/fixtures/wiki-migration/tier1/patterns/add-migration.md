---
name: add-migration
description: "Add and apply a database migration. Follow this rather than working it out again."
triggers:
  - "style"
  - "error handling"
  - "conventions"
  - "why do we"
  - "decision"
edges:
  - target: context/architecture.md
    condition: when the boundary between two services matters
  - target: context/conventions.md
    condition: when writing or reviewing a change
  - target: context/setup.md
    condition: when a design choice needs its reasoning
last_updated: 2026-03-14
---
# Add and apply a database migration

Configuration is read from the environment with no defaults for anything
that addresses a real system. A missing variable fails at startup naming
itself, rather than defaulting to something that silently half-works.

## Context

The work queue is a table in the same database as everything else. That
costs throughput nobody is currently asking for and buys one thing to
back up, one thing to restore, and one place a stuck job can be found.

## Steps

Operators reassign rather than share. Cross-team tickets move between
queues, which means reassignment has to be one action and has to leave a
trail that answers who moved it and when.

## Gotchas

Every test names the behaviour it protects in its title. A test that
cannot fail is deleted rather than kept for coverage, and one that needs
two fixtures to explain itself is usually testing two things.

## Verify

Retention is the open question. The raw store keeps every message and has
no expiry, so the volume fills on a schedule nobody has written down and
ingest starts refusing when it does.

## Debug

Rules are data and are reloaded without a restart, which took the deploy
out of the loop and put validation on the critical path. A malformed rule
set now reaches production with only the loader standing in front of it.

## Update Scaffold

The bootstrap target is safe to re-run. It drops and recreates the local
database only, applies every migration in order, and loads a fixture set
with three queues and a handful of threads.
