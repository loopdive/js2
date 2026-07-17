---
id: 3372
title: "Eliminate i32→f64 loop-condition churn in simple counted loops"
status: ready
created: 2026-07-17
updated: 2026-07-17
priority: low
feasibility: medium
reasoning_effort: high
task_type: optimization
area: codegen
language_feature: numeric-loops
goal: performance
sprint: Backlog
horizon: m
related: [908]
origin: "2026-07-17 split off from #908: the dead global read/drop half shipped (peephole Pattern 2b); this is the remaining numeric-representation-churn half"
---

# #3372 — Eliminate i32→f64 loop-condition churn in simple counted loops

## Problem

Split off from #908. The dead-value-traffic half of #908 (a discarded compound
assignment to a module global emitting `global.set N; global.get N; drop`) was
fixed by peephole Pattern 2b (`global.get N; drop` removal). This issue tracks
the remaining, distinct half: **unnecessary numeric-representation churn** in the
loop condition of a simple counted loop.

For:

```ts
let result = 0;
for (let i = 0; i < 10000; i++) {
  result += squared(10);
}
```

the loop condition `i < 10000` compiles to, every iteration:

```wat
local.get 0            ;; i (i32)
f64.convert_i32_s      ;; promote to f64
f64.const 10000
f64.lt
i32.eqz
br_if 1
```

The i32 counter is promoted to f64 for the comparison on every iteration. When
both the counter and the bound are integral and in i32 range, the comparison
could stay in i32 (`i32.lt_s` against an `i32.const` bound), avoiding the
per-iteration `f64.convert_i32_s`.

## Why this is separate from #908's shipped fix

Removing the dead `global.get; drop` is a provably-safe, local peephole (reading
a global is side-effect-free). Keeping the loop comparison in i32 is a
**structural, type-level** decision: it must prove the counter stays integral and
in-range across the loop, and choose an i32 representation for the bound. That is
higher-risk (float/int semantics, overflow, non-integral bounds) and is not a
peephole — it belongs in the loop/relational codegen or a dedicated analysis. It
was deliberately scoped out of the #908 PR to keep that change safe and minimal.

## Acceptance criteria

- [ ] A simple counted loop with an integral i32 counter and an integral,
      in-range bound emits an i32 comparison in the loop condition (no
      per-iteration `f64.convert_i32_s`), when it is safe to do so.
- [ ] Non-integral / out-of-range / float-typed bounds keep the current f64
      comparison (no semantic change).
- [ ] Equivalence tests confirm identical runtime results.

## Non-goals

- The dead-value-traffic removal (shipped in #908 as peephole Pattern 2b).
- General loop-strength-reduction or vectorization.
