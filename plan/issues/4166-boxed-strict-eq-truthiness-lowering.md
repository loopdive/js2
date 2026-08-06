---
id: 4166
title: "perf: boxed strict-eq / truthiness helpers are 7.1% of the standalone acorn parse — `__extern_strict_eq` 3.7% + `__is_truthy` 3.1% self-time, and no issue owned this bucket"
status: ready
sprint: current
created: 2026-08-06
updated: 2026-08-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
goal: performance
related: [4157, 4155, 743, 3926]
origin: "2026-08-06 post-campaign CPU profile (#4157, PR #4143) — one of two measured buckets with no owning issue"
---

# #4166 — boxed strict-eq / truthiness lowering

## Problem (measured, not estimated)

The 2026-08-06 post-campaign profile of the standalone acorn parse (39,586
samples over 48.4 s, 144.2 ms/op; full table in the umbrella
`plan/issues/4157-close-the-acorn-node-performance-gap.md`) attributes
**7.1% of total self-time** to the dynamic-equality bucket:

- `__extern_strict_eq` — 3.7%
- `__is_truthy` — 3.1%

**Top payer: `parseSubscript`'s `===` chain.** acorn compares tokens and node
types constantly (`this.type === tt.name`, `node.type === "Identifier"`), and
every comparison whose operands are boxed goes through the generic helper.

No issue owned this bucket before this one — it is one of the two costs the
profile surfaced that the whole #4157 program had no line item for.

## Direction (verify against source before implementing)

Two independent angles, both cheaper than typing the values (which is #743's
long game):

1. **Lower the comparison, not the operands.** A `===` whose two sides are
   both known-boxed can dispatch on cheap identity first (same ref → true)
   and on unboxed tag pairs (`ref.test` both sides for the same variant →
   compare payloads directly) before falling back to the generic helper.
   The helper itself may also be a ladder that can hash/br_table like
   #3926's `__extern_get`.
2. **Truthiness at branch sites.** `__is_truthy` calls at `if`/`&&`/`!` sites
   whose operand is a boxed value with a statically-known variant subset can
   inline the two-or-three-instruction test instead of the call. Measure how
   many of the 3.1% sites have single-variant operands before building.

## Acceptance criteria

- [ ] The dynamic-eq bucket's self-time drops from 7.1% on the profile
      driver (`scripts/profile-buckets.mjs`, landed with PR #4143), or the
      issue records measured evidence for why it cannot.
- [ ] `standaloneDynamic` A/B (3 back-to-back pairs) reported with std —
      per the #4157 measurement rules; a wash gets recorded, not stretched.
- [ ] No behavioral change: `===`/`!==`/truthiness semantics pinned by the
      equivalence suites (loose-equality, strict-equality-edge-cases,
      logical-operators files) before and after.

## Dupe check

#3926 is the same *shape* of fix (ladder → hashed dispatch) applied to a
different helper; no overlap in code. #743 would remove the need by unboxing
the values — long-horizon, not a reason to leave 7.1% on the table now.
