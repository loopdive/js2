---
id: 1462
title: "spec gap: Object.getOwnPropertyDescriptor + Object.create descriptor surface"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: property-descriptors
goal: spec-completeness
sprint: 52
related: [1460]
---
# #1462 - spec gap: Object.getOwnPropertyDescriptor + Object.create descriptor surface

## Problem

The "read side" of the property-descriptor API has two large clusters:

- `built-ins/Object/getOwnPropertyDescriptor/` — **310 failures**
- `built-ins/Object/create/` — **320 failures**

Related smaller clusters (same root machinery):

- `Object/getOwnPropertyNames/` — 45
- `Object/keys/` — 59
- `Object/hasOwn/` — 62
- `Object/isFrozen/` — 59, `Object/freeze/` — 53,
  `Object/isSealed/` — 33, `Object/seal/` — 94,
  `Object/isExtensible/` — 38, `Object/preventExtensions/` — 40,
  `Object/getPrototypeOf/` — 39, `Object/assign/` — 38,
  `Object/fromEntries/` — 25.

Total surface: **≥1,200 tests** depend on returning real
`{value, writable, enumerable, configurable}` /
`{get, set, enumerable, configurable}` descriptor objects.

Representative failures:

| Test | Pattern |
| --- | --- |
| `15.2.3.3-1-4.js` | `getOwnPropertyDescriptor(-2, "foo")` — primitive coercion to object |
| `primitive-string.js` | `getOwnPropertyDescriptor("foo", "0")` — `{value:"f", writable:false, enumerable:true, configurable:false}` |
| `15.2.3.3-4-7.js` | `getOwnPropertyDescriptor(globalThis, "isNaN")` — built-in fn descriptors |
| `15.2.3.3-2-22.js` | `getOwnPropertyDescriptor(obj, 0.000001)` — numeric key ToPropertyKey |
| `15.2.3.5-4-1.js` | `Object.create(B, {x: {value: true, enumerable: true}})` — descriptor map is applied with wrong defaults |
| `15.2.3.5-4-129.js` | `Object.create(null, …)` — inherited from null prototype |

## Failure count

- 310 `Object/getOwnPropertyDescriptor/`
- 320 `Object/create/`
- ≈600 in adjacent Object.* methods that read descriptor state
- **Combined: ~1,230 tests**, of which the "read side" overhaul
  realistically resolves ≥700 once descriptor storage from #1460 is in
  place.

## Root cause

In `src/codegen/object-ops.ts` and `src/runtime.ts`:

1. **Primitive coercion (`ToObject(O)`) on the first argument is
   missing** for `getOwnPropertyDescriptor`, `getOwnPropertyNames`,
   `keys`, `entries`, `values`, `freeze`, `isFrozen`, `seal`, `isSealed`,
   `preventExtensions`, `isExtensible`. The spec wraps strings,
   numbers, booleans, symbols, bigints into Object wrappers.
2. **No descriptor object is materialised** — the runtime
   `__getOwnPropertyDescriptor` returns `undefined` for any
   property whose attributes are the default `[true,true,true]`
   data descriptor (because the struct's flag-table doesn't track it).
   Spec: a regular data property returns
   `{value, writable:true, enumerable:true, configurable:true}`.
3. **String exotic indices** (`"foo"[0]` → `'f'`) require
   `{value:'f', writable:false, enumerable:true, configurable:false}`.
4. **Built-in function properties** on `globalThis` (`isNaN`,
   `parseInt`, …) need `{value, writable:true, enumerable:false,
   configurable:true}` — currently treated as enumerable.
5. **`Object.create(proto, propMap)`** delegates to a runtime helper
   that ignores `propMap`'s descriptor structure and applies the same
   default-true attribute set as bare assignment, so subsequent
   `delete` / re-define / `defineProperty` tests fail.
6. **`Object.create(null, …)`** — the null-prototype branch is broken
   in places; `instanceof`-style checks misbehave.
7. **`Object.assign`** copies via `[[Get]]`/`[[Set]]` correctly for
   own enumerable string properties but skips `Symbol`-keyed
   properties (it must copy own enumerable symbols too) and does not
   trigger getters/setters of the target per spec.

## Acceptance criteria

1. `Object.getOwnPropertyDescriptor(primitive, key)` boxes via
   `ToObject` and returns a spec-shaped descriptor.
2. Data-property defaults are reflected: regular assignments give
   `{value, writable:true, enumerable:true, configurable:true}`;
   string-index descriptors give the spec's non-writable,
   non-configurable shape; global built-in fn descriptors give
   non-enumerable.
3. `Object.create(proto, propMap)` walks own enumerable keys of
   `propMap`, calls `ToPropertyDescriptor` on each, and applies via
   the same path as `Object.defineProperty` (after #1460).
4. `Object.create(null, propMap)` produces a null-prototype object;
   inherited property access returns `undefined` without error.
5. `Object.assign` includes own enumerable Symbol-keyed properties
   and triggers setters on the target.
6. `Object.keys`/`getOwnPropertyNames`/`entries` skip non-enumerable
   own properties (e.g. those installed with `enumerable:false` via
   `defineProperty`).
7. `Object.freeze`/`seal`/`preventExtensions` and their `is*`
   predicates accept primitive inputs without throwing (per ES2015+).
8. ≥700 of the combined 1,230 failures resolved.
9. Tests: `tests/issue-1462.test.ts` covers each acceptance bullet.

## Files to inspect

- `src/codegen/object-ops.ts` — Object.* dispatchers; descriptor
  read path (`getOwnPropertyDescriptor`, `getOwnPropertyNames`,
  `keys`/`values`/`entries` near the bottom of the file)
- `src/runtime.ts` — `__getOwnPropertyDescriptor`, `__objectCreate`,
  `__objectAssign`, `__objectKeys`, `__getOwnPropertyNames`
- `src/codegen/literals.ts` — descriptor synthesis for object literals
- `src/codegen/expressions/calls.ts` — Reflect.* shadows (touches the
  same descriptor read path)
- `tests/issue-1462.test.ts`

## Notes

- Depends on #1460 (the "write side"). Implement #1460 first or in
  parallel: the descriptor flag storage must be in place before the
  read side can return accurate `writable`/`configurable`/`enumerable`.
- Many failures in `Reflect.getOwnPropertyDescriptor` (13) and
  `Reflect.ownKeys` (13) are downstream of this work — track in #1466.
