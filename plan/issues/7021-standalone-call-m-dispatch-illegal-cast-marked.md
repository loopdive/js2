---
id: 7021
title: "standalone: every marked upstream Hooks test traps `illegal cast` inside the method-call dispatcher `__call_m_use_1` (`marked.use({...})` on a `Marked` instance reached through a closure) — 30 of 30 tests"
status: ready
sprint: current
created: 2026-10-16
updated: 2026-10-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: method-call, dynamic-dispatch, classes
goal: standalone-gap
related: [7013]
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
