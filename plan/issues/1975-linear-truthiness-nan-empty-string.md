---
id: 1975
title: "linear backend: NaN and \"\" are truthy (f64.ne 0 / raw i32 pointer truthiness); &&/|| return 0/1 instead of operand values"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1974, 1976]
origin: "2026-06-10 deep-audit sweep (optimizer agent): verified on main, target linear"
---

# #1975 — linear ToBoolean is wrong for NaN and strings

## Problem (verified, `target: "linear"`)

| probe | linear | node |
|-------|--------|------|
| `const x = 0/0; if (x) return 1; return 0;` | `1` | `0` |
| `const s = ""; if (s) return 1; return 0;` | `1` | `0` |

GC backend correct on both.

## Root cause

`src/codegen-linear/index.ts:2158-2166` — `emitTruthyCoercion`: for f64 it
emits `f64.ne 0` (NaN ≠ 0 is true in Wasm; NaN is falsy in JS — needs
`x == x && x != 0`); for i32 it does nothing — string values are i32
*pointers*, never 0, so every string including `""` is truthy (needs
`__str_len(ptr) != 0` when the i32 is a string).

Sibling bug in the same function (observed in source, same fix unit): the
`&&`/`||` lowering at index.ts:1921-1948 returns constants `0`/`1` instead of
the operand values — JS `a || b` yields the operand.

## Fix direction

NaN-aware f64 coercion (`f64.eq(x,x) & f64.ne(x,0)`); type-aware i32 coercion
dispatching on the inferred expression kind (string → length check). Fix
`&&`/`||` to tee the LHS and yield operand values. The same helper feeds
`if`/`while`/`for`/ternary/logical ops.

## Acceptance criteria

- Both repros match Node in linear mode
- `a || b` / `a && b` yield operand values (e.g. `"" || "x"` → `"x"`)
- 0, -0, null-pointer-ish values still falsy as appropriate

## Dupe check

No linear truthiness issue exists. Unfiled.
