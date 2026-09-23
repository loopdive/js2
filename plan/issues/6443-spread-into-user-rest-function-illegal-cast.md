---
id: 6443
title: "A spread into a USER rest function traps with `illegal cast` in an untyped `.js` project — every source shape, same- and cross-module"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: high
horizon: m
feasibility: medium
task_type: bug
area: compiler
goal: correctness
---

## Problem

```js
function rest(...codes) {
  return codes.length;
}
rest(...[1, 2, 3]); // node 3, compiled: RuntimeError: illegal cast
```

Measured on `699df289e1` with an untyped two-file `.js` project (`compileProject`,
`allowJs`, `skipSemanticDiagnostics`, `target: "gc"`). Every spread source shape
traps identically:

| form                                          | result          |
| --------------------------------------------- | --------------- |
| `rest(...[1, 2, 3])` (inline literal)         | `illegal cast`  |
| `const a = [1,2,3]; rest(...a)`               | `illegal cast`  |
| `rest(...csv.split(","))`                     | `illegal cast`  |
| `rest(...new Uint8Array([1,2,3]))`            | `illegal cast`  |
| same-module callee vs imported callee         | both trap       |
| `rest(1, 2, 3)` (no spread)                   | **correct** — 3 |

So the spread itself is the trapping part, not the rest parameter: the
no-spread call into the same function is correct on the same build.

`tests/spread-rest.test.ts` also fails wholesale on current main
(13 rows, "spread into array literal" / "spread array into rest param
function" / "rest params array length" among them), which is the same defect
plus a `string_constants` harness error in that file.

## Why it matters

[#6421](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6421-spread-into-static-builtin-drops-arguments)
listed `f(...[1,2,3])` into a user rest function as one of the four forms that
were **already correct**, and used it as an anti-vacuity control. It is not
correct, and the control had to be dropped from that issue's regression test.
Anything else reasoning from "spread into a user function works, so the defect
is builtin-specific" is reasoning from a false premise.

## Acceptance criteria

1. All five spreading forms above answer the same as node, same- and
   cross-module, in an untyped `.js` project.
2. `rest(1, 2, 3)` and the other no-spread controls stay correct.
3. Regression test under `tests/`, untyped two-file `.js` fixture, failing on
   the parent and passing with the fix, exact counts both ways.
4. Standalone lane status recorded.
5. State whether `tests/spread-rest.test.ts`'s 13 failures are this defect;
   if its `string_constants` harness error is separate, say so.

## Dispatch

Model: **opus**. A trap with a clean no-spread control is cheap to bisect
(`ref.cast` in the rest-array materialization), but the blast radius —
every rest function in every untyped project — argues for care on the
controls.
