---
id: 3429
title: "Host assert.throws: expected error constructor rendered as internal 'wasmClosureDynamicBridge' (544 records) under oracle v8"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: test262-runner, codegen
language_feature: error-constructors
es_edition: multi
goal: test262-conformance
related: [3370, 1104]
origin: "2026-07-18 oracle-v8 harvest (fable harvest agent): host `other` sub-bucket @ oracle 8."
---

# #3429 — assert.throws constructor identity leaks internal 'wasmClosureDynamicBridge'

## Problem

544 host tests fail with the internal implementation name
`wasmClosureDynamicBridge` appearing where an error-constructor identity should
be, in `assert.throws` verdicts:

```
Expected a wasmClosureDynamicBridge but got a TypeError
Expected a wasmClosureDynamicBridge to be thrown but no exception was thrown at all
?GetValue(lhs) throws. Expected a wasmClosureDynamicBridge but got a Array
```

Samples:
```
test/built-ins/Array/prototype/reduceRight/15.4.4.22-4-11.js
test/language/expressions/assignment/dstr/array-rest-lref-err.js
test/language/expressions/division/order-of-evaluation.js
test/language/expressions/compound-assignment/S11.13.2_A7.8_T1.js
test/language/expressions/compound-assignment/S11.13.2_A7.8_T3.js
```

## Root cause (hypothesis)

Consequence of #3370. The synthetic wrapper previously shimmed `assert.throws`;
the authoritative harness now does the real constructor-identity check
(`err.constructor === TypeError`). The expected-constructor argument passed to
`assert.throws` (e.g. `TypeError`, `ReferenceError`) is being represented at
runtime as the internal `wasmClosureDynamicBridge` closure rather than the named
error constructor, so the harness's identity/`.name` read returns
`wasmClosureDynamicBridge`. Two failure shapes appear:

- `Expected a wasmClosureDynamicBridge but got a TypeError` — the thrown error is
  correct (a real `TypeError`) but the *expected* constructor reference is
  mangled, so the identity comparison fails a test that should pass.
- `Expected a wasmClosureDynamicBridge ... but no exception` / `... but got a
  Array` — genuinely no-throw or wrong-throw cases, but the message still shows
  the constructor identity leak.

The fix is to give error constructors passed as first-class values (into
`assert.throws`) a correct constructor identity / `.name`, rather than a dynamic
bridge closure. Overlaps #1104 (wasm-native error construction).

## Acceptance criteria

- A minimal `assert.throws(TypeError, () => { throw new TypeError() })` passes;
  the verdict message names `TypeError`, never `wasmClosureDynamicBridge`.
- The `wasmClosureDynamicBridge` string no longer appears in any assert.throws
  verdict; the 544-record class drops to ~0 (remaining genuine no-throw failures
  reclassify to their real cause).

## Cross-reference

Consequence of #3370 (real constructor-identity behavior). Related: #1104
wasm-native error construction.

## Implementation Plan (architect, 2026-07-19 — reproduced through the real runner; leading mechanism identified)

### Repro (confirmed)

Both failure shapes reproduce via `runTest262File` (host lane, literal harness):
- `built-ins/Array/prototype/reduceRight/15.4.4.22-4-11.js` →
  `Expected a wasmClosureDynamicBridge but got a TypeError`
- `language/expressions/division/order-of-evaluation.js` →
  `?GetValue(lhs) throws. Expected a wasmClosureDynamicBridge but got a Array`

### Root cause (leading hypothesis — receiver shift at the closure method-call bridge)

A bare `TypeError` identifier as a VALUE compiles correctly to the real host
constructor via the `global_TypeError` import (verified by WAT: `take(TypeError)`
emits `call $global_TypeError`) — the expected-ctor ARGUMENT is NOT mangled at
the read site, with or without `new TypeError()` elsewhere in the module.

The corruption happens at the CALL of `assert.throws(...)`. `assert.throws` is a
compiled closure stored as a property of the function-object `assert`
(function-with-properties sidecar); invoking it routes through the host
method-call machinery (`__extern_method_call`, `src/runtime.ts:~10490`) onto the
`wasmClosureDynamicBridge` wrapper (`src/runtime.ts:1246`). That wrapper's
METHOD-call arm (`src/runtime.ts:~1262`, `this !== undefined && this !==
globalThis`) dispatches via `__call_fn_method_N(closure, receiver, ...args)`
(`emitClosureMethodCallExportN`, `src/codegen/index.ts`). If the compiled
`assert.throws` closure's formals receive the RECEIVER as formal #0 (a plain
function expression has no `this` slot in its wrapper signature), every
argument shifts by one:

- `expectedErrorConstructor` ← the receiver = the `assert` bridge function,
  whose host-visible `.name` is **`wasmClosureDynamicBridge`** — matches shape 1
  verbatim (`Expected a wasmClosureDynamicBridge but got a TypeError`);
- `func` ← the real `TypeError` ctor — `typeof func === "function"` passes,
  `func()` = `TypeError()` returns (never throws) → matches shape 2 verbatim
  (`…to be thrown but no exception was thrown at all`).

Both observed messages are exactly predicted by a one-slot receiver shift.
Note `assert.sameValue` does NOT hit this (it dispatches through a different,
statically-recognized path — the dev should confirm which gate diverts
`throws`: possibly arity, possibly the `func()` dynamic-call body shape).

### Fix steps

1. **Confirm the shift** with a 5-line probe through `runTest262File`: harness +
   `assert.throws(TypeError, function(){ throw new TypeError(); })`, plus a
   temporary log of the first formal inside a compiled 3-param function-property
   closure invoked host-side. Compare dispatch arms in
   `emitClosureMethodCallExportN` (`src/codegen/index.ts`) — specifically how
   the receiver slot maps onto formals for NON-method closures (function
   expressions assigned as properties) vs real methods.
2. **Fix at the dispatch layer**, not per-builtin: the method-call arm must pass
   the receiver ONLY to closures that bind `this` (method-shaped wrappers); a
   plain function-expression closure gets `args` unshifted. The `__closure_arity`
   probing in the bridge (runtime.ts:1244-1290, the #2623 P-7/B-1 block) already
   distinguishes arity — extend the closure metadata with a "binds this" bit if
   the wrapper type alone can't discriminate.
3. Re-run the 544-record sample list; residual genuine no-throw cases will
   reclassify to their real cause (some land in #3430).

### Edge cases
- Do not regress real method dispatch (`obj.m(...)` with receiver) — the #2664
  acorn omission hazard and the #2623 exact-arity dispatch tests must stay green.
- `assert.throws.call(assert, TypeError, fn)` / detached
  `var t = assert.throws; t(TypeError, fn)` should behave identically after the
  fix (receiver undefined → plain-call arm).
- Overlaps #1104 (wasm-native error construction) only for the `.name` read;
  the shift fix does not depend on it.

### How to test
- `tests/issue-3429.test.ts`: minimal `assert.throws(TypeError, thrower)` via
  `runTest262File` must pass; message must never contain
  `wasmClosureDynamicBridge`.
- Scoped: the 5 sample files in this issue + a compound-assignment
  `S11.13.2_A7.8_T*` pair.
