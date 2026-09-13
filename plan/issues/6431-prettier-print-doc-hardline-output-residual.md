---
id: 6431
title: "prettier `print-doc-to-string` 1/3 after #5375: `hardline` emits nothing — `printDocToString(['   ', hardline, 'Prettier', hardline])` returns `'   Prettier'` (no newline, no trim)"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

With #5375 fixed, prettier's `tests/unit/print-doc-to-string.js` no longer
times out; it scores **1/3** (`Should reject if too many cursor in doc`
passes; `doc-printer.js` is 1/1). The two remaining tests fail on their
assertion, and both point at the same thing — a `hardline` that produces no
output:

```
Should trim blank first line
  expected "\nPrettier\n"          got "   Prettier"
Should properly trim with cursor
  expected { formatted: "123Prettier\n", cursorNodeStart: 3, cursorNodeText: "Prettier" }
  got      toEqual mismatch
```

The first doc is `["   ", hardline, "Prettier", hardline]`. The strings are
printed and concatenated; the two `hardline`s (each an ARRAY
`[{ type: "line", hard: true }, breakParent]`) contribute nothing — no
`newLine`, and no `trim()` either (the leading `"   "` survives), so the
`DOC_TYPE_LINE` arm's `MODE_BREAK` branch

```js
trim();
output += newLine + indent.value;
position = indent.length;
```

is never reached, or its writes to the outer `let output` / `position` are
lost. The measurement lane is the dogfood worker
(`tests/dogfood/prettier-upstream-suite.mjs`, report
`tests/dogfood/report/prettier-upstream-suite.json`).

## Exonerated (measured, do not re-check)

Both were the obvious suspects and both PASS in Wasm through
`compileAndRunUpstreamModule` (two-file untyped `.js`, control failing in both
lanes):

- `switch (mode)` / `mode === MODE_BREAK` on a **Symbol** `mode` popped from a
  record vec, pushed back through the loop and popped again — untyped.
- the same with prettier's exact JSDoc typing
  (`@typedef {typeof MODE_BREAK | typeof MODE_FLAT} Mode`,
  `@typedef {{ doc: any, mode: Mode }} Command`, `/** @type Command[] */`,
  `/** @type {unique symbol} */` on the constants).

So the `mode` dispatch is not it. Remaining candidates, in the order to
bisect: `propagateBreaks(doc)` (mutates the doc tree before the loop),
`getDocType` on the `{ type: "line", hard: true }` element (a struct from
`builders/`) — if it answered something other than `DOC_TYPE_LINE` the
`default: throw new InvalidDocError` would fire, so more likely the arm IS
entered — then `doc.hard` / `doc.literal` reads on that struct, the
`lineSuffix.length > 0` early `break`, and the nested `function trim()`'s
writes to `output` / `position` / `settledOutput` (the #5356 class:
mutable `let` captured by a hoisted inner function).

## How to reproduce cheaply

#5375's Implementation Plan documents the tooling: a scratch copy of the
prettier tree, `make-variant.py`-style arm deletion, and a `.tmp` probe
driver that compiles `src/document/printer/printer.js` through the dogfood
lane in ~15 s. `printDocToString(["a", hardline, "b"], { printWidth: 80,
tabWidth: 2 }).formatted` is the smallest failing input (`"ab"` instead of
`"a\nb"` is the expected wrong answer — verify first).

## Acceptance criteria

1. `printDocToString(["   ", hardline, "Prettier", hardline], options).formatted`
   is `"\nPrettier\n"`; `print-doc-to-string.js` reaches 3/3.
2. Regression test with a two-file untyped fixture, counts both ways,
   anti-vacuity control.
3. A/B at one HEAD over the 17 dogfood suites; nothing else regresses.
