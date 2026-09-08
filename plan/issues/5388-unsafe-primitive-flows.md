---
id: 5388
title: "Reject primitive type claims that contradict runtime value origins"
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

Type assertions, any-to-primitive flows, and overload return claims currently select coercing Wasm carriers. Values such as a string can become NaN or false even though JavaScript preserves them.

Base: `3bb59a816bbaf7`. Node.js 24.4.1 runs the type-erased source;
js2wasm is measured in JS-host and standalone modes. Exact baseline and candidate
rows are tracked by **#5387 — Audit TypeScript unsoundness hazards and reject
unsupported JavaScript semantics**.

## Reproductions

### any-parameter

```ts
function add(x:number){ return x+1; } const value:any="x"; console.log(add(value));
```

### any-typed-variable

```ts
const value:any="x"; const n:number=value; console.log(n+1);
```

### assertion-number

```ts
const n="x" as unknown as number; console.log(n+1);
```

### assertion-boolean

```ts
const n="hello" as unknown as boolean; console.log(typeof n); console.log(n);
```

### overload-lie

```ts
function value(): number; function value(): any { return 'x'; } console.log(value() + 1);
```

## Acceptance criteria

- [x] The confirmed divergence is repaired or refused with an actionable,
      source-located compiler diagnostic.
- [x] Safe controls retain JavaScript behavior.
- [x] Baseline/candidate measurements and implementation limits are recorded.

## Implementation

`src/compiler/primitive-semantic-safety.ts` follows visible origins at the actual use point, including real guards and local implementations. It emits `JS2WASM_UNSOUND_ASSERTION`, `JS2WASM_UNSOUND_PRIMITIVE_FLOW`, or `JS2WASM_UNSOUND_OVERLOAD`. Future writes and uncalled nested functions do not invalidate an earlier value. Dynamic origins without adequate evidence may be conservatively refused; this is not a whole-program contract verifier.

## Validation

The committed [audit report](../audit/type-unsoundness-2026-09-08/README.md) contains exact source specimens, baseline/candidate rows, target-specific outcomes, and limits. Across 26 programs the candidate has 19 matching Wasm executions and 33 source-located refusals out of 52, with no remaining measured mismatches. Refusals are not counted as conformance passes. Dedicated regression tests cover this family and matching controls.
