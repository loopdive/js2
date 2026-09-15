---
id: 5392
title: "Render scalar console output in standalone legacy lowering"
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
# Reuse existing scalar-to-string conversion at the existing stdout sink.
loc-budget-allow:
  - src/codegen/native-strings.ts
assignee: "ttraenkler/codex-unsoundness"
---

## Measured defect

The legacy standalone output sink explicitly drops scalar arguments. The IR path prints constants correctly, while otherwise-correct numeric programs can print only a newline after a legacy fallback. This is a separate output bug, not a TypeScript-unsoundness diagnosis.

Base: `3bb59a816bbaf7`. Node.js 24.4.1 runs the type-erased source;
js2wasm is measured in JS-host and standalone modes. Exact baseline and candidate
rows are tracked by **#5387 — Audit TypeScript unsoundness hazards and reject
unsupported JavaScript semantics**.

## Reproductions

### any-numeric-control

```ts
function add(x:number){return x+1;} const value:any=2; console.log(add(value));
```

### array-safe-control

```ts
const xs=[1,2,3]; console.log(xs[1]+1);
```

### overload-control

```ts
function value(): number; function value(): any { return 4; } console.log(value() + 1);
```

## Acceptance criteria

- [x] The confirmed divergence is repaired or refused with an actionable,
      source-located compiler diagnostic.
- [x] Safe controls retain JavaScript behavior.
- [x] Baseline/candidate measurements and implementation limits are recorded.

## Implementation

`src/codegen/native-strings.ts` now converts scalar stdout arguments with the existing native `emitToString` path, using the actual Wasm value brand instead of stale TypeScript claims. Tests force legacy and IR paths, inspect actual stdout, and verify zero host imports. The old legacy boolean test expected blank lines and now expects JavaScript boolean text.

## Validation

The committed [audit report](../audit/type-unsoundness-2026-09-08/README.md) contains exact source specimens, baseline/candidate rows, target-specific outcomes, and limits. Across 26 programs the candidate has 19 matching Wasm executions and 33 source-located refusals out of 52, with no remaining measured mismatches. Refusals are not counted as conformance passes. Dedicated regression tests cover this family and matching controls.
