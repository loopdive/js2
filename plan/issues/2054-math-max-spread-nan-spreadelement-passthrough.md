---
id: 2054
title: "Math.max(...arr) / Math.min(...arr) on runtime arrays silently return NaN — generic SpreadElement passthrough hazard"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: spread
goal: core-semantics
related: [18, 1135, 2053]
origin: "2026-06-10 deep-audit sweep (eval-order agent): verified miscompile on main"
---

# #2054 — `Math.max(...arr)` returns NaN; SpreadElement transparently unwrapped

## Problem

The extremely common idiom `Math.max(...arr)` compiles with zero diagnostics and
returns NaN. Beyond the Math builtin, the root pattern is a general hazard: the
expression dispatcher silently unwraps any `SpreadElement` to its inner
expression, so every call path without an explicit spread special-case compiles
"spread" as "pass the array itself, coerced".

## Repro (verified on main)

```ts
export function t4(): number {
  const arr: number[] = [3, 9, 4];
  return Math.max(...arr);   // JS: 9
}
```

wasm: `NaN` — node: `9`. Zero diagnostics.

## Root cause

Two pieces:

1. `src/codegen/expressions/builtins.ts:2300-2306`: with
   `expr.arguments.length === 1`, the single argument (the `SpreadElement`) is
   compiled directly with an f64 hint.
2. `src/codegen/expressions.ts:1264-1266`:
   ```ts
   if (ts.isSpreadElement(expr as any)) {
     return compileExpressionInner(ctx, fctx, (expr as any as ts.SpreadElement).expression, expectedType);
   }
   ```
   The generic dispatcher transparently unwraps a SpreadElement, so
   `Math.max(...arr)` becomes `ToNumber(arr-as-f64)` → NaN.

Note: #18 (done) lists `Math.max(...numbers)` as a target case and #1135 (done)
claims `Math.max(...vec)` works via the host `__make_iterable` path — neither
holds on current main with the default compile path.

## Fix direction

In the Math.min/max builtin lowering, detect `SpreadElement` arguments and emit
a runtime loop over the vec (`length` field + `f64.max`/`f64.min` fold with NaN
guard and ±Infinity empty-array result), or route to the host import in JS-host
mode (with a Wasm-native loop for standalone). Separately, the SpreadElement
passthrough in `compileExpressionInner` should `reportError` instead of silently
compiling the inner expression when the consumer didn't explicitly opt in —
that converts a whole class of future silent miscompiles into compile errors.

## Acceptance criteria

- `Math.max(...arr)` / `Math.min(...arr)` match Node, including empty array
  (`-Infinity` / `Infinity`) and NaN elements
- Mixed forms `Math.max(0, ...arr)` correct
- Unhandled SpreadElement positions produce a compile-time error, not silent
  coercion (audit existing intentional consumers before flipping)
- Works in both JS-host and standalone modes (no new host import without
  standalone fallback)

## Dupe check

Grepped `Math.max(...` across plan/issues/ — only #18/#78/#83/#1135/#1888, all
done, all asserting it works or planning it. No open issue for the current
breakage.
