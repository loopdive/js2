---
id: 4526
title: "Redux: 13/82 — combineReducers null-deref, dynamic-dispatch illegal cast, createStore dispatch illegal cast"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-20
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen, runtime
language_feature: closures, objects
goal: npm-library-support
related: [3996, 3995, 4370]
files:
  - tests/dogfood/redux-upstream-suite.mjs
  - src/codegen/closures.ts
  - src/runtime.ts
---

# Redux: runtime clusters keep the pinned suite at 13/82

## Problem

The pinned Redux 5.0.1 upstream suite compiles and validates **all 9 modules**
(the #3996 `local index out of range` emit failures are gone). The shared
runner now supplies Node's `global` alias, so all **82/82 callbacks pass in
Node** and **13/82 admitted tests pass in Wasm** with no harness-incompatible
callbacks. Measured 2026-08-20 on the current branch; the remaining failures
are the runtime clusters below, not unavailable test infrastructure.

Per-file: `createStore.spec` 2/42 · `combineReducers.spec` 6/16 ·
`bindActionCreators.spec` 0/7 · `compose.spec` 1/6 · `applyMiddleware.spec`
1/5 · `utils/*` 3/6.

The detailed bucket inventory below is retained from the pre-global-alias
reproduction; it needs a fresh runtime re-bucketing against the 13/82 baseline.
The global alias change only removed harness incompatibility and did not claim
to fix any of these compiler/runtime clusters.

## Measured failure buckets (pre-global-alias snapshot)

1. **40× `RuntimeError: dereferencing a null pointer`** — one stack shape
   dominates `createStore.spec` and `combineReducers.spec`:

   ```text
   at __closure_171
   at combineReducers
   at __closure_411 / __closure_354
   at __call_fn_method_1 → wasmClosureDynamicDispatch
   ```

   A closure invoked *inside* `combineReducers` reads a null capture/field.
   Redux's `combineReducers` iterates `Object.keys(reducers)` and calls each
   reducer through a captured object — consistent with a capture or
   object-field slot that was never populated for values that crossed the
   host bridge (`assertReducerShape` calls every reducer with
   `{type: ActionTypes.INIT}`).

2. **16× `RuntimeError: illegal cast at __call_fn_2`** (combineReducers.spec,
   utils specs) — the dynamic call trampoline
   (`wasmClosureDynamicDispatch` → `__call_fn_2`, src/runtime.ts:1924) casts
   the callee's argument/closure struct to a shape it does not have.

3. **7× `RuntimeError: illegal cast at dispatch`** (bindActionCreators.spec):

   ```text
   at dispatch (wasm-function[228])
   at createStore (wasm-function[100])
   at __closure_157 → __call_fn_method_0
   ```

   `createStore`'s internal `dispatch({type: ActionTypes.INIT})` traps when
   the store was created through the re-exported `legacy_createStore` /
   bound-creator path — the action object literal fails a struct cast inside
   `dispatch` (`isPlainObject(action)` / property reads on a
   differently-shaped action struct).

4. Remainder: 12 ordinary assertion failures (`toBe: object:null != …` — 
   functions returning null through the bridge), 2 `global is not defined`
   (harness env gap, `warning.spec` writes `global.console`).

#3996's 2026-08-09 decomposition (frame-selection defects in
`observeState`/`bindActionCreator`, invalid binary in `combination`) predates
these measurements; the emit-stage failures it lists are fixed, and these are
the runtime successors.

## Reproduction

```bash
node --import tsx tests/dogfood/redux-upstream-suite.mjs --json
```

## Implementation Plan (Fable; implement per the plan/implement split)

Work the buckets in order — bucket 1 is half the suite and blocks reading
later failures behind it.

1. **Reduce bucket 1**: `createStore.spec` "exposes the public API" is the
   smallest carrier (it only creates a store with `combineReducers({...})`
   and reads keys). Reduce in `.tmp/`: a function that takes an object of
   function-valued fields, iterates its keys, and calls each value through a
   local alias (`const reducer = reducers[key]; reducer(...)`). Suspect: the
   heterogeneous object-literal-of-closures carrier — each spec file defines
   reducers of different shapes, and `__closure_171`'s null read is the
   capture cell for the object field. Cross-check #4370 (externref-array
   receivers for map) and #3749/#3750 (heterogeneous object shapes) — the
   object-of-functions shape here may be the same carrier defect.
2. **Bucket 2/3 likely share a root**: both are casts of an action/argument
   struct at a dynamic call boundary. After bucket 1's fix, re-run the suite
   before investing in these — the counts may collapse (combineReducers
   feeds createStore in most fixtures). If they persist, reduce
   `bindActionCreators.spec` "wraps the action creators with the dispatch
   function": `bindActionCreator` returns
   `function() { return dispatch(actionCreator.apply(this, arguments)) }` —
   an `arguments`-forwarding closure whose return value (an object literal
   from a *different* module scope) crosses into `dispatch`'s cast.
3. **Harness env (bucket 4, cheap)**: define `global` (alias of
   `globalThis`) in the redux harness shim so `warning.spec` scores the real
   behavior — 3 tests. Do this in tests/dogfood/redux-upstream-suite.mjs, not
   the compiler.
4. **Validation gates**: scoped `.tmp/` reductions; redux harness pass-count
   strictly increasing with each landed fix (record per-bucket deltas here);
   equivalence tests; `tests/issue-3996-redux-runtime.test.ts` stays green.

## Acceptance criteria

- [ ] `createStore.spec` + `combineReducers.spec` null-deref cluster fixed via
      a general carrier/capture fix (no Redux-specific rewriting), with a
      committed reduction test.
- [ ] Illegal-cast clusters at `__call_fn_2` and `dispatch` fixed or reduced
      to a named, filed residual.
- [ ] Redux pinned suite ≥ 60/78 Wasm with 78/78 Node unchanged.
