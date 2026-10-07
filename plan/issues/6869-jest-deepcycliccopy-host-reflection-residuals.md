---
id: 6869
title: "jest deepCyclicCopy: getOwnPropertyDescriptors runs an accessor-literal getter; constructed-function prototypes and spied Array.isArray diverge — 5 upstream tests"
status: ready
sprint: Backlog
created: 2026-10-06
updated: 2026-10-06
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
goal: npm-library-support
requested_by: ttraenkler/wave11-jest
related: [4616, 6867]
---

# #6869 — jest `deepCyclicCopy.test.ts`: 7/12 in Wasm (12/12 native)

Measured 2026-10-06 on `42d289a96f` (`tests/dogfood/jest-upstream-suite.mjs`),
unchanged by #6867.

| test | Wasm error |
| --- | --- |
| does not execute getters/setters, but copies them | `dereferencing a null pointer` in `__cb_N` via `_invokeGetterCallbackBridge` ← `_safeGet` |
| does not keep the prototype by default when top level is object | `assertion 1 unexpected equal value` |
| keeps the prototype of arrays when keepPrototype = true | `toBe: object != object` |
| does not keep the prototype for objects when keepPrototype = false | `assertion 1 unexpected equal value` |
| keeps the prototype for objects when keepPrototype = true | `assertion 3 toBe: object != object` |

## Problem

1. **Getter executed.** `deepCyclicCopy({ get foo() { fn(); return; } })`
   reaches `Object.getOwnPropertyDescriptors(object)`; the trace shows the
   getter being INVOKED through `_safeGet` (src/runtime.ts ~5850) while the
   descriptors are built, and the getter body then null-derefs (`fn` capture).
   Spec: [[GetOwnProperty]] must return the accessor descriptor without calling
   `get`.
2. **Prototype identity.** `new (function () {})()` instances and
   `Object.getPrototypeOf` disagree with node: the copy's prototype equals the
   source's when it must not (`keepPrototype: false`), and differs when it must
   match (`keepPrototype: true`, via `Object.create(Object.getPrototypeOf(o))`
   and `new (Object.getPrototypeOf(array).constructor)(n)`).
3. The tests also spy `Array.isArray` with `jest.spyOn(Array, 'isArray')`; the
   compiled `Array.isArray(value)` call must observe the host replacement.

## Implementation Plan

1. Reduce each to a two-file untyped `.js` fixture with
   `compileAndRunUpstreamModule` (tests/dogfood/upstream-suite-runner.mjs):
   (a) accessor literal → `Object.getOwnPropertyDescriptors`; (b) `new (function
   () {})()` → `Object.getPrototypeOf` identity vs a second instance and vs
   `Object.prototype`; (c) `jest.spyOn(Array, 'isArray')` observed by a
   compiled `Array.isArray` call.
2. (a) In the `__object_getOwnPropertyDescriptors` host import
   (src/runtime.ts ~15861) route accessor-literal carriers through the
   descriptor resolver used by `__object_getOwnPropertyDescriptor`
   (~6952/7376) instead of a value read; assert the getter is not called.
3. (b) Check how a constructed anonymous function expression allocates its
   instance (fnctor path, `src/codegen/fnctor-*.ts`) and what prototype
   `__object_getPrototypeOf` reports for it; each `new F()` must share
   `F.prototype`, and a `{}` copy must report `Object.prototype`.
4. (c) If `Array.isArray` is lowered to an intrinsic (`ref.test` on the vec
   carrier), keep that fast path only when the global binding is unmodified, or
   route through the host binding in the JS-host lane.
5. Regression test per sub-cause, failing on parent / passing with fix, with a
   node-parity control.
