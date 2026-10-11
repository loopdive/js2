---
id: 6444
title: "Audit the remaining static-builtin arms that unroll `expr.arguments` one slot per AST node (`Object.assign`, `Math.hypot`, …)"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: m
feasibility: easy
task_type: bug
area: compiler
goal: correctness
---

## Problem

The same idiom has now been removed from a lowering four times:

| issue  | site                                                                          |
| ------ | ----------------------------------------------------------------------------- |
| #5361  | `splice` / `push` / `Math.min`-`max` / the `__extern_method_call` bridge       |
| #6411  | both host-Array argument builders (`src/codegen/array-method-host.ts`)         |
| #6421  | `String.fromCharCode` / `String.fromCodePoint`, `Array.of`                     |

Each time it was found from a downstream symptom, not from a sweep. The
pattern is mechanical and greppable: a lowering that walks `expr.arguments` (or
sizes anything from `expr.arguments.length`) and emits ONE slot per node is
exact only while every argument is a single value; a spread contributes its
runtime element count.

#6421 named `Object.assign` and `Math.hypot` as unmeasured. Neither was probed.

## Scope

Sweep every remaining static-builtin arm, probe each with a spread, and either
route it through `buildSpreadArgList` / `tryEmitSpreadHostArgs` or record that
it is already correct and why. Start from:

```
grep -n "expr.arguments" src/codegen/expressions/call-builtin-static.ts
grep -rn "arguments.length" src/codegen/expressions/
```

Candidates named so far: `Object.assign`, `Math.hypot`. The sweep is the
point — the list above is where to start, not where to stop.

## Acceptance criteria

1. A table of every static-builtin arm that unrolls its argument list, each
   marked measured-correct or fixed, with the probe result quoted.
2. Every arm that needed a fix has a regression row, failing on the parent.
3. Anti-vacuity: the no-spread form of each fixed arm stays byte-identical
   (keep the unrolled loop as the no-spread branch, as #6411/#6421 did).
4. A/B over the 17 dogfood suites at one HEAD.

## Dispatch

Model: **sonnet** is enough for the sweep itself; each individual fix is a
copy of the #6411 edit. Escalate to opus only if an arm needs a new sink shape
(as `fromCharCode`'s runtime fold did).
