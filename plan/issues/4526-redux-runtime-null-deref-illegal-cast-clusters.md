---
id: 4526
title: "Redux: 55/82 — remaining observable, lexical-shadowing, and dynamic-call clusters"
status: done
completed: 2026-10-05
done_scope: "Clusters A-E of the 2026-10-05 wave-10 slice (Redux 67/82 -> 76/82). Remaining rows routed: F -> #6852, G -> #6853, H wont-fix (#5347); an element-access-call trap found while reducing D -> #6854."
sprint: current
created: 2026-08-16
updated: 2026-10-05
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen, runtime
language_feature: closures, objects
goal: npm-library-support
related: [3996, 3995, 4370, 4456]
# 2026-10-05 (wave-10 slice) — the mechanisms live in two NEW leaf modules
# (expressions/apply-dynamic-arglist.ts, object-model/runtime-key-open-object.ts)
# plus one allowlist entry in runtime/wasm-vec-prototype.ts; src/runtime.ts is
# untouched (#4401 ceiling). What lands in the god-files is the wiring:
# calls.ts +9 (Case-1 registry/dynamic-apply gate), closures.ts +6 (callback
# capture boxing — the decision must be made in compileArrowAsCallback's own
# capture loop), index.ts +4 (one resolveWasmType arm, lockstep with the
# literal's host path), object-ops.ts +5 (same predicate for Object.keys),
# import-resolver.ts +24 (setImmediate/clearImmediate timer shim —
# the shim table lives there), calls-closures.ts +3 (`includes` joins the
# existing String∩Array refusal list in tryExternClassMethodOnAny).
loc-budget-allow:
  - src/codegen/expressions/calls.ts
  - src/codegen/closures.ts
  - src/codegen/index.ts
  - src/codegen/object-ops.ts
  - src/import-resolver.ts
  - src/codegen/expressions/calls-closures.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/index.ts::resolveWasmType
  - src/codegen/object-ops.ts::compileObjectKeysOrValues
  - src/codegen/expressions/calls-closures.ts::tryExternClassMethodOnAny
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

## 2026-10-05 wave-10 slice — Implementation Plan

Base measured on upstream main `c3e3fab33d` (2026-10-05): **67/82 Wasm**,
82/82 native. The 15 failing rows grouped by root cause from the suite report:

| cluster | rows | mechanism (measured on two-file fixtures under `.tmp/`) |
| --- | --: | --- |
| A `.apply` with a runtime list | 3 bind + feeds createStore | `actionCreator.apply(this, args)`: Case 1 of the identifier `.call/.apply` lowering read the graph-wide `funcMap` by NAME (a test file's nested `function actionCreator` captured Redux's parameter), and its static arms only spread an array LITERAL — any runtime list called the target with ZERO args and no receiver |
| B `setImmediate` | 2 applyMiddleware | no binding for a bare `setImmediate(cb)` call (the timer shim covered setTimeout/setInterval only) |
| C callback capture of its own initializer's const | 2 createStore | `const unSubB = store.subscribe(() => { …; unSubB() })` — `compileArrowAsCallback` boxed only captures written in the callback; the ordinary closure path's `closurePrecedesBindingInitializerStore` rule was missing, so the TDZ hole (null) was snapshotted |
| D runtime computed key | 1 createStore | `{ subscribe(){}, [$$observable]() {} }` is built as an open object (`_hasRuntimeComputedKey`) but its mixed type `{subscribe; [x: number]: …}` lowered to a closed struct, so every return/param slot took a snapshot that dropped the runtime-keyed member |
| E inherited Array.prototype member | 1 createStore (`toContain`) | a dynamic `actual.includes` read on a compiled array reached `__extern_get`, which answered own data only — `typeof actual.includes` was `"undefined"`; and the dynamic CALL `actual.includes(x)` on an `any` receiver bound the first ambient extern class declaring `includes` — DOM's `IDBKeyRange` — and answered `false` |
| F per-literal method fork vs host dispatch | 2 createStore | → [#6852](6852-objlit-method-host-dispatch-ignores-per-literal-fork.md) |
| G TS `number` param / method mixed return | 3 combineReducers | → [#6853](6853-ts-number-param-undefined-and-method-mixed-return.md) |
| H `vm.runInNewContext` | 1 isPlainObject | wont-fix (second realm), recorded in #5347 |

Fix plan (A–E, generic, no Redux-specific code):

- A: `expressions/apply-dynamic-arglist.ts` — `mappedFunctionIsForeign`
  (a parameter/variable/binding never owns another declaration's registry
  entry) and `isDynamicApplyArgList`; on the JS host a runtime list skips the
  static arms and takes the existing reflective host-call tail (receiver and
  list applied by the host). Standalone keeps its lowering.
- B: `import-resolver.ts` timer shim lowers `setImmediate(cb)` /
  `clearImmediate(h)` onto the existing callback-aware timeout capability
  (no new host import).
- C: `compileArrowAsCallback` adds the same initializer-store rule as
  `planClosureCaptures`.
- D: `object-model/runtime-key-open-object.ts` — `resolveWasmType` (and `Object.keys`'s
  static fold) treat an object-literal type whose literal took the
  runtime-key path as externref, in lockstep with the value side.
- E: `runtime/wasm-vec-prototype.ts` — the JS-host vec prototype bridge
  (deliberately limited to reflective `slice` by an earlier Moment fix, so
  native search/mutating methods do not bypass compiled sidecar properties)
  admits `includes` as its second member; measured host `--isolate` on
  `built-ins/Array/prototype/{includes,slice}` (101 rows, including the
  `[].includes.call(<object>)` length rows): 82/19 before and after, identical
  rows. And `includes` joins the `tryExternClassMethodOnAny` String∩Array
  ambiguity refusals (`indexOf`, `slice`, …) so an `any` receiver dispatches
  on its runtime shape.

## Resolution (2026-10-05)

Clusters A–E landed as planned; all on upstream `c3e3fab33d`, measured base
(file-copy A/B, every file swapped together) vs fix at one HEAD, suites run
one at a time:

| suite | base | fix | flips |
| --- | --: | --: | --- |
| redux | 67/82 | **76/82** | +9 / −0 |
| lodash | 59/62 | 60/62 | +1 / −0 |
| axios | 208/231 | 210/231 | +2 / −0 |
| hono | 271/324 | 272/324 | +1 / −0 |
| prettier | 75/151 | 75/151 | 0 |
| jest | 336/356 | 336/356 | 0 |
| marked | 16/30 | 16/30 | 0 |
| uuid | 75/75 | 75/75 | 0 |
| clsx | 32/32 | 32/32 | 0 |
| cookie | 63740/63740 | 63740/63740 | 0 |
| moment | 10/10 | 10/10 | 0 |

Standalone test262, scoped to the touched surface (507 rows:
`built-ins/Function/prototype/{apply,call}`, `language/computed-property-names`,
`built-ins/Object/keys`, `language/expressions/object/method-definition`):
443 pass / 47 fail / 17 CE on BOTH sides, identical non-pass row sets. Host
lane `--isolate` on the 97 apply/call rows: 84/13 on both sides, identical.

Regression coverage: `tests/issue-4526-redux-wave10.test.ts` (5 tests, two-file
untyped fixtures, expected values computed by Node running the same files);
all 5 fail on the parent and pass with the fix.

Residual Redux rows (6): 3 combineReducers → #6853; 2 observable integration
→ #6852; isPlainObject → wont-fix (`vm` realm, #5347).

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
