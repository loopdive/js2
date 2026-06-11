---
id: 1935
title: "relational comparison against an i32-promoted local silently truncates the other f64 operand (i < 2.5 wrong)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: compiler-internals
goal: core-semantics
related: [595, 1166, 1236]
origin: "2026-06-10 deep-audit sweep (coercion agent): verified miscompile on main"
---

# #1935 — i32-local relational hint truncates the f64 operand

## Problem

When either operand of a relational comparison is an i32-promoted local (loop
vars promoted by `detectI32LoopVar`), the **other** operand gets an i32
`numericHint` and is truncated via `i32.trunc_sat_f64_s` before the compare.
`i < 2.5` becomes `i < 2`. Silent wrong branch counts in idiomatic loop code.

## Repro (verified on main)

```ts
export function t1(): number {
  let c = 0;
  for (let i = 0; i < 5; i++) { if (i < 2.5) c++; }
  return c;
}
export function t2(n: number): number {
  let c = 0;
  for (let i = 0; i < 5; i++) { if (i < n / 2) c++; }   // n=5
  return c;
}
```

| probe | wasm | node |
|-------|------|------|
| `t1()` | `2` | `3` |
| `t2(5)` | `2` | `3` |
| `2.5 > i` | `2` | `3` |
| `i < n/4` (n=10) | `2` | `3` |
| `i < ("3.5" as any)` | `3` | `4` |

Note: the *for-header* condition `i < 2.5` itself compiles correctly — only
standalone relational expressions (if/ternary/while body) are affected.

## Root cause

`src/codegen/binary-ops.ts` — `hasI32LocalOperand` (~line 1226) sets the
operand `numericHint` to `i32` for any relational op when *either* operand is
an i32 local. The hint is honored in `compileExpression`
(`src/codegen/expressions.ts:686` → `coerceType`), and `coerceType` f64→i32 is
`i32.trunc_sat_f64_s` (`src/codegen/type-coercion.ts:996-998`), so `2.5`/`n/2`
becomes `2` before `i32.lt_s` (dispatch at binary-ops.ts:1600-1610). The
comment claims it "avoids f64 conversion churn in for-loop conditions" but it
also fires on arbitrary comparisons whose other operand is not provably
integral.

## Fix direction

Only use the i32 hint when the non-local operand is provably i32-pure (reuse
`isI32PureExpr`); otherwise promote the i32 local to f64 (`f64.convert_i32_s`
is cheap and exact). Alternatively make the hint advisory for relationals: if
the hinted operand comes back f64, promote rather than truncate.

## Acceptance criteria

- `if (i < 2.5)` / `while (i < x/2)` with i32 loop var match Node
- For-header fast path retains i32 compare when both sides provably integral
- Equivalence suite green; test262 net non-negative

## Dupe check

Grepped `hasI32LocalOperand`, `fractional`, `i32-promoted`, `detectI32LoopVar`,
`truncat` — closest are #1236 (i32 accumulator saturation, done) and #595/#1166
(i32 loop inference). None cover relational truncation.
