---
id: 5389
title: "Reject missing lookup uses that lose JavaScript undefined semantics"
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

Missing typed array elements become NaN/number rather than undefined; method calls may fail to throw. Missing string index-signature values already work in JS-host mode but become null/string in standalone.

Base: `3bb59a816bbaf7`. Node.js 24.4.1 runs the type-erased source;
js2wasm is measured in JS-host and standalone modes. Exact baseline and candidate
rows are tracked by **#5387 — Audit TypeScript unsoundness hazards and reject
unsupported JavaScript semantics**.

## Reproductions

### array-oob-value

```ts
const xs=[1,2,3]; const n=xs[3]; console.log(n); console.log(typeof n);
```

### index-signature-missing

```ts
const ids:{[key:string]:string}={known:"yes"}; const value=ids["missing"]; console.log(value); console.log(typeof value);
```

### array-oob-method

```ts
const xs=[1,2,3]; try { console.log(xs[3].toFixed(1)); } catch(e) { console.log("threw"); }
```

## Acceptance criteria

- [x] The confirmed divergence is repaired or refused with an actionable,
      source-located compiler diagnostic.
- [x] Safe controls retain JavaScript behavior.
- [x] Baseline/candidate measurements and implementation limits are recorded.

## Implementation

`src/compiler/lookup-semantic-safety.ts` emits `JS2WASM_UNSOUND_LOOKUP` for proven absent literal-array values with observable undefined semantics. It preserves numeric-only use and present values. Missing typed string-map keys are refused only in standalone. Mutation, escape, prototype effects, and dynamic indices invalidate the closed-literal proof rather than being claimed safe.

## Validation

The committed [audit report](../audit/type-unsoundness-2026-09-08/README.md) contains exact source specimens, baseline/candidate rows, target-specific outcomes, and limits. Across 26 programs the candidate has 19 matching Wasm executions and 33 source-located refusals out of 52, with no remaining measured mismatches. Refusals are not counted as conformance passes. Dedicated regression tests cover this family and matching controls.
