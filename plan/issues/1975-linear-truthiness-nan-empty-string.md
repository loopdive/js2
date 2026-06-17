---
id: 1975
title: "linear backend: NaN and \"\" are truthy (f64.ne 0 / raw i32 pointer truthiness); &&/|| return 0/1 instead of operand values"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1974, 1976, 2184]
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

## Progress (2026-06-12) — ToBoolean fixed; &&/|| operand-value follow-up

**Done (this PR):** `emitTruthyCoercion` now takes the source expression and,
for a string-typed value, replaces the i32 pointer on the stack with
`__str_len(ptr) != 0` — so `""` is falsy and a non-empty string truthy. The
NaN case (`f64.abs(x) > 0`) was already correct (#1937). The coercion feeds
`if`/`while`/`for`/ternary and the `&&`/`||` left operand, so both problem-table
rows now match Node, and string truthiness drives `&&`/`||` short-circuit
correctly in boolean contexts (`"" && x`, `"" || x`, `"a" && x`). All 136
existing linear tests pass; `tests/issue-1975.test.ts` (8 cases) added.

**Remaining (separate follow-up):** the `&&`/`||` lowering still coerces its
result to f64 and yields `0`/`1` constants on the short-circuit arm instead of
the *operand value* — so `("" || "x")` used as a string doesn't yield `"x"`.
Fixing this needs result-type unification in the linear backend (the f64-only
`if` result type can't carry a string operand), which is a larger change than
the ToBoolean fix and is left for a dedicated issue. The boolean-context use
(the common case, and what the problem table exercises) is correct now.

### Files

- `src/codegen-linear/index.ts` — `emitTruthyCoercion` string branch + threaded
  the source expression through all call sites (`if`/`while`/`for`/ternary/
  unary-`!`/`&&`/`||`).

## Closure (2026-06-16)

**Done.** The ToBoolean correctness fix shipped in PR #1412 (commit
`248195e2b`); both problem-table repros (`NaN`/`""` falsy) now match Node and
`tests/issue-1975.test.ts` (8 cases) passes on main (re-verified 2026-06-16).
The deferred `&&`/`||` *operand-value* half (yields `0`/`1` instead of the
operand; needs result-type unification in the linear backend) is split out to
**#2184** — the issue itself carved it out as "a dedicated issue." Closing
#1975 as done; the value-producing `&&`/`||` work continues under #2184.
