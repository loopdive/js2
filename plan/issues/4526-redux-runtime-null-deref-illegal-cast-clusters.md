---
id: 4526
title: "Redux: 55/82 — remaining observable, lexical-shadowing, and dynamic-call clusters"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-25
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen, runtime
language_feature: closures, objects
goal: npm-library-support
related: [3996, 3995, 4370, 4456]
oracle-ratchet-allow:
  - src/codegen/module-namespace-value.ts
files:
  - tests/dogfood/redux-upstream-suite.mjs
  - tests/dogfood/upstream-suite-runner.mjs
  - tests/issue-3996-redux-runtime.test.ts
  - src/codegen/closures.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/module-namespace-value.ts
  - src/runtime.ts
---

# Redux: 55/82 pass; 27 runtime-semantic failures remain

## Current result

The pinned Redux 5.0.1 suite now compiles and validates all 9 upstream test
modules. The runner discovers and executes all 82 original registration sites:

- Node oracle: **82/82**
- Wasm: **55/82**
- unavailable infrastructure: **0**
- compile/validate: **9/9**

This was measured on 2026-08-25 with:

```bash
node --import tsx tests/dogfood/redux-upstream-suite.mjs --json
```

Per-file: `createStore.spec` 28/42 · `combineReducers.spec` 11/16 ·
`bindActionCreators.spec` 4/7 · `compose.spec` 6/6 ·
`applyMiddleware.spec` 2/5 · `utils/*` 4/6.

The old 13/82 artifact was stale. Reproduction on the synced branch established
13/82 as the compiler/runtime baseline, then the generic fixes below moved the
same unchanged denominator through 35/82, 38/82, 47/82, and finally 55/82.

## Generic fixes completed in this slice

1. **Same-compilation ESM namespace values.** Namespace-imported compiled
   functions can now be materialized as first-class callable values, and an
   all-function namespace can be materialized as a stable enumerable object.
   Mutable or mixed namespaces still fail closed until live-binding getters
   exist. The issue's oracle-ratchet allowance covers the new module's four
   symbol/export queries; the oracle does not yet expose module-export
   enumeration or alias resolution.
2. **Runtime table callable dispatch.** A local initialized or assigned from an
   element read no longer trusts an unrelated spelling-based closure signature.
   Calls use the value actually loaded from the table. This fixes reducers read
   through `reducers[key]` without weakening ordinary typed local calls.
3. **Structural closure arguments.** Anonymous object parameters of lifted
   closures use the open externref carrier instead of nominally casting one
   structurally-compatible object allocation to another `__anon_*` WasmGC
   type. Branded vectors, strings, and classes remain specialized.
4. **Dynamic argument conversion.** Dynamic calls materialize concrete vector
   parameters from externref and map explicit `undefined` to the typed-null or
   numeric sentinel expected by default-parameter prologues.
5. **Retained callable identity.** Map/Set methods normalize retained Wasm
   closure structs to identity-cached callable host bridges. Structural
   `subscribe(callback)` arguments are classified as deferred captures.
6. **Live spy call records.** The shared upstream harness reconstructs
   `mock.calls` from its canonical flat call log on every read instead of
   exposing a nested vector snapshot that becomes stale across the boundary.
7. **Untyped call-of-call dispatch.** When an inner JavaScript call has no
   checker signature but returns a compiled closure at runtime, `select(fn)()`
   now evaluates the inner call once and uses the normal dynamic callable
   ladder. Typed call-of-call paths are unchanged.
8. **Capturing rest-closure self shape.** A capturing rest closure publishes
   its fresh nominal subtype while its lifted body is compiled. A later
   `reduce` iteration can therefore recognize an earlier instance of the same
   closure and pack positional arguments into the rest vector. Redux `compose`
   is now **6/6**.

Focused coverage lives in `tests/issue-3996-redux-runtime.test.ts`. Together
with adjacent call-of-call and closure-cast suites it passes **27/27**. The one
failure in `tests/issue-149-patterns.test.ts` (`conditional call with closure
branches`) reproduces unchanged on the exact clean base and is not a withdrawal
from this slice.

## Remaining 27 failures

1. **applyMiddleware: 3**
   - 2 calls resolve a nested `function test(...)` to the same-named top-level
     harness registrar. This is the known lexical ownerless-function shadowing
     residual in [#4456](4456-nested-same-name-function-aliasing.md); a broad
     `funcMap` suppression was tested and rejected because it withdrew working
     namespace-reducer dispatch.
   - 1 thunk path returns `null is not a function`.
2. **bindActionCreators: 3**
   - 2 action/dispatch results mismatch the native oracle.
   - 1 returned `boundActionCreator` is still non-callable.
3. **combineReducers: 5**
   - 3 expected reducer-shape/private-action throws are not observed.
   - 2 heterogeneous dynamic reducer calls still trap in `__call_fn_2` with an
     illegal cast.
4. **createStore: 14**
   - 1 public-API key assertion misses a contained value.
   - 2 listener-snapshot cases call null after unsubscribe/nested dispatch.
   - 2 native callback bridges dereference null captures (`__cb_79`, `__cb_82`).
   - 2 plain-action/error-description assertions miss expected throws.
   - 7 observable tests do not yet preserve the `@@observable` member and
     returned subscription object across the module/runtime boundary.
5. **utility predicates: 2**
   - `isPlainObject` misclassifies the first plain object.
   - `isAction` inherits the plain-object/prototype semantic mismatch.

## Handoff

Work the remaining clusters without changing upstream expectations, hiding
infrastructure, caching answers, or introducing Redux-specific rewrites:

1. Land the narrow ownerless top-level/nested declaration scope fix described
   by [#4456](4456-nested-same-name-function-aliasing.md), with paired restoration
   tests. Do not revive the rejected blanket `nestedBindingVisible` func-map
   suppression.
2. Reduce the seven observable failures around the symbol/string-key carrier
   and live object method return. Verify that the observable object and its
   `subscribe`/`unsubscribe` values remain callable rather than null.
3. Reduce listener removal and nested dispatch to a collection snapshot of
   retained closures; distinguish missing values from stale capture cells.
4. Re-run all 82 before separating the remaining bind/thunk and
   `combineReducers` `__call_fn_2` casts. They may share another heterogeneous
   callable-result carrier.
5. Fix `Object.getPrototypeOf`/plain-object semantics generically, then recheck
   both utility predicates and the missing action-validation throws.

## Acceptance criteria

- [ ] All 82 original Redux tests are registered and executed; Node remains
      82/82 and unavailable infrastructure remains 0.
- [ ] The 27 remaining failures are fixed by generic compiler/runtime behavior,
      each with focused regression coverage.
- [ ] Redux reaches 82/82 Wasm without changing upstream expectations or
      suppressing failures.
- [ ] Focused closure/call tests, typecheck, compiler ratchets, and the full
      pinned Redux suite remain green.
