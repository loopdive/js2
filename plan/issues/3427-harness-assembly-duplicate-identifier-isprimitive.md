---
id: 3427
title: "Harness-assembly compile error: Duplicate identifier 'isPrimitive' at L1:10 (host 2,054 + standalone 2,051 TypedArray/Array tests)"
status: done
completed: 2026-07-18
assignee: ttraenkler/opus-dev-b
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: high
horizon: s
feasibility: medium
task_type: bug
area: test262-runner, harness-assembly
language_feature: n/a
es_edition: n/a
goal: test262-conformance
related: [3370, 3426]
origin: "2026-07-18 oracle-v8 harvest (fable harvest agent): host + standalone `other` sub-bucket, both lanes @ oracle 8."
---

# #3427 — Duplicate identifier 'isPrimitive' harness-assembly compile error

## Problem

A single compile-error signature accounts for ~2k tests in **both** lanes:

| Lane       | Records |
| ---------- | ------: |
| Host (JS)  |   2,054 |
| Standalone |   2,051 |

```
L1:10 Duplicate identifier 'isPrimitive'
```

The error is at **line 1** (the assembled-prelude region), and every affected
test is a **TypedArray / Array** test that pulls the `testTypedArray.js`
(or `testBigIntTypedArray.js`) harness include:

Host samples (all `compile_error`, strict + non-strict):

```
test/built-ins/Array/prototype/every/callbackfn-resize-arraybuffer.js
test/built-ins/TypedArray/prototype/fill/fill-values-relative-end.js
test/built-ins/TypedArray/prototype/filter/BigInt/speciesctor-get-species-custom-ctor-throws.js
test/built-ins/TypedArray/prototype/at/index-non-numeric-argument-tointeger.js
test/built-ins/TypedArray/prototype/Symbol.iterator/not-a-constructor.js
```

Standalone samples:

```
test/built-ins/TypedArray/prototype/reverse/get-length-uses-internal-arraylength.js
test/built-ins/TypedArray/prototype/includes/return-abrupt-tointeger-fromindex-symbol.js
test/built-ins/TypedArray/prototype/findLastIndex/this-is-not-object.js
test/built-ins/TypedArray/prototype/forEach/callbackfn-resize.js
```

## Root cause (hypothesis)

This is a **harness-assembly regression from #3370** (make the literal upstream
harness authoritative), not a codegen or conformance bug. The authoritative
assembly concatenates: runtime shim + harness includes + `assert.js` + `sta.js` +
test body. `isPrimitive` is defined by a TypedArray harness include
(`testTypedArray.js` defines `isPrimitive`/related helpers), and the assembled
prelude / another include defines `isPrimitive` a second time → duplicate
identifier at the top of the module. Because TypeScript is the front-end,
duplicate `function isPrimitive`/`const isPrimitive` declarations are a hard
compile error rather than a JS last-wins redefinition.

This is a **high-ROI runner-side fix**, not deep codegen: de-duplicate harness
includes during assembly (or rename/guard the prelude's `isPrimitive`), and ~4k
TypedArray/Array tests across both lanes recompile.

## Acceptance criteria

- The sample TypedArray/Array tests compile without `Duplicate identifier
'isPrimitive'`.
- Harness-include assembly de-duplicates repeated include definitions (or the
  prelude no longer collides with `testTypedArray.js`'s `isPrimitive`).
- Both lanes: the `Duplicate identifier 'isPrimitive'` compile-error class drops
  to ~0.

## Cross-reference

Consequence of #3370 (authoritative harness). Reduces standalone
`compile_error` count alongside #3426.
