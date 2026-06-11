---
id: 2057
title: "Math.min/max constant-fold a reassigned variable to NaN — isStaticNaN traces initializers without const/reassignment check"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: math-builtins
goal: core-semantics
related: [85, 431, 160]
origin: "2026-06-10 deep-audit sweep (coercion agent): verified miscompile on main"
---

# #2057 — `isStaticNaN` ignores mutation: NaN-initialized accumulators break `Math.min`/`Math.max`

## Problem

`let best = NaN; best = v; Math.min(best, cap)` returns NaN forever. The
"statically NaN" detection traces *any* identifier to its declaration
initializer with no const-ness or reassignment check, and `Math.min/max`
then compile to a compile-time `f64.const NaN` (other args evaluated only for
side effects). This silently destroys the very common NaN-initialized
accumulator pattern.

## Repro (verified on main)

```ts
export function t1(): number {
  let x = NaN;
  x = 5;
  return Math.min(x, 3);
}
export function t2(b: boolean): number {
  let x = NaN;
  if (b) x = 10;
  return Math.max(x, 3);
}
```

| call | wasm | node |
|------|------|------|
| `t1()` | `NaN` | `3` |
| `t2(true)` | `NaN` | `10` |

## Root cause

- `src/codegen/expressions/misc.ts:514-536` — `isStaticNaN` traces any
  identifier to its `valueDeclaration` initializer (`let x = NaN` ⇒
  "statically NaN") with no const-ness or write-reference check.
- `src/codegen/expressions/builtins.ts:2267-2277` then compiles `Math.min/max`
  to `f64.const NaN`.

## Fix direction

In `isStaticNaN`, only follow the initializer for `const` declarations (or
verify via the checker that the symbol is never write-referenced after
declaration). The runtime NaN guard already emitted for the general case
(builtins.ts:2336-2349) makes the static check purely an optimization, so
restricting it is safe.

## Acceptance criteria

- Both repros match Node
- `const x = NaN; Math.min(x, 3)` still constant-folds (optimization retained
  where sound)
- Audit other `isStaticNaN` call sites for the same unsound fold

## Dupe check

Grepped `isStaticNaN`, `Math.min` + `NaN`, `static NaN` — #85 (variadic
min/max, done), #431, #160 — none mention the initializer-tracing bug.
