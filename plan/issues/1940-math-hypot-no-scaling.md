---
id: 1940
title: "Math.hypot overflows/underflows: inlined sqrt(a*a+b*b) without scaling"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: math-builtins
goal: core-semantics
related: [432]
origin: "2026-06-10 deep-audit sweep (coercion agent): verified miscompile on main"
---

# #1940 — `Math.hypot` lacks scaling

## Problem

`Math.hypot` is inlined as `sqrt(a*a + b*b)`; squares overflow above ~1e154
and flush to 0 below ~1e-162, while JS engines compute hypot with scaling.

## Repro (verified on main)

```ts
export function h(a: number, b: number): number { return Math.hypot(a, b); }
```

| call | wasm | node |
|------|------|------|
| `h(1e200, 1e200)` | `Infinity` | `1.414213562373095e+200` |
| `h(3e-200, 4e-200)` | `0` | `5e-200` |

NaN/Infinity propagation cases are correct (`hypot(NaN, Infinity)=Infinity`,
`hypot(NaN,1)=NaN` both match).

## Root cause

`src/codegen/expressions/builtins.ts:2148-2199` inlines `sqrt(a*a + b*b)`.

## Fix direction

Scale by `m = max(|args|)`: result `= m * sqrt(Σ(aᵢ/m)²)` (guard `m == 0` →
`0`), or route through a `Math_hypot` host import like pow/atan2 with the
scaled version as the standalone fallback.

## Acceptance criteria

- Both repros match Node (within 1 ULP of V8's result; exactness of hypot is
  implementation-approximated per spec, but Infinity/0 are categorically wrong)
- NaN/Infinity propagation unchanged
- Variadic and 1-arg forms covered

## Dupe check

Grepped `hypot` — only incidental mentions (#432 not-a-constructor, #1183 CI
drift list). Not covered.
