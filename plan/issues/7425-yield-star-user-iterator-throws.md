---
id: 7425
title: "yield* over a user iterator (class or object literal) throws a WebAssembly.Exception on gc, standalone and wasi"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7413, 7414]
# 2026-11-26: +1 line, the import of structFieldKeyForProperty. ensureStructForType itself stays within its
# budget (a dead `declSourceFile &&` guard was folded to pay for the field-key line).
loc-budget-allow:
  - src/codegen/index.ts
---

# #7425: `yield*` over a user iterator throws

## Problem

Found by RV7342's review of PR #7342 (#7413), measured on main `89e47482`; details in https://github.com/loopdive/js2/pull/7342#issuecomment-7019348242.

`function* g() { yield* new It(); }`, with a class iterator or an
object-literal iterator, throws an uncaught `WebAssembly.Exception` on gc,
standalone and wasi. Node yields the iterator's values.

Still reproduced on main `6694a8b8` (2026-11-26). The exception is the
delegation's own `TypeError` ("Invalid iterator protocol"), raised at its first
check: the `@@iterator` value it reads is not callable.

## Root cause

The delegation reads `@@iterator`, `next`, `return` and `throw` with
runtime-key reads (`__gen_delegate_get_<key>`). Four independent defects made
those reads miss a user iterator:

1. **The class prototype stored a symbol method under a string.**
   `emitClassMemberKeyOperand` (`class-proto-accessors.ts`) emits every member
   name as a string key. A `[Symbol.iterator]()` method is spelled `@@iterator`
   internally, so the prototype object held it under the string `"@@iterator"`,
   and `x[Symbol.iterator]` on any class instance read `undefined`.
2. **The class prototype was never built for the delegation.**
   `__extern_get` only gets its class-prototype lookup when some read site
   records the demand (`recordStandaloneRuntimeKeyClassMemberRead`). The
   delegation runtime did not record it, so a program whose only runtime-key
   read was a `yield*` had no lookup at all.
3. **An object literal's symbol-keyed method had no `@@iterator` field.**
   `ensureStructForType` (`index.ts`) named struct fields with TypeScript's
   internal symbol name (`__@iterator@19`). Everything else (the literal
   compiler, the `o[Symbol.iterator]` read) uses `@@iterator`. A method written
   `[Symbol.iterator]() {}` filled neither the read field nor the shape the
   function-expression form produces, so `o[Symbol.iterator]` read `undefined`
   even directly.
4. **The closed-struct getter answered for every receiver.** Once an object
   literal declares an `@@iterator` field, `__sget_@@iterator` exists, and the
   delegation getter sent every receiver that was not an open `$Object` to it.
   A class instance in the same program therefore read a miss (null) instead
   of reaching `__extern_get`. The same applies to `next` / `return` / `throw`
   whenever any closed struct declares a field of that name.

## Fix

1. `emitClassMemberKeyOperand` emits a well-known-symbol member's key as the
   boxed symbol. The `@@<name>` / `@@<id>` parsing moved from `native-proto.ts`
   into `symbolMemberKeyId` in `runtime/contracts/well-known-symbols.ts`, and
   both callers use it.
2. `ensureNativeDelegatedResultHelpers` records the runtime-key demand for every
   class, as the other unknown-receiver read sites do.
3. `ensureStructForType` names a field (and its method function) with
   `structFieldKeyForProperty` (`checker/well-known-symbol-keys.ts`):
   `@@<name>` for a library well-known symbol, the checker's name otherwise.
   The literal compiler matches a computed method key to that field through
   `resolveComputedKeyExpression`, as data properties already do.
4. The delegation getter uses the closed-struct getter only for a receiver
   whose struct declares the field (`findAlternateStructsForField`). Every other
   receiver takes the runtime-key read.

## Acceptance

- `tests/issue-7425-yield-star-user-iterator.test.ts` pins node's answers on
  gc, standalone and wasi, for a class iterator and an object-literal iterator.
  It covers the values, `next(v)` forwarding, `return()`, `throw()`, and a
  direct `it[Symbol.iterator]` read. All 10 cases fail on main `6694a8b8`.
