---
id: 5390
title: "Reject unsupported mutations through widened arrays and object aliases"
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

Covariant array writes, widened optional-property aliases, and visible mutating calls can invalidate compiler type/refinement assumptions or lose shared-object mutation.

Base: `3bb59a816bbaf7`. Node.js 24.4.1 runs the type-erased source;
js2wasm is measured in JS-host and standalone modes. Exact baseline and candidate
rows are tracked by **#5387 — Audit TypeScript unsoundness hazards and reject
unsupported JavaScript semantics**.

## Reproductions

### array-variance-number-string

```ts
const a: number[] = [1]; const b: (number | string)[] = a; b[0] = 'x'; console.log(a[0] + 1);
```

### array-variance-string-number

```ts
const a: string[] = ['x']; const b: (number | string)[] = a; b[0] = 2; console.log(a[0] + 1);
```

### array-object-covariance

```ts
const a = [{ x: 1 }]; const b: { x: number | string }[] = a; b[0].x = 'x'; console.log(a[0].x + 1);
```

### callback-refinement-delete

```ts
function change(o: { x?: number }) { delete o.x; } const a: {x?: number} = {x: 1}; if(a.x !== undefined) { change(a); console.log(a.x === undefined); }
```

### callback-refinement-union

```ts
function change(o: {x: number | string}) { o.x = 'x'; } const a: {x: number | string} = {x: 1}; if(typeof a.x === 'number') { change(a); console.log(a.x + 1); }
```

### optional-property-widening

```ts
const a: {x?: number} = {x: 1}; const b: {x?: number | string} = a; b.x = 'x'; console.log(a.x! + 1);
```

### required-to-optional-delete

```ts
const a: {x: number} = {x: 1}; const b: {x?: number} = a; delete b.x; console.log(a.x + 1);
```

## Acceptance criteria

- [x] The confirmed divergence is repaired or refused with an actionable,
      source-located compiler diagnostic.
- [x] Safe controls retain JavaScript behavior.
- [x] Baseline/candidate measurements and implementation limits are recorded.

## Implementation

`src/compiler/structural-semantic-safety.ts` follows direct aliases by symbol and checks visible writes, deletion, array insertion, and local callee mutations against the original carrier/refinement. It emits `JS2WASM_UNSOUND_ARRAY_MUTATION`, `JS2WASM_UNSOUND_STRUCTURAL_ALIAS`, or `JS2WASM_UNSOUND_REFINEMENT`. General higher-order and opaque alias graphs remain outside this local analysis.

## Validation

The committed [audit report](../audit/type-unsoundness-2026-09-08/README.md) contains exact source specimens, baseline/candidate rows, target-specific outcomes, and limits. Across 26 programs the candidate has 19 matching Wasm executions and 33 source-located refusals out of 52, with no remaining measured mismatches. Refusals are not counted as conformance passes. Dedicated regression tests cover this family and matching controls.
