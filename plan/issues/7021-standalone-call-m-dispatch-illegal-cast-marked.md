---
id: 7021
title: "standalone: every marked upstream Hooks test traps `illegal cast` inside the method-call dispatcher `__call_m_use_1` (`marked.use({...})` on a `Marked` instance reached through a closure) — 30 of 30 tests"
status: done
sprint: current
created: 2026-10-16
updated: 2026-10-17
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: method-call, dynamic-dispatch, classes
goal: standalone-gap
related: [7013]
completed: 2026-10-17
loc-budget-allow:
  # 2026-10-17 (#7021): the rest-vec packing lives in the new
  # `closed-dispatch-rest-arm.ts`; this file keeps the MethodEntry field, the
  # positional-formals admission and the one call in `buildEntryArm`.
  - src/codegen/closed-method-dispatch.ts
---

# `__call_m_use_1` illegal cast (marked)

Found by the [#7013](./7013-standalone-upstream-unit-lane.md) standalone
upstream unit lane: marked's `test/unit/Hooks.test.js` passes 30/30 in the
JS-host lane and 0/30 standalone. Every test traps the same way:

```
trap: RuntimeError: illegal cast @ __call_m_use_1 < __closure_545 < __dyn_call_7
```

Each test body does `marked.use({ hooks: { preprocess(markdown) { … } } })` (or
`new Marked().use(...)`) and then parses. The receiver reaches the call
through a test closure as `any`.

## Root cause (to confirm)

`__call_m_<method>_<arity>` is the IR's closed method-call dispatcher
(`src/ir/integration.ts:6657` / `6742`). It `ref.cast`s the receiver to the
struct type of the single class it planned for. On standalone the receiver
here is either a different carrier (the `marked` default-export instance vs a
`Marked` constructed inside the package, an `$Object` wrapper produced by the
CJS/ESM namespace, or a subclass) and the cast is unguarded.

## Implementation Plan

(Original plan kept below; the root cause turned out to be different.)

- Measured: `__call_m_use_1` does `ref.cast` the ARGUMENT, not the receiver —
  `local.get 1; any.convert_extern; ref.cast (ref $__vec_externref)`. marked's
  `use(...e)` compiles to `(this, rest: vec)`, and `collectMethodEntries`
  admitted it for arity 1 because `paramTypes.length (1) >= 1`, then
  `buildEntryArm` cast the options object to the rest vec.
- Fix: for a method whose LAST formal is its registered rest vec
  (`ctx.funcRestParams`), only the formals before the rest index are
  positional; the arm packs arguments `restIndex … arity-1` (coerced to the
  rest element type) into a fresh vec. Standalone/WASI only.
- Second blocker behind the trap: `use()` installs hooks as OWN properties over
  the `Hooks` class methods (`r[o] = c => …`). The closed dispatcher's own-slot
  guard (`noteOwnShadowDispatchCandidate`) was JS-host only, so the class arm
  won and the hooks never ran. Standalone already has native
  `__hasOwnProperty` / `__extern_method_call` that see the instance expando,
  so the guard is enabled there without an import.

Original plan:

1. Reduce: compile `.marked-upstream-suite-generated/test/unit/Hooks.test.ts`
   standalone with `preserveDebugNames` and dump the WAT of `__call_m_use_1`
   (the #7013 probe: `JS2WASM_UPSTREAM_TARGET=standalone node --import tsx
   tests/dogfood/marked-upstream-suite.mjs`, then `--inspect-wat`); record which
   receiver type it casts to and which carrier actually arrives (add a
   `ref.test` chain in a debug build).
2. Shrink to a single-file repro: a class with a `use(opts)` method returning
   `this`, exported both as an instance and through `new`, called from a
   closure with an `any` receiver.
3. Fix in the dispatcher plan: when the receiver's static type is not a single
   closed class, emit a `ref.test` guard and fall back to the dynamic
   `__call_fn_method` path instead of an unguarded `ref.cast`.
4. Scoped standalone test262 `language/expressions/call`,
   `language/statements/class` base vs fix; re-measure marked.

## Acceptance

marked standalone Hooks tests no longer trap; gc binaries byte-identical.

## Resolution

- `src/codegen/closed-dispatch-rest-arm.ts` (new): `restDispatchInfo` (rest ABI
  of `<Struct>_<method>` when the fixed-arity arm must pack it; `null` on the
  JS-host lane) and `restVecArgInstrs` (`struct.new $vec(count, array.new_fixed …)`).
- `closed-method-dispatch.ts`: `collectMethodEntries` admits a rest method by its
  positional formals only; `buildEntryArm` packs the rest slot.
- `own-property-method-shadow.ts`: `noteOwnShadowDispatchCandidate` records the
  name on standalone/WASI too, skipping only the host import there.

JS-host output is unchanged by construction (`restDispatchInfo` returns null and
the host branch of `noteOwnShadowDispatchCandidate` is untouched); verified by
hashing gc binaries of the probe fixtures on base and fix.

Tests: `tests/issue-7021-standalone-rest-dispatch-own-shadow.test.ts` — rest
methods called through `any` with 0/1/2 arguments, a leading formal before the
rest, `return this`, a sibling one-param `use`; and the marked `use()` hook
shape (own closure over a class method, stacked hooks, computed key, displaced
method still callable, other instance unaffected). Each row is compared with
the JS engine. Fails on the parent (`illegal cast` / own hook ignored), passes
with the fix.

marked standalone: 0/30 → 15/30. All 15 remaining failures are the async tests
(`await marked.parse(…)` yields `null`), filed as
[#7049](./7049-standalone-awaited-async-iife-result-marked.md).
