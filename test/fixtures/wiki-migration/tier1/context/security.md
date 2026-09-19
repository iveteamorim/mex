---
name: security
description: "How Harbour handles credentials, access and customer data."
triggers:
  - "setup"
  - "environment"
  - "first run"
  - "risk"
  - "failure mode"
  - "capacity"
edges:
  - target: context/architecture.md
    condition: when the boundary between two services matters
  - target: context/conventions.md
    condition: when writing or reviewing a change
  - target: context/setup.md
    condition: when a design choice needs its reasoning
last_updated: 2026-03-14
---
# Security

The work queue is a table in the same database as everything else. That
costs throughput nobody is currently asking for and buys one thing to
back up, one thing to restore, and one place a stuck job can be found.

## Credentials

Operators reassign rather than share. Cross-team tickets move between
queues, which means reassignment has to be one action and has to leave a
trail that answers who moved it and when.

## Access

Every test names the behaviour it protects in its title. A test that
cannot fail is deleted rather than kept for coverage, and one that needs
two fixtures to explain itself is usually testing two things.

## Customer data

Retention is the open question. The raw store keeps every message and has
no expiry, so the volume fills on a schedule nobody has written down and
ingest starts refusing when it does.

## Audit trail

Rules are data and are reloaded without a restart, which took the deploy
out of the loop and put validation on the critical path. A malformed rule
set now reaches production with only the loader standing in front of it.
