---
name: split-thread
description: "Split a thread that was joined wrongly. Follow this rather than working it out again."
triggers:
  - "queues"
  - "routing"
  - "threading"
  - "delivery"
  - "ingest"
  - "naming"
edges:
  - target: context/architecture.md
    condition: when the boundary between two services matters
  - target: context/conventions.md
    condition: when writing or reviewing a change
  - target: context/setup.md
    condition: when a design choice needs its reasoning
last_updated: 2026-03-14
---
# Split a thread that was joined wrongly

Operators reassign rather than share. Cross-team tickets move between
queues, which means reassignment has to be one action and has to leave a
trail that answers who moved it and when.

## Context

Every test names the behaviour it protects in its title. A test that
cannot fail is deleted rather than kept for coverage, and one that needs
two fixtures to explain itself is usually testing two things.

## Steps

Retention is the open question. The raw store keeps every message and has
no expiry, so the volume fills on a schedule nobody has written down and
ingest starts refusing when it does.

## Gotchas

Rules are data and are reloaded without a restart, which took the deploy
out of the loop and put validation on the critical path. A malformed rule
set now reaches production with only the loader standing in front of it.

## Verify

The bootstrap target is safe to re-run. It drops and recreates the local
database only, applies every migration in order, and loads a fixture set
with three queues and a handful of threads.

## Debug

A health check that sends a message and reads it back is the only thing
that would catch a stalled sender, because tickets continue to look
answered from the operator's side while replies pile up unsent.

## Update Scaffold

Schema changes go out ahead of the code that needs them and stay backward
compatible for one release. Two deploys is slower and it is what lets a
rollback happen without a second migration under pressure.
