---
id: 5375
title: "prettier `printDocToString` never terminates on an array doc: the `DOC_TYPE_ARRAY` arm's `commands.push({ indent, mode, doc: doc[index] })` loops when the object literal is inline in the push argument"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
---

## Problem

prettier's `tests/unit/print-doc-to-string.js` (0/3, #5346) times out in the
dogfood worker — on `50c81e5487` and equally with #5356 fixed. Every one of
its three tests passes an **array** doc, and `printDocToString(["a"])` alone
never returns. Instrumenting a copy of `src/document/printer/printer.js`
(markers written with `console.error`, which the worker surfaces in its
timeout detail) localises it to one statement of the `DOC_TYPE_ARRAY` arm:

```js
case DOC_TYPE_ARRAY:
  for (let index = doc.length - 1; index >= 0; index--) {
    commands.push({ indent, mode, doc: doc[index] });   // never returns
  }
  break;
```

Markers placed immediately before the `push` fire (`doc.length` is 1, the
element is a string, `commands.length` is 0); a marker immediately after it
never does. Two source-level variants of the same statement both terminate
and then print `"a"` correctly (with #5356 in place):

```js
const __el = doc[index];
const __cmd = { indent, mode, doc: __el };
commands.push(__cmd);                                  // terminates
```

while keeping the literal inline and only hoisting the element read
(`const __el = doc[index]; commands.push({ indent, mode, doc: __el })`) still
loops. So the trigger is the **object literal inline as the `push` argument**,
in this function. `commands` is initialised as
`[{ indent: ROOT_INDENT, mode: MODE_BREAK, doc }]` (an `Indent` object, a
`Symbol`, and an untyped `doc`), and the loop body pushes that same three-key
shape from a dozen sites with differently-typed `doc` values (`doc.contents`,
`mostExpanded`, `hardlineWithoutBreakParent`, spread `...lineSuffix.reverse()`).

### What does NOT reproduce

A standalone two-file `.js` copy of the loop with one push site — numeric or
Symbol `mode`, numeric or object `indent`, inline literal or hoisted — passes
in Wasm (`.tmp`-style probe through `compileAndRunUpstreamModule`, control
assertion failing both lanes). The hang needs more of the real function than
one literal shape; the next step is to bisect the real `printer.js` by
deleting push sites / `case` arms until the loop disappears, then reduce.

### Why it matters

It is the last blocker for prettier's `print-doc-to-string` (0/3). #5356
(the `output` cell) is fixed; #5357 (`x === false` on a nullish reference —
`traverseDoc` visits 1 node instead of 2) is confirmed present and separate.
With #5356 in place and the `push` split by hand, `printDocToString(["a"])`
returns `"a"`.

## Acceptance criteria

1. `printDocToString(["a"], options).formatted` returns `"a"` on the pinned
   prettier 3.8.1 tree without source changes; the three `print-doc-to-string`
   tests then score against #5357's state, not against a timeout.
2. A standalone reduction (two-file untyped `.js`) that loops on the parent
   commit and terminates with the fix, with a regression test and counts
   both ways.
3. A/B at one head over the 17 dogfood suites: nothing else regresses.
