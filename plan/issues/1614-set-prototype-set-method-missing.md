---
id: 1614
title: "codegen: Set set-method intrinsics missing ('Cannot find method size/...' on parent class Set)"
status: done
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: low
feasibility: medium
task_type: feature
area: codegen
language_feature: set-methods
goal: compiler-correctness
sprint: Backlog
es_edition: es2024
test262_count: 7
related: [1103]
---
# #1614 — Set composition methods not resolved on subclass receivers

## Problem

7 test262 tests fail with:

```
Cannot find method 'size' on parent class 'Set'
```

All are the ES2024 Set-composition methods invoked on subclass receivers:
`union`, `isDisjointFrom`, `isSupersetOf`, `symmetricDifference`,
`intersection`, `difference`, `isSubsetOf` (the
`*/subclass-receiver-methods.js` suite). The implementation of these methods
calls the abstract `GetSetRecord` steps which read the `size` getter and the
`has`/`keys` methods off the argument; the compiler cannot resolve `size`
(and the other set-record members) on the `Set` parent class.

## Failing test examples

- `test/built-ins/Set/prototype/union/subclass-receiver-methods.js`
- `test/built-ins/Set/prototype/isDisjointFrom/subclass-receiver-methods.js`
- `test/built-ins/Set/prototype/symmetricDifference/subclass-receiver-methods.js`

## Root-cause hypothesis

The Set-method intrinsics (see #1103 wasm-native Map/Set) reference the `size`
accessor and `has`/`keys` methods via a `parent class 'Set'` lookup that does
not register the `size` getter (it is an accessor, not a data method) on the
intrinsic Set shape. Register the Set `size` accessor and the
`has`/`keys`/`values` methods so the GetSetRecord abstract operation resolves.

## Acceptance criteria

- The Set-composition methods resolve `size`/`has`/`keys` on receivers.
- >=5 of the 7 tests move off `compile_error`.

## Root cause (confirmed)

The 7 tests are not really about the *implementation* of `union`/etc. — they
define a `class MySet extends Set` whose method bodies call
`super.size(...rest)` / `super.has(...rest)` / `super.keys(...rest)`. Method
resolution in `src/codegen/expressions/new-super.ts` walks the compiled-class
inheritance chain (`funcMap` lookup of `Parent_method`). `Set` is a builtin
**extern class** (host-backed, see `ctx.externClasses` in
`src/codegen/index.ts`), so it has no `Set_size`/`Set_has`/`Set_keys` entries
and the lookup falls through to `reportError("Cannot find method '…' on parent
class 'Set'")`, failing the whole module at compile time.

## Fix

In `new-super.ts`, before raising the error, fall back to a dynamic dispatch
when the parent (or an ancestor) is a registered extern class: emit
`__extern_method_call(this, methodName, argsArray)` and return externref. Added
`emitSuperExternMethodCall` and wired it into both `compileSuperMethodCall`
(`super.m()`) and `compileSuperElementMethodCall` (`super['m']()`). Spread
arguments (`...rest`) are handled by pushing the spread source into the JS args
array.

## Test Results

All 7 `subclass-receiver-methods.js` tests now `pass` (were `compile_error`):
union, isDisjointFrom, isSupersetOf, symmetricDifference, intersection,
difference, isSubsetOf. Unit test: `tests/issue-1614.test.ts`.
