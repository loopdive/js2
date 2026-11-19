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
  # 2026-11-19 (S8, review RV-S8) — call-identifier.ts: the import, the
  #   `calleeMayHoldNonCallable` flag with its comment, and its read in the
  #   checker-signature ladder's gate; the predicate itself lives in the new
  #   var-non-callable-writes.ts.
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  # 2026-11-19 (S8, review RV-S8) — compileBoundIdentifierCall +4: the
  #   `calleeMayHoldNonCallable` / `closureInfoStale` flags, read by the two
  #   closure-info conditions and the ladder gate already there.
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

**Cause.** Two typed identifier-call routes in `call-identifier.ts` cast the
slot to one closure signature and trap when the value is not a closure:

1. `compileClosureCall`, with the signature `arrow-phases.ts` (#852) records
   in `ctx.closureMap` from a function write (`getter = function () {}`), for
   module and function-local vars alike: a guarded cast to that closure
   struct, then `emitNullCheckThrow`. A failed cast of a non-nullish value
   (#789: "wrong struct type, don't throw") falls through to `struct.get` on
   null, a trap.
2. The checker-signature ladder, when the checker gives the var a function
   type (`var g = function () {}`, or `var h = g` copying one): a guarded
   cast to the wrapper root, then the funcref fetch, the same trap.

Without a function write and type the same call takes the dynamic route,
which tests IsCallable and throws a catchable TypeError.

**Fix.** `varStoresNonCallable`
(`src/codegen/expressions/var-non-callable-writes.ts`) answers whether some
write of the callee's `var` (found by oracle declaration identity, scanned
over its declaring function or source file with `identifierWritesOf`, cached
per declaration) stores a value no callable can be: a write the oracle types
as a primitive, array, tuple or plain object (`identifierWriteFact`), a
ToNumeric write-back, a for-in key or a rest element. When it holds, the call
uses neither the recorded closure info (beside the existing element-read
exception) nor the checker-signature ladder, and takes the inline dynamic
call. A nullish write keeps the typed routes: their guard already throws, with
the message #7287 pins. So does a value the oracle cannot name (`any`): the
change acts only where a write is provably non-callable. No change to
`emitNullCheckThrow`, which every property access shares.

**Quality acceptance.** Reuses `identifierWritesOf`, `identifierWriteFact`
and the oracle's declaration identity (which also resolves a local `var g`
shadowing a module `g`, and a shadowed `undefined`); one new cached predicate
in its own module, one flag read by the three gates it controls.

**Tests.** `tests/issue-7334-reassigned-callable-module-var.test.ts`: through
the runner on standalone and gc, the issue repro, the caught form, the
initializer and arrow-initializer forms, the alias (`var h = g; g = 3;
h = g`) and a function-local var initialised with a function throw a
catchable TypeError; a function stored after a number and a var holding only
functions are called. The repro compiles on wasi. A route check on the
emitted WAT pins that a var with only function, null or undefined writes, and
a local var shadowing a module var that holds a number, keep the direct
closure call, and that a number write leaves it.

**Not covered (pre-existing, separate).** A function-local `var g; g = 3;
g()` does not throw on main (`ee3fcdd6`): the call reaches the nullish-callee
tail (`stored-member-closure-call.ts`), whose `__apply_closure` dispatch
answers undefined for a non-callable. With a function write first, the same
function-local shape trapped; it now takes that tail and no longer traps, but
still does not throw. `var g = 3; g = function (a) { return a + 1; };
(function () { g(1); })()` throws a false TypeError on main and on this
branch.

## Result

Bytes, 2026-11-19, final predicate: 100 ES5 sample files x standalone and gc,
compiled with the original harness, identical to base main `ee3fcdd6` (no
sample file has the shape). The 700-file seeded run (seed 7106, standalone,
compiled and run, passing 590 -> 590, IR-only and passing 130 -> 130, legacy
units 1,261 -> 1,261, no verdict flip) was measured on the first cut, not on
this one.

The #7287 case "message: function-initialized, reassigned to a number"
pinned the legacy trap (`legacyTraps`); legacy now throws the same TypeError
as the IR, so the case asserts that and the field is gone.
