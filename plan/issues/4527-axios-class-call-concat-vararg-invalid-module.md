---
id: 4527
title: "axios: class rest dispatch bridge is fixed; finish the remaining dynamic callback ABI"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-21
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: classes, rest-parameters
goal: npm-library-support
related: [3995, 4302]
loc-budget-allow:
  - src/codegen/index.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/codegen/index.ts::emitMethodDispatch
  - src/runtime.ts::resolveImport
  - src/codegen/index.ts::resolveWasmType
files:
  - src/codegen/index.ts
  - tests/dogfood/axios-upstream-suite.mjs
  - tests/issue-4527.test.ts
  - tests/dogfood/axios-upstream-suite-pin.json
  - tests/dogfood/upstream-suite-compile-worker.mjs
---

# axios: the vararg class-method dispatch bridge for `concat` is fixed

## Problem

The original class-rest defect is fixed generically in the dispatch bridge.
The reduced two-class case now compiles and validates, and all 33 selected
Axios modules compile and validate. The remaining limitation is later in the
same host callback path: 208 callbacks stop during module initialization when
an erased numeric callback bridge invokes a Wasm closure with a reference
argument.

The fresh selected slice registers 231 original callbacks: native 231/231,
Wasm 21/231 passed, 2/231 scored assertions failed, and 208/231 stopped in
module initialization. Sixteen other upstream files (414 registrations) stay
explicitly deferred as unavailable infrastructure. Measured 2026-08-21 on the
current Axios pin.

## Mechanism

`__class_call_concat_vararg` uses a per-struct `ref.test` cascade. The old
bridge reused a receiver local across arms and included the receiver slot in
the fixed-parameter slice, so one arm could store a different class type and
the generated call had the wrong stack shape. The fix uses the receiver's
Wasm-indexed rest metadata, counts only fixed user parameters, and reloads the
cast receiver immediately before the `(receiver, rest-vector)` call. It is
generic and covers same-named rest methods on unrelated classes.

## Reproduction

```bash
node --import tsx tests/dogfood/axios-upstream-suite.mjs
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Reduce**: two classes, each with `concat(...xs: any[])` of different
   field shapes, both dynamically called through the host bridge (export the
   instances). Compile with the same options the harness uses; expect the
   identical `local.set` type error. Commit the reduction as
   `tests/issue-4527.test.ts` asserting `WebAssembly.validate` on the binary.
2. **Fix in `emitMethodDispatch`** (src/codegen/index.ts, vararg arm,
   `arity === -1`): the receiver local that holds the `ref.cast` result must
   be per-arm (declare one local per struct type in the cascade) or the cast
   result must stay on the stack for the immediate `call` instead of a
   `local.set`. Follow whichever pattern the fixed-arity arm already uses —
   the error appearing only in the `_vararg` bridge says the fixed-arity
   cascade handles this correctly; mirror it.
3. **Check the `settle` variant** (`call[0] expected (ref null 35)`): same
   cascade, mismatch surfaces at the call instead of the local store — one
   fix should cover both; assert both files validate.
4. **Validation gates**: (a) the reduction test is present and green; (b) the
   Axios harness keeps all 33 selected modules validated and records the exact
   21/231 Wasm result; (c) equivalence and the host-bridge arity tests stay
   green. The remaining callback ABI work is tracked separately below.

## Remaining callback ABI checkpoint

The runtime now normalizes a WasmGC closure before invoking the existing
`__call_1_f64`/`__call_2_f64` host bridge. This removes the misleading
`fn is not a function` failure, but the bridge still carries its argument as a
number. Axios's `typeOfTest` callback receives a string element and then fails
at `toLowerCase`. A reference-preserving bridge must be registered before the
function-index freeze and must preserve closure identity through module init;
an experimental late bridge exposed a null-closure trap and was intentionally
not retained. Do not count this as fixed until a focused reduction passes both
module initialization and callback execution.

## Acceptance criteria

### Current checkpoint (2026-08-21)

The selected 33 modules all compile and validate. The reduction is committed.
The exact fresh result is 21/231 Wasm callbacks passed, 2/231 scored failures,
and 208/231 module-initialization failures; 16 upstream files remain deferred
as unavailable infrastructure. The remaining checkbox is the reference-valued
callback ABI, which must be fixed without a module-init closure trap.

- [ ] All 25 axios test modules validate.
- [ ] Reduction test committed; general fix, no axios-specific casing.
- [ ] Fresh axios pass/total recorded in this file after the fix.
