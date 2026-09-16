---
id: 6490
title: "Linked harness provider: testWithTypedArrayConstructors dereferences null on every call — ~1,340 TypedArray rows differ"
status: ready
sprint: current
created: 2026-09-16
updated: 2026-09-16
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: typed-arrays
goal: test262-conformance
depends_on: [3451]
related: [3451, 6486, 6487]
---

# #6490 — `testWithTypedArrayConstructors` null deref in the provider

## Problem (first full-corpus run, 2026-09-16, run 35116762391)

Parity buckets `dereferencing a null pointer [in testWithAllTypedArrayConstructors() ← testWithT…]`
700 and `… ← __fn_tram…` 639: every row that calls the `testTypedArray.js`
helper through the provider fails. Minimal repro (smoke, `.tmp/p6490`,
2026-09-16, current main incl. #6487):

```js
/*--- includes: [testTypedArray.js, compareArray.js] ---*/
var n = 0; testWithTypedArrayConstructors(function () { n++; }); assert.sameValue(n > 0, true);
```

fails `dereferencing a null pointer` in the linked lane; `typedArrayConstructors.length`
read from the body passes, so the provider's list exists. Passing an explicit
consumer array or the provider's own `typedArrayConstructors` back changes
nothing. #6487 did not change it.

## What the provider's WAT shows (wasm-dis of the propertyHelper+testTypedArray provider)

`testWithTypedArrayConstructors(param $0..$3 externref)`; the body starts by
materialising `constructors || typedArrayConstructors` through
`__make_iterable(extern.convert_any(global $global$4))` → `__array_from_iter`
→ `ref.cast (ref null $5)` into a fresh `array.new_default $1` filled via
`__extern_get(…, __box_number(i))`. The null deref is somewhere after that
materialisation — the first suspect is the element read: `__extern_get` on the
provider-side vec through the HOST returns the constructor as an externref
mirror, and the following `ref.cast` to the provider's closure/struct type for
the `f(TA)` call (or the `TA.prototype`/`new TA(…)` access inside
`testWithAllTypedArrayConstructors`) sees null.

## Implementation Plan (2026-09-16, Fable lane; implementation: Opus)

1. Reproduce with the body above via `scripts/test262-linked-harness-smoke.mts`
   (delete `.tmp/linked-smoke` first — #6488) and get the trap's function
   trace (`JS2WASM_DEBUG_*` / wasm-dis of the provider: `node_modules/binaryen/bin/wasm-dis`).
   Name the exact instruction that traps.
2. Determine whether the trap is (a) a provider-internal lowering that is wrong
   whenever the helper is called with fewer than 4 args from the host bridge
   (`__call_fn_N` dispatcher passing `undefined`/null for missing externref
   params — check `__extern_is_undefined` handling of a null externref), or
   (b) a cross-module value (the consumer callback `f`) cast to a provider
   type. Test (a) by compiling the harness+body honest with the helper called
   through a function value (`var g = testWithTypedArrayConstructors; g(cb)`)
   and by calling the provider export directly from Node with 1 arg.
3. Fix at the root (codegen or runtime dispatcher), not in the harness.
4. Measure: the repro, then `built-ins/TypedArray/prototype/fill` first 20 via
   the smoke, then the next `linked_lane` dispatch (expect both buckets → 0).

## Acceptance

- [ ] Repro passes linked; `TypedArray/prototype/fill` first 20 agree with honest.
- [ ] Honest lane byte-identical or the delta measured and explained.
