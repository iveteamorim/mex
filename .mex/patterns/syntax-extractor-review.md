---
name: syntax-extractor-review
description: Verify declarations and references against the vendored grammar and persisted graph, including deliberate resolution gaps.
triggers:
  - language extractor
  - C# extraction
  - tree-sitter grammar
edges:
  - target: context/conventions.md
    condition: when verifying extractor or resolver changes
grounds_to: []
last_updated: 2026-09-10
---

# Syntax extractor review

## Context

Read `docs/extractors.md` and the language entry in `docs/code-graph-support.md`.
The vendored WASM is the runtime contract; a successful parse alone does not
prove that declarations, ownership, or references are correct.

## Steps

1. Inspect actual grammar fields using the vendored binary before choosing
   declaration names or traversal boundaries.
2. Assert qualified names, containment, and reference owners. Reorder distinct
   declarations to check that their identities follow the symbols.
3. Preserve receivers in unresolved call names. Normalize member separators
   through grammar fields so comments and spacing do not change binding.
4. Verify both extracted references and persisted graph edges. A same-named
   lexical method cannot prove the target of an arbitrary object receiver.
5. Document remaining syntax and resolution limitations alongside the tests.

## Gotchas

- C# file-scoped namespace declarations own later root siblings; walking them
  again creates duplicate symbols outside the namespace.
- Operators need their tokens, conversions their target types, and destructors
  their `~` prefix. Static constructors use `static C` so reordering them with
  instance constructors cannot swap identities. Indexers have no name field and
  need bracketed signatures.
- Walk each field declarator's initializer under that field's ownership.
- Enum attributes precede identifiers; use the grammar name field.
- Interface bases are `extends`. The class base-list split remains heuristic.
- C# `this.M()` cannot bind to a local function named `M`. Unproven object,
  `base`, namespace, and alias qualifiers remain unresolved until semantic
  binding exists, including on inheritance and construction references.
- Keep the caller among C# call candidates: deleting it from an overload set
  can turn a recursive call into a confident edge to the wrong overload. Only
  an unambiguous lexical recursive target can produce a self edge.

## Verify

- Run `extractor-csharp.test.ts` and `engine-csharp.test.ts` for the concrete
  declaration, identity, ownership, and conservative-resolution regressions.
- Run shared graph regressions, typecheck, build, and evaluator checks. Confirm
  the packaged grammar matches its vendored source bytes.

## Debug

Trace a failing call through its extracted `targetName`, persisted receiver,
candidate containers, and final edge. Keep unresolved evidence when the target
cannot be proven; do not strip a receiver to force a match.

## Update Scaffold

Recorded during the 2026-09-10 PR #156 fixes. Source paths and tests above are
the evidence; graph anchors are intentionally absent because the available
checkout index belonged to another branch. Refresh only through explicit graph
maintenance before adding fingerprints. Update this pattern when another
grammar-specific traversal or binding failure is reproduced.
