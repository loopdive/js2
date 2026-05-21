---
id: 1116b
title: "Promise subclass: Wasm-compiled class extends Promise must be a valid JS constructor (Wasm-class-as-JS-ctor bridge)"
status: ready
created: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: classes, Promise, subclassing
goal: spec-completeness
parent: 1116
related: [1455, 1326]
---

# #1116b — Wasm-class-as-JS-ctor bridge for Promise subclasses

## Problem

~61 tests in `built-ins/Promise/` fail with `[object Object] is not a constructor`
when user-defined Wasm-compiled classes extend `Promise`:

```ts
class MyPromise extends Promise {
  constructor(executor: (resolve: any, reject: any) => void) {
    super(executor);
  }
}
Promise.all.call(MyPromise, [p1, p2]); // Should create a MyPromise, not throw
```

Root cause: `Promise.all/race/allSettled/any` use `SpeciesConstructor` (§7.3.24)
which calls the `@@species` symbol → returns the Wasm-compiled class → JS engine
tries to call it as a constructor → Wasm exports are not JS-callable constructors.

The same root cause affects:
- `Promise.all.call(SubClass, iter)` — ~61 tests
- `ctx-ctor` pattern — ~4 tests  
- Any promise combinator that respects `@@species`

## Root cause (from #1116 investigation, senior-dev-1326c, 2026-05-20)

Wasm-compiled classes are represented as GC structs with a `$constructor` field
holding a `funcref`. When the JS engine tries to use them as constructors via
`new SubClass(executor)`, the call fails because Wasm exported functions don't
carry the `[[Construct]]` internal method that JS constructors require.

## Related work

- #1382 (Wasm closures not JS-callable) — adjacent problem; closed with a bridge
  pattern. #1116b may reuse the same bridge infrastructure.
- #1455 (subclassing builtins — instanceof + prototype chain) — companion issue

## Implementation approach (needs architect spec)

Options:
1. **Wrapper function export**: For each class that extends a built-in, emit a
   JS-callable wrapper exported function that calls `$new_MyClass(executor)`.
   Register via `__register_constructor` host import.
2. **`@@species` stub**: Override `Symbol.species` on the compiled class to
   return a JS-native wrapper instead of the Wasm struct. The wrapper holds
   a reference to the Wasm new-object function.
3. **Runtime bridge at Promise.all site**: In the host runtime, detect when
   `thisArg[Symbol.species]` is a non-constructible Wasm export and substitute
   a thin proxy.

Option 1 is the most spec-compliant but requires tracking which classes extend
builtins at compile time.

## Acceptance criteria

- `Promise.all.call(MyPromise, [p1, p2])` returns a `MyPromise` instance
- `Promise.race.call(MyPromise, [...])` same
- Tests in `built-ins/Promise/all/ctx-ctor.js` (and sibling files) pass
- No regression in existing Promise tests

## Notes

Discovered during scoped fix of #1116 (ctx-non-object cluster). The ~4
`ctx-non-object` tests were fixed in PR #436. This is the remaining
architectural work.

## Implementation Plan

(Author: architect, 2026-05-21. Recommended approach: Option 1 +
Option 3 hybrid — emit a JS wrapper for builtin-subclass classes
AND keep a runtime bridge for generic species lookup.)

### Entry point

- **Compile time**: in `compileClassDeclaration` (search
  `src/codegen/declarations.ts`), detect when the class's
  `extends` clause resolves to a builtin (Promise, Array, Map, Set,
  Error, etc.) via the #1325 BUILTIN_TYPE_TAGS registry.
- **Runtime**: extend `_buildJsConstructorBridge` (existing per
  #1382) in `src/runtime.ts` to accept Wasm-class new-funcrefs.

### Data structure changes

1. New funcref export per builtin-subclass — naming convention
   `__class_ctor_<ClassName>`. Exported alongside the regular
   `$new_<ClassName>` Wasm function.

2. Class metadata struct (existing class object) gains a sidecar
   slot `__jsConstructor` holding the JS function wrapper.

3. `__register_constructor(name, fn)` host import (existing for
   #1382) reused; on instantiation, runtime calls `_attachJsCtor`
   to wire `$Symbol_species` and `[[Construct]]`.

### Algorithm

1. **Compile time** — for each class `C extends Builtin`:
   1. Mark `C` with `subclassesBuiltin = true` flag.
   2. Emit an exported wasm function `$new_C_export` that takes
      JS-side externref args, converts to wasm types, calls the
      generated `$new_C(...)`, and returns the result externref.
   3. After the import-shift pass, register the export via
      `__register_constructor`.

2. **Runtime** — `_attachJsCtor(className, newFn, prototype)`:
   1. Create a JS arrow `function MyClass(...args) { return
      newFn(...args); }` that throws if called without `new`.
   2. Set `MyClass.prototype = prototype` (the wasm-side prototype
      object).
   3. Define `MyClass[Symbol.species] = MyClass` so Promise
      combinators find it.
   4. Define `MyClass[Symbol.hasInstance]` to delegate to the
      builtin-tag check.

3. **Species lookup at host site**:
   1. When `Promise.all.call(MyClass, iter)` runs in JS, the host
      reads `MyClass[Symbol.species]` — which is now the JS
      wrapper function (step 2.3). Construction works.

4. **Fallback bridge** (Option 3) — for any externref that *looks*
   like a class but lacks `__jsConstructor`, the runtime's
   `__species_construct` import substitutes the JS wrapper from a
   lookup table keyed on class identity.

### Edge cases

- **`extends Promise` AND `extends Array` chain** — e.g.
  `class A extends Promise {}; class B extends A {}`. B's species
  must walk up to A, not Promise. The wrapper for B must be the
  child's wrapper.
- **Anonymous classes**: `Promise.all.call(class extends Promise {},
  iter)` — synthesize a unique name; register the wrapper.
- **`new.target` inside the constructor** — must equal the wrapper,
  not the wasm-side struct ref. Pass new.target as an extra
  parameter to the wasm ctor.
- **Calling `MyClass()` without `new`** — throws TypeError per spec
  for class constructors. The JS wrapper enforces.
- **Inheritance through `Reflect.construct`** —
  `Reflect.construct(Promise, args, MyClass)`. The wrapper's
  prototype chain must reflect this; lower `Reflect.construct` to
  use `Object.create(newTarget.prototype)` then dispatch the wasm
  ctor with the constructed `this`.
- **GC: cycle through ctor** — wrapper holds funcref → wasm holds
  classMeta → classMeta sidecar holds wrapper. Use a WeakMap
  keyed on classMeta for the JS wrapper to avoid retaining cycles.
- **Standalone mode (no JS host)** — no JS species exists. In
  standalone, `Promise.all.call` should still work because the
  combinator is now itself wasm-native (per #1116). The bridge is
  needed only for JS-host mode.

### Test262 paths

- `test/built-ins/Promise/all/ctx-ctor.js`
- `test/built-ins/Promise/all/species-*`
- `test/built-ins/Promise/race/species-*`
- `test/built-ins/Promise/allSettled/species-*`
- `test/built-ins/Promise/any/species-*`
- `test/built-ins/Array/from/calling-from-valid-1-noStrict.js`
  (similar species pattern for Array)

Acceptance: ≥50 of the 61 species-pattern Promise tests pass; no
regression on existing Promise tests.

### Dependencies

- **#1116** — parent issue; this is the architectural follow-up.
- **#1382** — `_buildJsConstructorBridge` already exists; reuse.
- **#1325** — instanceof tag registry; needed to detect "extends
  builtin".
- **#1455** — instanceof + prototype-chain for builtin subclasses;
  complementary; coordinate the prototype attachment.

### Risks

- **Cycle leak**: JS-wrapper ↔ wasm class ref. Mitigate with the
  WeakMap pattern above.
- **`Promise` shadow**: if user code shadows the global `Promise`,
  the runtime's species detection must use the original Promise
  intrinsic, not the shadowed one.
- **Test262 baseline noise**: species tests interact with #1455
  in subtle ways; rebaseline after both land.
