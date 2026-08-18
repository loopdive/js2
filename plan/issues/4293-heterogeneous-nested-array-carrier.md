---
id: 4293
title: "Array literal: nested heterogeneous element carriers are coerced to the first inner vec"
status: done
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arrays, undefined
goal: npm-library-support
sprint: 78
required_by: [1400]
es_edition: ES2015
related: [1021, 2021, 3244, 4289]
loc-budget-allow:
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/literals.ts::compileArrayLiteral
---

# #4293 — heterogeneous nested arrays use the first inner vec carrier

## Problem

An unannotated array of arrays adopts the first nested array's exact element
representation and coerces later nested arrays into it. A numeric first row
therefore turns a later JavaScript `undefined` into numeric `NaN` before any
library code runs:

```js
const rows = [[0], [undefined]];

export function test() {
  return rows[1][0] === undefined ? 1 : 0;
}
```

Node returns **1**. The compiler emits valid Wasm, but Wasm returns **0**. The
second value reports `typeof value === "number"`; when exported numerically it
is `NaN`.

This is the remaining generic blocker exposed by ESLint 10.0.3's original
`tests/lib/shared/deep-merge-arrays.js` table after #4289 removed its module-init
trap. The selected upstream file registers 44 cases. Node passes 44/44; Wasm
executes all 44 and matches 37/44.

## Reduction evidence

The seven failing original case indices are **11, 13, 35, 38, 39, 40, 41**.
Every one passes when compiled as the only table row. Every one fails when
paired with the upstream table's first row, so these are not seven independent
ESLint algorithm failures. Prefixes fail exactly when each affected row is
introduced, and no extra failures appear after row 41.

For case 11, the exact two-row carrier corruption is observable before calling
`deepMergeArrays`:

```js
const rows = [
  [[], undefined, []],
  [[123], [undefined], [123]],
];

rows[1][1][0] === undefined; // Node true, Wasm false
typeof rows[1][1][0]; // Node "undefined", Wasm "number"
```

Once the corrupted `NaN` reaches `deepMergeObjects`, `second === void 0` is
false and the merge returns `NaN` instead of retaining `123`. The object-heavy
rows expose the same first-carrier selection as dropped object fields rather
than as `NaN`.

## Root cause

`compileArrayLiteral` chooses the parent array's element carrier from its first
significant element. When that element is itself an array, its concrete vec
type includes the inner element representation (`f64` here). Later nested
arrays are coerced to that exact vec instead of selecting a lossless common
carrier for the TypeScript union. Converting the later `undefined` element to
the first row's `f64` representation produces the compiler's numeric
undefined/NaN sentinel, but the value is no longer observable as JavaScript
`undefined`.

#4289 fixed the sibling case for anonymous object structs, where a failed
guarded cast became null and trapped. Nested arrays need the same principle:
never choose a closed first-element carrier unless every later element can
inhabit it without semantic conversion.

## Acceptance criteria

- The two-row `[[0], [undefined]]` reduction is red before the fix and returns
  the same result in Node and Wasm after the fix.
- A later nested boolean, string, object, `null`, or `undefined` value is not
  coerced through the first nested numeric vec merely because it appears later.
- Homogeneous nested numeric arrays retain their compact numeric carrier.
- Contextually typed arrays with a sound declared common carrier retain that
  carrier.
- ESLint's pinned original deep-merge unit compiles, validates, executes all 44
  cases, and matches Node 44/44 with no rejected or skipped case.
- The full ESLint package-entry compile budget remains reported separately; a
  unit-slice improvement must not be presented as whole-package validation.

## Resolution

`compileArrayLiteral` now compares the compiler-resolved element carriers of
statically known nested `Array`/`ReadonlyArray` values. If the inner carriers
differ, the outer literal selects a common `vec<externref>` carrier for its
rows, so each inner array is copied without converting its JavaScript values
through the first row's element representation. Rows with the same resolved
carrier retain their existing compact representation; a homogeneous numeric
matrix still uses numeric vecs.

The regression covers later `undefined`, boolean, string, `null`, and object
values; separately bound rows; object identity and fields; and a homogeneous
numeric control. The immutable ESLint v10.0.3 unit now reports **44/44** matching
cases in both Wasm and Node, with zero rejected or skipped bodies.
