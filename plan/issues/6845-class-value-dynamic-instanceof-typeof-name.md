---
id: 6845
title: "JS host: a class held as a VALUE loses its identity — `o instanceof C` (C a param) false, `typeof ImportedClass` \"undefined\", `C.name` through `any` undefined"
status: ready
sprint: Backlog
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: classes, instanceof, typeof
goal: core-semantics
related: [6844, 6798, 2763, 2026]
requested_by: ttraenkler/wave10-prettier-regression
origin: "2026-10-05 — found while bisecting the prettier 108 → 75 regression (#6844)"
---

# #6845 — class values lose identity on the JS host

## Problem

Measured on main `c3e3fab33d` (JS host, `compile` / `compileProject` with
`allowJs`, exports wired with `importObject.__setExports`). Node answers in
brackets.

```js
class P5 { constructor() { this.x = 1; } }
function isInst(o, C) { return o instanceof C; }
isInst(new P5(), P5)     // false   [true]
isInst([], Array)        // false   [true]
isInst(new P5(), Object) // true    [true]
```

```ts
class P5 { x = 1; }
function nm(C: any): string { return C.name; }
nm(P5)                   // undefined  [ "P5" ]
```

Across modules (`errors.js` exports `class InvalidDocError extends Error {…}`,
`export class P {}`; `mod.js` imports them):

```js
typeof InvalidDocError   // "undefined"  ["function"]
typeof P                 // "undefined"  ["function"]
const C = InvalidDocError; thrown(() => { throw new C(1); }) instanceof C   // false [true]
```

All three predate #6798 (same answers at `3209125223`). They matter for every
upstream test shim: `expect(fn).toThrow(SomeClass)` is matched with
`error instanceof expected || error.name === expected.name`; prettier only
passes through the `name` half (fixed by #6844).

Related but distinct: #2763 (cross-realm `Object`/`Function` identity and
`.prototype` on dynamic Function values), #2026 (`new K()` on a parameter).

## Implementation Plan

1. **Reproduce per arm** with a `.tmp` probe and dump WAT. The single-module JS
   case types `C` from shape inference as the instance struct
   (`(param (ref null 17) (ref null 17))` — the class object singleton and
   the instance share struct type 17), so `__instanceof_check` receives the
   class object as a plain struct. Confirm whether the host
   `__instanceof_check` (`src/runtime.ts`, `_instanceofResult`) can recognise
   a compiled class object (it is registered in `_classObjectOwnPropertyNames`
   / `__register_class_object`) and map it to the registered prototype; that
   is the likely fix for arm 1 — `v instanceof <class object>` should walk
   `v`'s registered prototype chain against the class object's registered
   prototype.
2. `Array` via a parameter: the RHS arrives as the host `Array` while the LHS
   is a WasmGC vec; `_instanceofResult` must apply the vec → Array.prototype
   rule it already applies for the static `[] instanceof Array` fold.
3. `typeof ImportedClass` → "undefined": trace the import binding of a class
   across a `compileProject` module edge — the class object global is probably
   not materialised (lazy `__class_<C>` getter not invoked) on the typeof
   path; route the static typeof fold for a class binding to `"function"`
   (TDZ guard from #6798 still applies).
4. `C.name` through `any`: the `__extern_get` arm for a class-object struct
   must answer `name` (and `length`) from the class metadata, as the typed
   `C.name` read already does.
5. Tests: one untyped two-file fixture per arm, expectations from node, with a
   control that passed before.
