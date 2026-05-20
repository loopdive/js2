---
id: 1513
sprint: 52
title: "spec gap: Reflect — TypeError on non-object/Symbol target + abrupt-completion propagation"
status: in-review
created: 2026-05-20
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: reflect
goal: spec-completeness
related: [1460, 1466]
---
# #1513 — Reflect: type checks + abrupt completions

## Problem

`built-ins/Reflect/` contributes **81 failing test262 cases**. Three
patterns:

1. **`Reflect.X(non-object)` should throw `TypeError`**

   ```js
   Reflect.ownKeys(1);             // expected: TypeError
   Reflect.getPrototypeOf(Symbol()); // expected: TypeError
   ```

   Our inlining returns `undefined`/`false` silently (~30 entries).

2. **Abrupt completion propagation from descriptor getters**

   ```js
   const o = new Proxy({}, { get(_, k) { throw new Test262Error(); } });
   assert.throws(Test262Error, () => Reflect.get(o, "x"));
   ```

   `return-abrupt-from-result.js` (~9 entries across
   `get/set/getOwnPropertyDescriptor/defineProperty/isExtensible`). We
   swallow the abrupt completion and return a default value.

3. **`Reflect.defineProperty` returns boolean, not throws**

   ```js
   Reflect.defineProperty(frozen, "x", { value: 1 }) === false; // we throw
   ```

   `defineProperty/return-boolean.js`, `return-abrupt-from-attributes.js`,
   `return-abrupt-from-result.js` (~5 entries).

4. **`Reflect.setPrototypeOf` returns false instead of throws** when
   target is non-extensible — `return-false-if-target-and-proto-are-the-same.js`.

5. **`Reflect.ownKeys` ordering** —
   `return-on-corresponding-order.js` and
   `return-on-corresponding-order-large-index.js` assert that integer
   keys come first in ascending order, then string keys in insertion
   order, then symbols. We currently return strings only in insertion
   order with no integer-first prefix.

## Failure count

**81 fails** in `built-ins/Reflect/`. Realistic target: **≥ 60 flips**.

## Root cause

`src/codegen/expressions/calls.ts:3129–3260` inlines each `Reflect.*`
to its `Object.*` counterpart but skips the `Type(target) is Object`
check and propagates only `value` results, not abrupt completions.
The current style is:

```ts
// Reflect.get(obj, prop) → obj[prop]    (line 3129)
// Reflect.ownKeys(obj) → Object.getOwnPropertyNames(obj)   (line 3207)
```

The translations are spec-correct *only* when the target is already
an object and the descriptor accessors do not throw — exactly the
cases the test262 suite is testing the other side of.

## Files to touch

- `src/codegen/expressions/calls.ts:3120–3260` (Reflect dispatch block).
  Each `case "Reflect.X":` needs a `ref.test $ObjectStruct` guard
  + `Type(target) is Object` check that throws TypeError before the
  inlining.
- `src/codegen/object-ops.ts` — add an `ordered_own_keys(obj)` helper
  that returns integer keys ascending, then string keys, then symbols.
- `src/runtime.ts` — adjust `__reflect_defineProperty` to return
  `false` on define-failure instead of throwing.

## Acceptance criteria

1. ≥ 60 of 81 in `built-ins/Reflect/` flip to `pass`.
2. `Reflect.ownKeys(obj)` ordering matches V8 on
   `{0:1, "1":2, a:3, [Symbol()]:4}` → `["0","1","a",<sym>]`.
3. `Reflect.defineProperty(frozen, "x", desc)` returns `false`.
4. No regression in #1460 (Object.defineProperty fidelity).

## Reference tests

- `built-ins/Reflect/ownKeys/target-is-not-object-throws.js`
- `built-ins/Reflect/get/return-abrupt-from-result.js`
- `built-ins/Reflect/defineProperty/return-boolean.js`
- `built-ins/Reflect/setPrototypeOf/return-false-if-target-and-proto-are-the-same.js`
- `built-ins/Reflect/ownKeys/return-on-corresponding-order.js`
