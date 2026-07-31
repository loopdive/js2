---
id: 3918
title: "Two #2161 equivalence cases are red on main and unowned — plain-object arg, and undefined element passed to a string param"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: type-coercion
goal: core-semantics
sprint: current
horizon: m
es_edition: multi
related: [2161, 3901]
---

# #3918 — two `#2161` cases fail on `main` today, with no owner

## Status: open — pre-existing, confirmed on unmodified `main`

## Problem

Two cases in the `#2161` test batch fail on `main`:

- **`#2161 B1`** — a plain-object argument
- **`#2161 B0`** — an `undefined` element passed to a string parameter

They are not new. The `issue-3901-split-alloc` agent hit them while validating
its own change, suspected itself, and **verified they reproduce identically on
unmodified `main`** by swapping its codegen files back out. So they are red in
the tree right now and nothing in this batch of work caused them.

The reason this is worth a ticket rather than a footnote: they sit in a
targeted batch that agents run routinely as a pre-commit sanity check. Two
permanently-red cases in a batch people are told to run is corrosive — the next
agent either wastes time re-deriving that they are pre-existing (as #3901 did),
or learns to ignore red in that batch, which is worse.

## Scope

1. Reproduce both on a clean checkout of `main` and record the exact assertion
   output in this issue.
2. Establish whether they ever passed — check the history around #2161. If they
   were green and regressed, bisect; if they were never green, the batch was
   committed with known failures and that should be stated.
3. Fix, or if the expectation itself is wrong, correct the expectation and say
   so explicitly.

## Acceptance criteria

1. Both cases pass, **or** the test file is corrected with a written
   justification for why the old expectation was wrong.
2. No remaining permanently-red cases in that batch.
3. If they were a silent regression, the issue names the commit.

## Notes

Found by `issue-3901-split-alloc` during #3901. It correctly did not fold a fix
into its own PR — the cases are unrelated to `split`/`replace` lowering, and
bundling them would have made its diff harder to review and to revert.
