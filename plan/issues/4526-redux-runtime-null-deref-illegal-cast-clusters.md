---
id: 4526
title: "Redux: 55/82 — remaining observable, lexical-shadowing, and dynamic-call clusters"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-27
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
loc-budget-allow:
  - src/codegen/closure-exports.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/closure-exports.ts::emitClosureCallExportN
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
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

## 2026-08-28 host-import policy ratchet (native-first 394 → 395)

`check:host-import-policy` failed the `quality` gate on this branch with
`native-first imports 395 > maximum 394`. Measured on both sides of the only
relevant hunk (`src/codegen/closure-exports.ts` reverted to `origin/main` and
back, per-probe totals from the gate's own probe set):

| metric | base (`origin/main`) | this branch |
| --- | --- | --- |
| native-first `imports` | 394 | 395 |
| native-first `legacySemanticImports` | 0 | 0 |
| native-first `unknownImports` | 0 | 0 |
| compatibility legacy imports | 23 | 23 |
| `runtimeTsLines` / `resolveImportLines` / `resolveImportCases` | unchanged | unchanged |
| `ownedAdapterLines` / `explicitCapabilityLines` | unchanged | unchanged |

The single added import is `__unwrap_for_wasm` in the `proxyRevocable` probe
(every other probe is byte-identical). It comes from this issue's host-facade
unwrap in `emitClosureCallExportN`: recovering the original Wasm value before
the concrete `ref.cast` is what preserves callable identity across a dynamic
callback result, which is the fix itself — so the import is not avoidable
without withdrawing the behavior. It is already gated off for host-free
targets (`!ctx.standalone && !ctx.wasi`), and it is a `value-adapter` in
`src/host-import-policy.ts`, not a `legacy-semantic` or `unknown` provider, so
every zero-debt metric the gate exists to police stays at **0**.

`plan/audit/host-import-policy-baseline.json` is therefore ratcheted to the
exact measured value (394 → 395, no rounding), following the precedent of
#3481 and #4771 — the maximum is raised in the PR that needs it, with the
before/after measurement recorded here.

## 2026-08-27 bounded heterogeneous-callable ABI checkpoint

The preserved `98c7955` checkpoint was rebased onto current `origin/main`
(`220ce6c4913ddb`); Git identified that commit's patch as already represented
upstream, so the branch retains the checkpoint's behavior without a broad
merge commit. This follow-up is limited to the generic dynamic callable
carrier/capture paths and a linked middleware regression; it does not alter
Redux fixtures or expectations.

The exact unchanged Redux v5.0.1 upstream suite remains **82/82 native** and
**59/82 Wasm** (**23 failed**, **0 runtimeFailed**). All **9/9 selected modules
compiled and validated**, with **82/82 registrations**, **0 deferred**, and
**0 unavailable infrastructure**. Per-file Wasm results are:
`applyMiddleware` **2/5**, `bindActionCreators` **4/7**,
`combineReducers` **13/16**, `compose` **6/6**, `createStore` **30/42**,
`formatProdErrorMessage` **1/1**, `isAction` **0/1**, `isPlainObject` **0/1**,
and `warning` **3/3**. This is **+4 rows with zero withdrawals** from the
merged-main 55/82 checkpoint.

The generic implementation keeps heterogeneous callable captures on the
runtime candidate ladder, pre-registers callable values from assignments and
all linked source files, preserves enclosing destructured parameter bindings
when their spelling collides with a mapped function declaration, and unwraps
host facades before concrete reference casts. A focused Redux runtime file
passes **19/19**, including the linked `applyMiddleware`/`thunk` regression;
`pnpm run typecheck` is clean.

The 23 remaining failures are unchanged mechanisms outside this slice:
`applyMiddleware` has two nested lexical-owner errors and thunk's missing
`setImmediate`; `bindActionCreators` has three equality/result-shape
mismatches; `combineReducers` has three expected-throw matching gaps;
`createStore` has one public-API key mismatch, two retained-listener null
calls, two action/error-description mismatches, and seven observable
carrier/member failures; `isAction` and `isPlainObject` share two generic
plain-object/prototype predicate failures. The branch checkpoint is ready for
review but remains unmerged.

## 2026-08-26 combined integration report audit

The fresh combined report reproduces **55/82 Wasm** and **82/82 Node** on all
82 original Redux registrations. The **27/82** remaining rows are scored
compatibility failures, not skipped tests. All **9/9 modules compile and
validate**, and unavailable infrastructure remains **0**.
