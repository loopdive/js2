---
id: 6753
title: "Native generator residuals after the #6731 tailwindcss slice: for-of body throw does not IteratorClose, `??` statements, rest in destructuring declarations, string-carrier spread, jumps across a state-lowered finally"
status: ready
sprint: current
created: 2026-09-29
updated: 2026-09-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone-mode
---

## Context

Split from [#6731](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6731-native-generator-residual-shapes)
(2026-09-29). #6731's tailwindcss slice lowered `break` / `continue` / labelled
jumps, `switch`, `return` / `yield*` in a yielding for-of, binding-pattern
for-of heads, comma-condition yields, self-contained nested function
declarations and block-scoped shadowing in the standalone native generator
planner. These items of #6731's original list were not touched, plus the
edges that slice deliberately left.

## Residuals

1. **A runtime throw from a yielding for-of BODY does not IteratorClose the
   loop's iterator** (§14.7.5.7 step 6). Abrupt RESUMES (`.return()` /
   `.throw()` at a yield) and `break` / `return` close it; a throwing body
   statement does not (statements are not wrapped, only linear ops are).
2. **`A ?? (yield B);`** is not desugared (its test is nullishness, not
   ToBoolean), nor is a yield in the CONDITION operand of `&&` / `||` / `?:`.
3. **Rest elements of a destructuring declaration** (`let {a, ...r} = o`) are
   not spilled (#971), so a read after a suspension sees the frame default; a
   binding-pattern for-of head with a rest element refuses.
4. **Spreading a native string-carrier generator into `any[]`** yields an empty
   array (`[...(function*(){ yield "x"; yield "y"; })()]` has length 0 in
   standalone).
5. **Jumps / `return` across a state-lowered `finally`** (a `finally` that
   itself yields) or across an A2 `for-of-step` record refuse; a `return` in a
   linearised for-of of a STRING-carrier generator refuses (its `abrupt` field
   is f64).
6. **A capturing nested function declaration** in a generator body refuses
   (its captures would bind the resume function's per-state locals: a
   mutation of a captured param after a yield was not seen by it).
7. Scoped standalone test262 rows still refused with the #680 diagnostic
   (2026-09-29): `built-ins/GeneratorPrototype/return/try-finally-set-property-within-try.js`,
   `language/expressions/yield/from-with.js`,
   `language/statements/generators/scope-param-rest-elem-var-{open,close}.js`,
   `language/statements/generators/{yield-identifier-spread-non-strict,yield-spread-obj}.js`.

## Acceptance

Each item fixed or split with a regression test that fails on its parent;
scoped standalone test262 (`language/{statements,expressions}/generators`,
`built-ins/GeneratorPrototype`, `language/expressions/yield`) with no losses.
