---
id: 3371
title: "standalone: Reflect.construct (with NewTarget) refused — ~160 tests (proto-from-ctor-realm, subclassing) on the #1472 Phase-C refusal path"
status: ready
sprint: Backlog
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
---
# #3371 — Standalone `Reflect.construct` (with NewTarget) refused

## Problem

`--target standalone` emits a codegen refusal for every `Reflect.construct`
call:

```text
Codegen error: Reflect.construct not supported in standalone mode (#1472 Phase C).
```

This is **160 official standalone failures** in the
`20260717-151504` baseline (0 in the default/JS-host lane — the host path
handles it, so this is a pure standalone gap).

The refusal was left deliberately out of scope by **#1905** (native
`Reflect.get/set/has/deleteProperty`), which states:

> `Reflect.apply` and `Reflect.construct` remain separate call/constructor
> machinery and are **out of scope here** … `Reflect.construct` remain on the
> standalone refusal path with the existing `#1472 Phase C` cite.

Since #1472 is `done`, the refusal self-cites a closed issue and there is **no
dedicated tracking issue** for actually implementing `Reflect.construct` in
standalone — this issue fills that gap.

## Affected tests (by category, 160 total)

| Count | Category |
| ----- | -------- |
| 47 | built-ins/TypedArrayConstructors (`proto-from-ctor-realm`, `use-custom-proto-if-object`) |
| 14 | built-ins/DataView |
| 11 | built-ins/Proxy |
| 8  | built-ins/Function |
| 6  | built-ins/NativeErrors (`proto-from-ctor-realm`) |
| 6  | built-ins/Reflect |
| 6  | built-ins/ArrayBuffer |
| 6  | built-ins/SharedArrayBuffer |
| 4  | built-ins/Date (`subclassing`) |
| 4  | built-ins/AsyncDisposableStack |
| …  | (Boolean/Number/String/Promise/Map/Set proto-from-ctor tails) |

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

1. The `Reflect.construct` call site itself (`src/codegen/expressions/calls.ts`,
   the same refusal gate that #1905/#2046 added `fail-loud` for construct).
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

## Suggested approach

1. Implement a standalone `Reflect.construct(target, argsList, newTarget)`
   lowering that (a) spreads `argsList` into constructor args, (b) resolves the
   effective prototype from `newTarget.prototype` (falling back to
   `target.prototype`), routing through #3240's native `__new_<Parent>` bodies.
2. Handle the `target !== newTarget` case (the realm/proto-from-ctor tests) by
   overriding the created object's `[[Prototype]]`.
3. Retire the `Reflect.construct not supported in standalone mode` refusal gate;
   keep genuinely-unsupported argument shapes fail-loud citing **#3371**.

## Acceptance Criteria

- `proto-from-ctor-realm` / `use-custom-proto-if-object` TypedArray/DataView/
  NativeErrors families compile and run under `target: "standalone"`.
- `Reflect.construct(Base, args, Derived)` selects `Derived.prototype` for the
  new instance.
- Any residual refusal cites **#3371**, not the closed #1472.
