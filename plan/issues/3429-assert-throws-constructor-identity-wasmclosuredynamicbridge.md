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
