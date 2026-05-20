---
id: 1461
sprint: 52
title: "spec gap: Array.prototype.* called on array-like / exotic receivers"
status: in-review
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: array-methods
goal: spec-completeness
related: [1154]
---
# #1461 - spec gap: Array.prototype.* called on array-like / exotic receivers

## Problem

`built-ins/Array/prototype/*` contributes **2,810 test262 failures**.
Distribution by method:

```
260 reduce      260 reduceRight   242 filter     219 some
218 every       216 map           201 indexOf    198 lastIndexOf
190 forEach      81 splice         71 slice       69 concat
 54 sort         39 copyWithin     30 includes    30 toSpliced
 24 findLast     24 findLastIndex  24 flatMap     24 push
 23 find         23 findIndex      23 join        23 pop
```

Most failing tests follow the same shape:

```js
Array.prototype.METHOD.call(obj, callback);
```

where `obj` is an **arguments object**, a **`new String("...")` wrapper**,
or a plain object with a `length` property (sometimes installed via
`Object.defineProperty` as an accessor). The compiler's array-like
dispatch path in `src/codegen/array-methods.ts` handles many cases, but
silently produces wrong results on several sub-patterns.

Sample failures:

| Test | Pattern | Symptom |
| --- | --- | --- |
| `filter/15.4.4.20-1-15.js` | `.call(arguments, cb)` | newArr[0]/newArr[1] missing |
| `some/15.4.4.17-1-8.js` | `.call(new String("…"), cb)` | callback `this` / `obj` wrong |
| `indexOf/15.4.4.14-2-7.js` | `.call({1:true, length:2}, true)` | returns 2 instead of 1 |
| `every/15.4.4.16-1-15.js` | `.call(arguments, cb)` returns false | returns true |
| `map/15.4.4.19-1-7.js` | callback throws or non-callable | "object is not a function" |
| `reduce/15.4.4.21-10-4.js` | array-like with sparse holes | wrong accumulator |
| Various | "ctors is not defined" / "$262 is not defined" | host helpers in test harness — skip filter? |

Error-mode distribution across all 2,810:
- 1,311 — assertion failed with no thrown error (silent wrong result)
- 948 — `returned <code>` (assertion threw `Test262Error`)
- 172 — invalid Wasm / compile error
- 38+19 — `ctors is not defined` (TypedArray harness leaking in)
- 19 — `timeout (30s)`
- 16 — `object is not a function`
- 14 — `array element access out of bounds`
- 12 — `illegal cast`

## Failure count

2,810 in `built-ins/Array/prototype/`. Realistically tractable: **~1,400**
(excluding `ctors is not defined` TypedArray harness leakage [~60],
host-only tests `$262`/`getClass` [~25], timeouts [~19], and tests that
require full property-descriptor support already tracked by #1460).

## Root cause

In `src/codegen/array-methods.ts`:

1. The generic array-like loop (~lines 1134–1300) reads `length` once
   via `__getProp` and assumes integer values. It does not run
   `ToLength` / `ToIntegerOrInfinity`, so accessor-`length`, NaN, and
   negative values produce wrong iteration bounds.

2. Holes (`HasProperty(obj, idx) === false`) are not skipped for
   `forEach`/`map`/`filter`/`every`/`some`/`find` — spec §23.1.3.X says
   "If kPresent is true, then …". Currently every index is visited,
   producing wrong callback `this` and including phantom `undefined`s.

3. For `Array.prototype.METHOD.call(stringObj, …)`, the receiver is a
   boxed `String` whose indexed properties are non-configurable data
   properties. The generic loop reads them via `__getProp` but the
   `callback(val, idx, obj)` third arg passes a *different* coerced
   value, breaking `obj instanceof String` checks.

4. `reduce` / `reduceRight` initial-value-omitted overload finds the
   first existing element via a hole-skipping scan — the current
   implementation doesn't.

5. Methods that **mutate** the receiver (`splice`/`push`/`pop`/`shift`/
   `unshift`/`fill`/`copyWithin`/`sort`) on array-like receivers do not
   write back the `length` property nor handle index gaps per spec
   (`Set(O, "length", …, true)`).

6. `indexOf` / `lastIndexOf` use `StrictEqualityComparison` (===) but
   the array-like path appears to use a value-conversion that diverges
   for `+0`/`-0` and NaN.

7. `concat`/`flat`/`flatMap` don't consult `Symbol.isConcatSpreadable`
   on array-like inputs.

## Acceptance criteria

1. `length` is read via `ToLength(Get(O, "length"))` in every generic
   array-like method — NaN/negative/non-integer values clamped per spec.
2. Hole-skipping (`HasProperty`) honoured by `forEach`, `map`, `filter`,
   `some`, `every`, `find`, `findIndex`, `findLast`, `findLastIndex`,
   `reduce`, `reduceRight`, `flat`, `flatMap`.
3. `reduce`/`reduceRight` initial-value-absent: scan to first present
   index; TypeError if none.
4. Mutating methods on array-like receivers write back `length`.
5. `indexOf`/`lastIndexOf` use exact spec `StrictEqualityComparison`
   (handle `+0`/`-0`/`NaN`).
6. `concat`/`flatMap` honour `Symbol.isConcatSpreadable`.
7. Callback's third arg (`obj`) is the original receiver, not a
   coerced copy — `obj instanceof String` etc. should hold.
8. ≥1,200 of the 2,810 failures resolved (≥43% pass-rate).
9. Tests: `tests/issue-1461.test.ts` with one focused case per acceptance bullet.

## Files to inspect

- `src/codegen/array-methods.ts` (lines 346–520 generic dispatch,
  1134–1300 array-like loop, 1516–2100 specific .call patterns)
- `src/codegen/array-reduce-fusion.ts`
- `src/runtime.ts` — `__getProp` / `__hasProp` helpers
- `tests/issue-1461.test.ts`

## Notes

- #1154 (`array-prototype-poisoning`) overlaps slightly — that issue
  is about user code mutating `Array.prototype`; this is about the
  generic-receiver dispatch.
- The "ctors is not defined" 60 tests use a TypedArray harness
  fixture — those should be classified as a separate harness gap, not
  part of this issue's success count.
