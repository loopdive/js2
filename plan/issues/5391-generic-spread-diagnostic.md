---
id: 5391
title: "Reject unresolved generic object spread until runtime values are preserved"
status: in-review
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
parent: 5387
assignee: "ttraenkler/codex-unsoundness"
---

## Measured defect

Both overlapping and non-overlapping generic spreads miscompile. The control also fails, so the evidence establishes unsupported generic spread, not solely the intersection-unsoundness explanation from the article.

Base: `3bb59a816bbaf7`. Node.js 24.4.1 runs the type-erased source;
js2wasm is measured in JS-host and standalone modes. Exact baseline and candidate
rows are tracked by **#5387 — Audit TypeScript unsoundness hazards and reject
unsupported JavaScript semantics**.

## Reproductions

### generic-spread-intersection

```ts
function merge<T, U>(a: T, b: U): T & U { return {...a, ...b}; } const result = merge({x: 1}, {x: 'x'}); console.log(result.x + 1);
```

### generic-spread-control

```ts
function merge<T, U>(a: T, b: U): T & U { return {...a, ...b}; } const result = merge({x: 1}, {y: 2}); console.log(result.x + 1);
```

## Acceptance criteria

- [x] The confirmed divergence is repaired or refused with an actionable,
      source-located compiler diagnostic.
- [x] Safe controls retain JavaScript behavior.
- [x] Baseline/candidate measurements and implementation limits are recorded.

## Implementation

`src/compiler/structural-semantic-safety.ts` emits `JS2WASM_UNSUPPORTED_GENERIC_SPREAD` at spreads whose operand retains an unresolved type parameter. Both intersecting and disjoint generic spreads fail the measured baseline and are refused. Concrete object spread is unchanged.

## Validation

The committed [audit report](../audit/type-unsoundness-2026-09-08/README.md) contains exact source specimens, baseline/candidate rows, target-specific outcomes, and limits. Across 26 programs the candidate has 19 matching Wasm executions and 33 source-located refusals out of 52, with no remaining measured mismatches. Refusals are not counted as conformance passes. Dedicated regression tests cover this family and matching controls.
