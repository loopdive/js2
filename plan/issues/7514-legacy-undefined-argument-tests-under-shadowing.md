---
id: 7514
title: "Legacy argument handling reads a shadowed `undefined` as the global (`x === undefined`, `g(undefined)`)"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: s
task_type: bug
area: codegen
goal: core-semantics
related: [7439]
---

# #7514 — spelling-only `undefined` tests in legacy codegen

## Problem

#7439 makes a *read* of a shadowed `undefined` yield its binding, through the oracle answer `undefinedReadOf`. Legacy
codegen also decides how to treat an argument or operand from the spelling `undefined` alone. These sites still
answer as if the name were the global. Measured by PRV-7439 on main 1a726b3e (node: 43 in both cases):

- `const undefined = 42; … x === undefined` with `x = 42` gives 0, because the comparison is lowered as an undefined
  test.
- `const undefined = 42; function g(a = 8) { return a + 1 }; g(undefined)` takes the default parameter (8 + 1),
  because the argument is treated as omitted.

`src/codegen` has 88 such `text === "undefined"` tests besides the read arm #7439 fixes (main 1a726b3e). Among them
are omitted-argument and default-parameter detection, the `JSON.stringify` replacer, the `parseInt` radix, and the
array destructuring hole tests in `expressions.ts`.

## Direction

Route each site through #7439's `undefinedReadOf(id) !== "shadowed"`, in the same safe direction as the read arm:
`unknown` keeps today's behaviour. Prefer one shared helper over 88 call-site edits.

## Acceptance criteria

1. Both programs above give node's answers on gc and standalone, default and legacy.
2. Unshadowed programs are byte-identical on a test262 sample.
