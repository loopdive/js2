---
id: 3371
title: "standalone: Reflect.construct (with NewTarget) refused — ~160 tests (proto-from-ctor-realm, subclassing) on the #1472 Phase-C refusal path"
status: done
created: 2026-07-17
updated: 2026-07-21
completed: 2026-07-20
sprint: 73
priority: medium
horizon: l
feasibility: hard
model: fable
task_type: feature
area: codegen, runtime
language_feature: reflect, constructors, prototype chain
goal: standalone-mode
umbrella: 1781
related: [1781, 1905, 2046, 3240, 1472]
origin: "2026-07-17 /harvest-errors. Baselines run 20260717-151504 (gitHash 0069df37, 32,139 pass), standalone lane test262-standalone-current.jsonl."
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/index.ts
  - src/codegen/dataview-native.ts
  - src/codegen/expressions/identifiers.ts
oracle-ratchet-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/property-access-dispatch.ts
---

# #3371 — Standalone `Reflect.construct` (with NewTarget) refused

## Problem

`--target standalone` emits a codegen refusal for every `Reflect.construct`
call:

```text
Codegen error: Reflect.construct not supported in standalone mode (#1472 Phase C).
```

The original `20260717-151504` bucketing attributed **~160 direct failures** to
this refusal (0 in the default/JS-host lane — the host path handles it, so this
is a pure standalone gap). The 2026-07-20 preliminary original-harness run
showed the larger dependency blast: **813 standalone failures**, of which
**637 corpus tests include `isConstructor.js`**. That helper performs an honest
three-argument `Reflect.construct(function () {}, [], value)` probe, so the
single refusal blocks far more tests once the untouched Test262 harness runs.

The refusal was left deliberately out of scope by **#1905** (native
`Reflect.get/set/has/deleteProperty`), which states:

> `Reflect.apply` and `Reflect.construct` remain separate call/constructor
> machinery and are **out of scope here** … `Reflect.construct` remain on the
> standalone refusal path with the existing `#1472 Phase C` cite.

Since #1472 is `done`, the refusal self-cites a closed issue and there is **no
dedicated tracking issue** for actually implementing `Reflect.construct` in
standalone — this issue fills that gap.

## Affected tests (by category, 160 total)

| Count | Category                                                                                 |
| ----- | ---------------------------------------------------------------------------------------- |
| 47    | built-ins/TypedArrayConstructors (`proto-from-ctor-realm`, `use-custom-proto-if-object`) |
| 14    | built-ins/DataView                                                                       |
| 11    | built-ins/Proxy                                                                          |
| 8     | built-ins/Function                                                                       |
| 6     | built-ins/NativeErrors (`proto-from-ctor-realm`)                                         |
| 6     | built-ins/Reflect                                                                        |
| 6     | built-ins/ArrayBuffer                                                                    |
| 6     | built-ins/SharedArrayBuffer                                                              |
| 4     | built-ins/Date (`subclassing`)                                                           |
| 4     | built-ins/AsyncDisposableStack                                                           |
| …     | (Boolean/Number/String/Promise/Map/Set proto-from-ctor tails)                            |

Sample files:

- `built-ins/TypedArrayConstructors/ctors/buffer-arg/proto-from-ctor-realm.js`
- `built-ins/TypedArrayConstructors/ctors/buffer-arg/use-default-proto-if-custom-proto-is-not-object.js`
- `built-ins/DataView/custom-proto-access-throws.js`
- `built-ins/Date/subclassing.js`
- `built-ins/NativeErrors/URIError/proto-from-ctor-realm.js`

## Root cause

The dominant pattern is `Reflect.construct(Target, argsList, newTarget)` used to
exercise §10.1.13 (`GetPrototypeFromConstructor` / `OrdinaryCreateFromConstructor`)
— the instance's `[[Prototype]]` must come from `newTarget.prototype`, not
`Target.prototype`. Standalone codegen has no lowering for:

1. The `Reflect.construct` call site itself
   (`src/codegen/expressions/call-namespace-static.ts`, the refusal gate that
   #1905/#2046 kept fail-loud for construct).
2. Threading a distinct `newTarget` through native `__new_<Parent>` construction
   so the prototype is selected from `newTarget.prototype`.

## Relationship to existing work

- **#3240** (ready) — native `__new_<Parent>` subclass constructors. That gives
  the construction substrate but is driven by the `class X extends Parent`/`super()`
  path, not the explicit `Reflect.construct(...)` API with an arbitrary NewTarget.
  This issue should build on #3240's native ctors and add the NewTarget-driven
  prototype-selection path plus the `Reflect.construct` call lowering.
- **#2046** (in-progress) — Reflect get/set/deleteProperty spec fixes; keeps
  construct fail-loud. This issue removes that refusal.
- **#1472 Phase C** (done) — the umbrella whose cite the refusal string still
  carries; update the cite to this issue when the refusal is retired.

## Implementation notes

The implementation deliberately reuses `compileNewExpression` for construction
instead of duplicating constructor argument and native carrier semantics. Array
literal argument lists are synthesized into a `new Target(...args)` expression;
unresolved array-like and arbitrary carrier shapes remain fail-loud under
**#3371**.

Ordinary functions use a nominal constructible closure subtype only in
host-free targets, while arrows and method closures keep the existing
callable-only wrapper. This gives the host-free `__reflect_is_constructor`
helper a real runtime discriminator and keeps the Test262 probe honest:
ordinary functions return true, arrows and `Date.prototype.getYear` return
false. The JS-host lane keeps its established wrapper ABI; applying the marker
there changed closure nominal types unnecessarily and caused 29 illegal-cast
transitions in the merge-group Test262 run.

DataView and runtime-kinded TypedArray views gained an append-only
`constructProto` carrier slot. A distinct object-valued `NewTarget.prototype`
is stored there; a primitive/null prototype leaves the slot null and selects the
target's intrinsic prototype. Their existing `Object.getPrototypeOf` native MOP
arms read this override before the intrinsic singleton. The original realm shim
aliases the current global, so `other[TA.name].prototype` is lowered by the
TypedArray constructor kind to the same per-kind intrinsic singleton.

Unblocking the untouched TypedArray representative exposed a separate call-ABI
fault: its JSDoc callback typedef has two formals while the actual callback has
one. Callable-parameter dispatch now pre-registers later callback wrappers,
accepts shorter runtime signatures, and marshals only that signature's formal
prefix, matching JavaScript's ignored-surplus-arguments rule.

## Verification (2026-07-20)

- Untouched original-harness representatives pass in standalone mode:
  `annexB/built-ins/Date/prototype/getYear/not-a-constructor.js`,
  `built-ins/TypedArrayConstructors/ctors/buffer-arg/proto-from-ctor-realm.js`,
  and `built-ins/DataView/custom-proto-if-object-is-used.js`.
- Focused tests cover two-argument construction, the honest IsConstructor
  result matrix, DataView custom prototype selection, all nine dynamic
  TypedArray intrinsic prototypes, the realm `Function` NewTarget, and the
  shorter-formal harness callback.
- Every successful standalone probe validates as Wasm and has zero imports.
- Unsupported args-list shapes refuse with **#3371** and no `#1472` cite.

## Merge-queue follow-up (2026-07-21)

- Bisected the 29 host `illegal_cast` transitions to the constructible-wrapper
  change in this implementation: 26 existing async/dynamic-import failures had
  become uncatchable traps and three Annex B function-block-scoping tests had
  regressed from pass to trap.
- Scoped constructor-marker wrappers to host-free targets. The exact 29-path
  cluster now has zero `illegal_cast` rows; all three Annex B regressions pass,
  while the existing non-pass rows return to ordinary runtime-error categories.
- The complete focused #3371 suite remains green (15/15), including the three
  standalone original-harness representatives and host ABI regression probes.

## Acceptance Criteria

- [x] Representative `proto-from-ctor-realm` / custom-prototype TypedArray and
      DataView tests compile and run under `target: "standalone"`.
- [x] A distinct object-valued `NewTarget.prototype` is selected for supported
      native carriers; primitive prototypes fall back to the target intrinsic.
- [x] The original-harness Annex B IsConstructor probe observes ordinary versus
      non-constructible callable values honestly.
- [x] Any residual refusal cites **#3371**, not the closed #1472.
