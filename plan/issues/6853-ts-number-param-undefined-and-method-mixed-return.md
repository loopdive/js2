---
id: 6853
title: "Redux combineReducers 13/16: a TS `state: number` param receiving undefined reads NaN, and a method's `return undefined` in a `number | undefined` slot reads NaN"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
language_feature: functions, objects
goal: npm-library-support
related: [4526, 4641, 3580]
---

# Problem

Three Redux `combineReducers.spec.ts` rows expect combineReducers to THROW
because a reducer returned `undefined`:

- `throws an error if a reducer returns undefined handling an action`
- `throws an error on first call if a reducer returns undefined initializing`
- `throws an error on first call if a reducer attempts to handle a private action`

All three reducers are object-literal METHODS in a `.ts` spec, called
dynamically by Redux (`reducer(state[key], action)`). Measured with a
two-file fixture (`.tmp/f3`, 2026-10-05, Node vs Wasm):

| reducer shape | call | Node | Wasm |
| --- | --- | --- | --- |
| `counter(state: number, action) { …default: return state }` | `r(undefined, {type:""})` | `undefined` | `NaN` (number) |
| `c2(state: number = 0, action) { … case "whatever": return undefined }` | `r(0, {type:"whatever"})` | `undefined` | `NaN` (number) |
| same | `r(0, null)` (`action && action.type`) | `undefined` | `illegal cast` trap |

Three mechanisms:

1. **Annotated scalar parameter.** `state: number` (no default) lowers to an
   `f64` slot; the dynamic call boundary converts `undefined` → `NaN`, so
   `return state` cannot return `undefined`. TypeScript annotations are
   trusted as the representation, which is unsound for values arriving from
   untyped JS callers.
2. **#4641 residual R3.** `widenMixedUndefinedReturn` widens `T | undefined`
   return slots only for function DECLARATIONS; methods / function
   expressions / arrows (registered through `closures.ts` /
   `resolveWasmTypeForClosureReturn`) still collapse `number | undefined` to
   `f64` and materialize `undefined` as `NaN`.
3. A struct-typed interface parameter (`action: Action`) receiving `null`
   traps in the `action && action.type` guard instead of short-circuiting.

# Implementation Plan

1. R3 first (smallest, measurable): apply `widenMixedUndefinedReturn` in
   `resolveWasmTypeForClosureReturn` AND at every call-site wrapper-type
   derivation that computes a closure's result type from its signature
   (`getOrCreateFuncRefWrapperTypes` callers in `calls-closures.ts`), so the
   lifted function and the dynamic dispatchers agree. Measure test262
   standalone + host on `language/expressions/{arrow-function,function,object}`.
2. Parameter: when a function value ESCAPES to an untyped consumer (the
   existing escape analysis used for `#3996`'s "escaped reducer's implicit-any
   parameter"), widen a non-defaulted scalar-annotated parameter to
   externref (box on entry) — mirroring how implicit-any params are kept
   dynamic. Gate on escape so typed hot paths keep `f64`.
3. Null-into-struct-param: make the dynamic-call argument coercion map
   `null`/`undefined` to `ref.null` for a nullable struct param rather than a
   failing `ref.cast`.

# Acceptance criteria

- [ ] The three combineReducers rows pass; no Redux row drops.
- [ ] test262 host + standalone scoped runs on the touched directories do not
      regress.
