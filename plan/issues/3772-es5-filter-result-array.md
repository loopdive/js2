---
id: 3772
title: "ES5 inherited Array.prototype.filter result identity"
status: in-review
sprint: current
created: 2026-07-28
updated: 2026-07-28
assignee: ttraenkler/codex-es5-filter-result-array
priority: high
task_type: bug
area: standalone, arrays, test262
goal: es5-conformance
loc-budget-allow:
  - src/codegen/object-runtime.ts
---

# #3772 — ES5 inherited `Array.prototype.filter` result identity

## Scope

Fix standalone dispatch for a function-constructor instance whose live
`F.prototype` is an Array:

```js
F.prototype = new Array(1, 2, 3);
function F() {}
var value = new F();
value.length = false;
var result = value.filter(callback);
```

The primary Test262 slice is:

- `built-ins/Array/prototype/filter/15.4.4.20-6-2.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-3.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-4.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-5.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-6.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-7.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-8.js`
- `built-ins/Array/prototype/filter/15.4.4.20-10-3.js`

The implementation also retains inherited indexed reads when the instance
shadows the prototype Array's `length` with a positive value.

## Root cause

The fixed-arity closed-method dispatcher classified every non-`$Object`,
non-vector receiver of a method named `filter` as an Iterator-helper receiver.
A raw `__fnctor_F` instance therefore called `__iter_lazy_filter` and produced a
`$LazyIterHelper`; `Array.isArray(result)` was false and `result.length` was 0.

This was not an Array branding defect: the generic borrowed-filter path already
returned `$ObjVec`, and `$ObjVec` was already recognized by `Array.isArray`.

## Implementation

- Extend the native Array HOF brand predicate with exact live prototype
  provenance: `receiver is __fnctor_F` and `F.prototype` is a native Array
  carrier.
- Keep the original instance as the HOF receiver so own `length` shadowing and
  callback arguments remain correct.
- On an own indexed-property miss, make standalone fnctor array-like readers
  continue at the live `F.prototype` global. This preserves inherited elements
  for positive-length cases.
- Leave custom and non-Array function prototypes on the ordinary method lookup
  path.

## Test results

Same-SHA local-vs-local measurement at
`origin/main@f5268a605631aabc5abdf20695e9be2931d0e562`, using the authoritative
`runTest262File` runner across all 217 `15.4.4.20*.js` files:

- standalone: 129/217 → 139/217
  - 10 exact fail-to-pass transitions
  - zero pass-to-fail transitions
  - the eight primary Array-result identity cases pass
  - `15.4.4.20-9-c-i-15.js` and `15.4.4.20-9-c-i-21.js` additionally pass
    because inherited numeric elements are now visible
- host: 166 pass / 48 fail / 3 runner errors in both arms
  - zero status transitions

Focused and adjacent validation:

- 64 passing / 1 skipped across six Vitest files
- `pnpm run typecheck`
- `pnpm run check:oracle-ratchet`
- `pnpm run check:loc-budget`
- `pnpm run check:func-budget`
- issue ID and issue-spec coverage gates
- scoped Prettier check
