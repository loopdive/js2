---
id: 4661
title: "IsConstructor bit for compiled closures — Reflect.construct newTarget, and `new arrow()` / `new gen()` must throw"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: test262-conformance
lane: B
related: [4649, 4626, 4394]
files:
  - src/codegen/closure-exports.ts
  - src/codegen/callback-ctor-bridge.ts
  - src/runtime.ts
loc-budget-allow:
  - src/codegen/closure-exports.ts
  - src/codegen/index.ts
  - src/codegen/closures.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/runtime.ts::resolveImport
  - src/codegen/closures.ts::compileArrowAsClosure
---

# IsConstructor bit for compiled closures

Split out of #4649 (PR #4804), whose agent established the root cause and
rejected the naive repair with measurements. **This is the last failing
harness self-test across both lanes.**

Goal: 100% of `test262/test/harness/` in BOTH lanes. State once the four
in-flight PRs land (#4812, #4811, #4804, #4810): standalone **116/116**,
js-host **115/116** with only `isConstructor.js` left.

## Root cause (established, do not re-derive)

The harness include does:

```js
function isConstructor(f) {
  if (typeof f !== "function") throw new Test262Error(...);
  try { Reflect.construct(function(){}, [], f); } catch (e) { return false; }
  return true;
}
```

`__reflect_construct_newtarget` wraps a wasm-struct `newTarget` with
`_wrapForHost`, which is **not callable**, so V8's IsConstructor(newTarget)
check (§26.1.2 step 3) rejects every compiled function — `isConstructor` answers
`false` for `function(){}` and for `Array`. (`Array` as newTarget passes; the
TARGET argument passes only because it is an inline function EXPRESSION and so
takes #4394's `__make_callback_ctor` constructible bridge.)

**The naive repair is wrong in the other direction.** Routing closure structs
through `_wrapCallableForHost` the way `__construct_closure` already does makes
every closure look constructible, and the compiler has **no runtime notion of
constructibility at all**. Measured on main:

```js
new arrow();   // succeeds — spec §15.2.4 says TypeError
new gen();     // succeeds — spec says TypeError
```

So arrows and generators would start reporting `isConstructor === true` and the
test's three `false` assertions would fail instead. The test asserts BOTH
directions:

```js
assert.sameValue(isConstructor(function(){}), true);
assert.sameValue(isConstructor(function*(){}), false);
assert.sameValue(isConstructor(() => {}), false);
assert.sameValue(isConstructor(Array), true);
assert.sameValue(isConstructor(Array.prototype.map), false);
```

## Implementation Plan

The capability needed is an **IsConstructor bit reachable from an opaque
closure value** at runtime.

1. **Reuse the compile-time predicate.** `callableHasConstructBehavior`
   (`src/codegen/callback-ctor-bridge.ts`) already encodes §15.2.4 correctly
   (ordinary function declarations/expressions and classes are constructible;
   arrows, generators, async functions, methods and accessors are not). Do not
   write a second predicate.
2. **Preferred design (from #4649's sketch): a per-allocation constructible
   flag in the closure wrapper struct**, plus a `__is_ctor_closure` export
   mirroring the existing `__is_closure` (`closure-exports.ts`, bit 17).
   Consumers to update: `__reflect_construct*`, `__construct`,
   `__construct_closure`.
   - The flag is per-ALLOCATION, not per-type — see (3).
3. **Rejected alternative, do not take it:** distinct root wrapper types for
   non-constructible callables. Two closures of the same signature would stop
   being assignable to one slot, which breaks the wrapper-root selection the
   codebase depends on (#3205).
4. **`new arrow()` / `new gen()` must throw a catchable TypeError** once the bit
   exists — that is the same capability seen from the other side, and it is what
   keeps the test's `false` assertions honest. Check how many currently-passing
   test262 tests depend on the present (wrong) permissive behaviour BEFORE
   changing the construct path; if the sweep shows regressions, report them
   rather than widening the PR.
5. Standalone: the test passes there today. Establish WHY before touching shared
   code so the fix cannot flip standalone red.

## Acceptance criteria

- `test262/test/harness/isConstructor.js` passes js-host — **both** the `true`
  and the `false` assertions.
- js-host full harness category reaches **116/116**; standalone stays
  **116/116**.
- js-host 60-sample 59/60 (`AsyncDisposableStack` failure is pre-existing);
  equivalence gate no new regressions beyond the 24 baseline known-failures.
- A broad js-host sweep over `new`-using and `Reflect.construct`-using tests
  shows no regression from making arrows/generators non-constructible.

## Permanent repro

`test262/test/harness/isConstructor.js` (js-host lane,
`tests/test262-runner.ts` `runTest262File(..., undefined)`).
