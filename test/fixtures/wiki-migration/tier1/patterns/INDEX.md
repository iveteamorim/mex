---
name: pattern-index
description: "Lookup table for Harbour's pattern files."
last_updated: 2026-03-14
---
# Pattern Index

A stored message is matched to a thread by its reply headers, falling back
to a subject-and-participant match when those headers are missing. The
fallback is generous on purpose, because a missed join is the worse error.

## Patterns

Each ticket is assigned to exactly one queue. The rules run in declaration
order and the first match wins, with an explicit catch-all last, so there
is always an owner and an operator can predict the outcome.

Outbound replies go through a single sender that owns rate limiting and
bounce handling. Nothing else talks to the mail provider, so changing
provider touches one module and the credentials it reads.

## Adding a row

Modules are named for the noun they own rather than the layer they sit in.
A module called ticket owns tickets, and there is no manager, service or
helper variant of it hiding the same behaviour under a second name.

An error carries the identifier of the thing that failed and nothing else.
No stack strings in messages and no chains rewrapped at every layer, so a
reader can tell what broke without reconstructing how it was caught.

## Removing a row

Configuration is read from the environment with no defaults for anything
that addresses a real system. A missing variable fails at startup naming
itself, rather than defaulting to something that silently half-works.

The work queue is a table in the same database as everything else. That
costs throughput nobody is currently asking for and buys one thing to
back up, one thing to restore, and one place a stuck job can be found.

## Keeping it honest

Operators reassign rather than share. Cross-team tickets move between
queues, which means reassignment has to be one action and has to leave a
trail that answers who moved it and when.

Every test names the behaviour it protects in its title. A test that
cannot fail is deleted rather than kept for coverage, and one that needs
two fixtures to explain itself is usually testing two things.
