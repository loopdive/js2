---
id: 6417
title: "axios residual round 2: 23 failures across eight files after the under-applied `.call` receiver fix"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

axios is **208/231** on `upstream/main` `cf82f78d6d` + the
[#5341](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5341-axios-residual-buckets)
receiver fix (202 before it). The six tests that moved were the whole
`transformData`/`transformResponse` bucket. What is left is what #5341
explicitly did not take, re-measured after it, plus one bucket that #5341's
own evidence mis-attributed.

## Evidence (2026-09-12, `tests/dogfood/report/axios-upstream-suite.json`)

```
 3  TypeError: Cannot access property on null or undefined   buildURL.test.js
 3  assertion 1 toEqual mismatch                             isX.test.js
 2  assertion 1 instance mismatch                            validator.test.js   (0/2)
 2  validation function expected "true". Received 1          fromDataURI.test.js
 2  randomFillSync is not a function                         platform.test.js    ← host shim gap
 1  Function.prototype.bind called on incompatible undefined buildURL.test.js
 1  assertion 1 toEqual mismatch                             buildURL.test.js
 1  assertion 1 toBe: string:undefined != string:function    buildURL.test.js
 1  assertion 1 instance mismatch                            AxiosError.test.js
 1  assertion 2 instance mismatch                            settle.test.js
 1  assertion 1 toBe: object:null != boolean:true            AxiosError.test.js
 1  assertion 1 expected contained value                     AxiosError.test.js
 1  assertion 1 toBe: object != object                       AxiosError.test.js
 1  assertion 1 toBe: object:null != boolean:true            canceledError.test.js
 1  RuntimeError: dereferencing a null pointer               composeSignals.test.js
 1  validation function expected "true". Received 1          transformResponse.test.js
```

Ordered by what a single mechanism would buy:

1. **`buildURL` (6)** — the biggest single file. Three shapes, probably one
   cause: `AxiosURLSearchParams` construction/`toString(_encode)` returning
   nullish. Note `should be exported as a named export` reports the module's
   own `buildURL` binding as `string:undefined` where `function` is expected,
   which points at the module-shape side rather than the body.
2. **The `instance mismatch` cluster (4)** — `validator` ×2, `AxiosError` ×1,
   `settle` ×1. `instanceof` against a class that crossed the host boundary;
   same family as #5325's residual and #5347. **Check #5347 first and fix it
   there once** rather than locally here.
3. **`The validation function is expected to return "true". Received 1` (3)** —
   `fromDataURI` ×2, `transformResponse` ×1. Node's `assert.throws(fn,
   validator)` requires the validator to return literally `true`; a compiled
   validator returning a boolean answers `1` to the host caller. If that is a
   boolean→number boxing at the function-RETURN host boundary it is one
   narrow mechanism worth taking on its own — verify before assuming, the
   validators also contain an `instanceof` that may be failing for reason 2.
4. **`isX` (3)** — `ArrayBuffer`, `ArrayBufferView`, `Date` type predicates.
5. **`util.types.isNativeError` answers `null` (2)** — `AxiosError` and
   `canceledError` both assert a compiled Error subclass is recognised as a
   native error by Node; the host call answers `null`.
6. **`composeSignals` (1)** — the one remaining trap in axios. `AbortSignal`
   composition through `addEventListener` callbacks; capture-cell family
   (#5320/#5323).
7. **`platform` (2) is NOT a compiler bug.** `randomFillSync` is a Node
   `crypto` builtin the host shim does not expose. Record, do not fix.

So the compiler-addressable ceiling here is **229/231**, and the realistic
next step is 1 + 2 (10 tests).

## Acceptance criteria

1. axios ≥ 214/231, or an equivalent gain if a target bucket turns out to be
   non-compiler.
2. One PR per independent cause; a cause shared with #5347 lands there.
3. Regression tests with untyped `.js` two-file fixtures, failing on the
   parent, with an anti-vacuity control.
4. A/B at one HEAD over the 17 dogfood suites, per test file.
