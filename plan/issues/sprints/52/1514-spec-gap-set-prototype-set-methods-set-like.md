---
id: 1514
sprint: 52
title: "spec gap: Set.prototype.{union,intersection,difference,…} accept set-like protocol"
status: ready
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: set-methods
goal: spec-completeness
related: [1438]
---
# #1514 — Set methods accept any set-like

## Problem

`built-ins/Set/prototype/{union,intersection,difference,symmetricDifference,isDisjointFrom,isSupersetOf,isSubsetOf}/`
has **79 failing test262 cases**. The Set Methods proposal (ES2025
§24.2.5) requires every method to accept any object satisfying the
**set-like protocol**:

```ts
{ size: number; has(v): boolean; keys(): Iterator }
```

This includes plain Maps, classes with `.size` getters, arrays via a
class wrapper, etc. — not just `Set` instances.

Current behaviour:

| Test | Pattern | Symptom |
|------|---------|---------|
| `union/set-like-class-order.js` | class with `size` + `has` + `keys()` | `The .size property is NaN` |
| `intersection/combines-Map.js` | Map argument | wrong combined elements |
| `intersection/set-like-class-mutation.js` | class with `has: 'string'` | `"has" is not a function` (good — but wrong assertion message) |
| `difference/converts-negative-zero.js` | normalises -0 to +0 | -0 stays distinct from +0 |
| `isDisjointFrom/set-like-array.js` | array with size/has/keys | `The .size property is NaN` |
| `symmetricDifference/subclass.js` | Set subclass | wrong subclass receiver |

## Failure count

**79 fails**. Realistic target: **≥ 60 flips**.

## Root cause

`src/runtime.ts:1911–2090` implements set-method helpers. Existing
comments at line 1911–1919 acknowledge the gap:

```ts
// symmetricDifference, isSubsetOf, isSupersetOf, isDisjointFrom) accept
// ANY set-like argument (object with `size` + `has(v)` + `keys()`),
// V8 Set.prototype.union and friends call `Get(arg, "size")` etc. and
// set-like shape (per ES2025 §24.2.5.x).
```

The fast path uses `instanceof Set` and only falls back to a partial
externref protocol for non-Sets. The full spec algorithm
(`GetSetRecord` in §24.2.1.2) requires:

1. `Get(other, "size")` → ToNumber → `intSize` (no NaN, no -0).
2. `Get(other, "has")` → ToCallable (throw if not).
3. `Get(other, "keys")` → ToCallable (throw if not).
4. For methods that need to enumerate `other`: call
   `other.keys()` and iterate the resulting iterator (closing on
   abrupt completion).

Additionally, `-0` and `+0` must compare equal in the set membership
check (SameValueZero, §7.2.11).

## Files to touch

- `src/runtime.ts:1911–2090` — refactor the set-method helpers to
  use a new `__get_set_record(other) → SetRecord` helper that runs
  the §24.2.1.2 algorithm.
- `src/codegen/index.ts:6140–6160` — extern method registration
  doesn't need to change (the helpers already receive externref
  args).
- `src/codegen/property-access.ts` — ensure `Set.prototype.size`
  getter returns f64 even on subclasses with a custom `[[SetData]]`.

## Acceptance criteria

1. ≥ 60 of 79 in `built-ins/Set/prototype/{union,…}/` flip to `pass`.
2. `combines-Map.js` works on Map argument.
3. `converts-negative-zero.js` — `new Set([-0]).has(0) === true`.
4. No regression in `built-ins/Set/prototype/{add,delete,has,clear}/`.

## Reference tests

- `built-ins/Set/prototype/union/set-like-class-order.js`
- `built-ins/Set/prototype/intersection/combines-Map.js`
- `built-ins/Set/prototype/difference/converts-negative-zero.js`
- `built-ins/Set/prototype/isDisjointFrom/set-like-array.js`
- `built-ins/Set/prototype/symmetricDifference/subclass.js`
