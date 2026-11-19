---
id: 7334
title: "Legacy: calling a script var reassigned from a function to a number traps instead of throwing TypeError"
status: done
completed: 2026-11-19
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7287, 7324, 7305]
loc-budget-allow:
  # 2026-11-19 (S8) — call-identifier.ts: the import and the flag; the predicate itself lives in the
  #   new module-var-function-writes.ts.
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  # 2026-11-19 (S8) — compileBoundIdentifierCall +1: the `closureInfoStale`
  #   flag, read by the two closure-info conditions already there.
  - src/codegen/expressions/call-identifier.ts::compileBoundIdentifierCall
---

# #7334: `getter = function () {}; getter = 3; getter()` traps on the legacy route

## Problem

A script `var` that first holds a function and is then reassigned to a
non-callable value is called from a closure. The call should throw a
catchable TypeError. On the legacy route it traps (`WebAssembly.RuntimeError`)
on standalone, wasi and gc, so `assert.throws` never sees an exception.

Found by RV7185 (the fresh-context review of PR #7185). It is pre-existing:
main `b631a4bc`, before #7164 / #7287 landed, traps the same way. The unit is
on the legacy route on both sides; `<module-init>` is not IR-claimed for this
shape.

## Repro (bare compile; standalone, wasi and gc alike)

```js
function assert(v) {}
assert.throws = function (C, f) { try { f(); } catch (e) { return; } throw "no throw"; };
var getter;
getter = function () {};
getter = 3;
assert.throws(TypeError, function () { getter(); });
```

- node: completes (the call throws TypeError, which is caught).
- js2wasm, main `b631a4bc` and `636331310e`: `<module-init>` legacy, RuntimeError
  (trap) on all three lanes, `irPostClaimErrors` empty.

Without the first assignment (`getter = 3` only, or `getter = 3; getter =
undefined`), `<module-init>` is IR-claimed (#7287) and completes correctly.

## Direction

Find legacy's call through the module slot when the slot's static type is
the function value: the reassignment to a number probably leaves a
closure-typed slot whose call path casts without an IsCallable check. The fix
belongs in legacy's call-through-slot lowering (or the slot type must widen
to the carrier once a non-callable is stored). Pin the repro with a bare
compile on all three lanes.

## Implementation Plan

Reproduced on main `ee3fcdd6` (2026-11-19): the runner traps on standalone
and gc (`dereferencing a null pointer`); a smaller shape is an immediately
called function that calls `getter` in a `try`.

**Cause.** `arrow-phases.ts` (#852) records a module `var`'s closure
signature in `ctx.closureMap` when a function is assigned to it, and the
identifier call (`call-identifier.ts`) then takes `compileClosureCall`: a
guarded cast of the externref global to that closure struct, then
`emitNullCheckThrow`. A failed cast of a non-nullish value (#789: "wrong
struct type, don't throw") falls through to `struct.get` on null, a trap.
Without the function write the same call takes the dynamic route, which
tests IsCallable and throws a catchable TypeError.

**Fix (`src/codegen/expressions/call-identifier.ts`).** The recorded
signature describes the live value only when every write of the var stores
a function expression or arrow, or a nullish value (whose guard already
throws, with the message #7287 pins). `moduleVarHoldsNonFunctionWrite` (one walk
of the source per declaration over `identifierWritesOf`, cached) answers
that; when it holds, the call does not use the recorded closure info, like
the existing element-read and mutable-capture exceptions beside it, and the
inline dynamic call stays available. No change to `emitNullCheckThrow`,
which every property access shares.

**Quality acceptance.** Reuses `identifierWritesOf` / `skipOuterExpressions`
and the oracle's declaration identity; one new cached predicate in its own module
(`module-var-function-writes.ts`), consulted beside the sibling
`bindingIsPopulatedFromElementRead`.

**Tests.** `tests/issue-7334-reassigned-callable-module-var.test.ts`: the
issue repro and the caught form throw a catchable TypeError, a function
stored after a number and a var holding only functions are called, through
the runner on standalone and gc; the repro compiles on wasi.

## Result

700-file seeded ES5 sample (seed 7106, census population; standalone,
original harness, compiled and run), base main `ee3fcdd6` vs this branch,
2026-11-19: passing 590 → 590, IR-only and passing 130 → 130, legacy units
1,261 → 1,261, no verdict flip (no sample file has the shape). Bytes: 100
files × standalone and gc identical to base. Both were measured with a
first cut that also sent nullish writes to the dynamic route; the final
predicate acts on a subset of those files.
