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
related: [7413, 7414, 7495]
# 2026-11-26: +2 lines for wellKnownSymbolKeyOf, the single producer of a key expression's `@@` spelling
# (resolveComputedKeyExpression's inline Symbol arm moved into it; review RV7444 asked for one producer).
loc-budget-allow:
  - src/codegen/literals.ts
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

## Scope of this fix

**Class iterators are fixed here. Object-literal iterators move to #7495.**
An object literal's `[Symbol.iterator]()` method lives in a struct field.
Reaching that field by its symbol key needs a key space that a string key
cannot spell, and every key-enumeration path must skip it. The first version of
this PR named the field `@@iterator`. That made the symbol collide with the
string key `"@@iterator"`, and review RV7444 found 7 new wrong answers (B1)
from it.

## Root cause (class iterators)

The delegation reads `@@iterator`, `next`, `return` and `throw` with
runtime-key reads (`__gen_delegate_get_<key>`). Three defects made those reads
miss a class iterator:

1. **The class prototype stored a symbol method under a string.**
   `emitClassMemberKeyOperand` (`class-proto-accessors.ts`) emitted every
   member name as a string key. A `[Symbol.iterator]()` method is spelled
   `@@iterator` internally, so the prototype object held it under the string
   `"@@iterator"`, and `x[Symbol.iterator]` on a class instance read
   `undefined`.
2. **The class prototype was never built for the delegation.** `__extern_get`
   only gets its class-prototype lookup when some read site records the demand
   (`recordStandaloneRuntimeKeyClassMemberRead`). Opening a delegation did not
   record it.
3. **The closed-struct getter answered for every receiver.** When any closed
   struct declares a field named `next` (or `return`, `throw`, …), the
   delegation getter sent every receiver that was not an open `$Object` to
   `__sget_<key>`. A class instance in the same program then read the getter's
   miss (null) instead of reaching `__extern_get`.

## Fix

1. `emitClassMemberKeyOperand` emits the boxed symbol as the key, but only for a
   member whose declaration key is a computed `Symbol.<well-known>`. A string
   key spelled `"@@iterator"() {}` or `["@@iterator"]() {}` keeps its string key
   (RV7444 B2). The `@@` spelling of a key expression now has one producer,
   `wellKnownSymbolKeyOf` (`literals.ts`), which `resolveComputedKeyExpression`
   also uses. The `@@<name>` / `@@<id>` parsing moved from `native-proto.ts` into
   `symbolMemberKeyId` (`runtime/contracts/well-known-symbols.ts`), and both
   callers use it.
2. `delegateStartCall` (`generators-delegation-runtime.ts`) records the
   runtime-key class demand. It runs only where a delegation over a user
   iterator is opened (`yield*` and a generator's `for-of`), not for every
   generator. Both emission sites in `generators-native.ts` call it.
3. The delegation getter uses `__sget_<key>` only for a receiver whose struct
   declares the field (`findAlternateStructsForField`). Every other receiver
   takes the runtime-key read.

## Acceptance

`tests/issue-7425-yield-star-user-iterator.test.ts` pins node's answers on gc,
standalone and wasi:

- **Class `yield*`:** the values, `next(v)` forwarding, `return()`, `throw()`, a
  direct `it[Symbol.iterator]` read, and a class iterator in a program that
  also has a struct with a `next` field. All 6 fail on main `c3b7be66`.
- **String keys spelled `"@@iterator"` stay string keys:** RV7444's B1 rows
  (`Object.keys`, `Object.entries`, `Object.hasOwn`, string and computed string
  reads, spread, a string key beside the symbol) and B2 (class `"@@iterator"()`
  and `["@@iterator"]()`). All 9 pass on main too and guard the regressions the
  first version caused.
