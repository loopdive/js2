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
  #   `calleeMayHoldNonClosure` flag with its comment, and its read in the
  #   checker-signature ladder's gate; the predicate itself lives in the new
  #   var-non-closure-writes.ts.
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  # 2026-11-19 (S8, review RV-S8) — compileBoundIdentifierCall +4: the
  #   `calleeMayHoldNonClosure` / `closureInfoStale` flags, read by the two
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

**Fix.** `varMayHoldNonClosure`
(`src/codegen/expressions/var-non-closure-writes.ts`) answers whether the
callee's `var` or `let` (found by oracle declaration identity, its writes
scanned over its declaring function or source file with `identifierWritesOf`,
plus the declaration's own initializer, which `identifierWritesOf` leaves out
for a `let`/`const` declarator; cached per declaration) is written more than
once and some write stores anything other
than a function expression, an arrow or a nullish value (`null`, `void x`, the
global `undefined`, resolved through the oracle). So a number, `g += 1`, an
`any` (`JSON.parse`), a union (`c ? 3 : function () {}`), an instance, a
function declaration or builtin of another signature (`g = k`,
`g = Math.max`) all count. When it holds, the call uses neither the recorded
closure info (beside the existing element-read exception) nor the
checker-signature ladder, and takes the inline dynamic call, which calls the
callable the var holds or throws a catchable TypeError. A nullish write keeps
the typed routes: their guard already throws, with the message #7287 pins.
No change to `emitNullCheckThrow`, which every property access shares.

A var written once keeps the typed routes: it holds the value its checker type
describes, which they trust as they trust any typed value. That is what keeps
the harness's `var format = compareArray.format; format(actual)` on the ladder;
without the write count 192 of the 200 byte-identity rows changed.

The first review round's cut was a deny-list instead (a write the oracle types
non-callable); review RV-S8 (delta) showed that a union, `any`, builtin or
compound write slipped through it and still trapped, so the rule is positive.

**Quality acceptance.** Reuses `identifierWritesOf`, `skipOuterExpressions`
and the oracle's declaration identity (which also resolves a local `var g`
shadowing a module `g`, and a shadowed `undefined`); one new cached predicate
in its own module, one flag read by the three gates it controls.

**Tests.** `tests/issue-7334-reassigned-callable-module-var.test.ts`: through
the runner on standalone and gc, the issue repro, the caught form, the
initializer and arrow-initializer forms, the alias (`var h = g; g = 3;
h = g`), a function-local var initialised with a function, a module and a
function-local `let g = function () {}; g = 3`, a compound write,
a union, an `any` and an instance write throw a catchable TypeError; a
function declaration and a builtin of another signature, a function stored
after a number and a var holding only functions are called with the right
result. The repro compiles on wasi. A route check on the emitted WAT pins that
function-only, arrow, null, void and undefined writes, a lone `let` function
initializer, a single property-read
write and a local var shadowing a module var that holds a number keep the
typed call; that a number write (module, function initializer, local) and a
local `undefined` that shadows the global leave it. Each route pin fails under
the matching mutation (predicate always true; no nullish exemption; unresolved
`undefined`; no write count; no ladder gate).

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
compiled with the original harness, identical to base main `ee3fcdd6`. The
700-file seeded run (seed 7106, standalone, compiled and run, passing
590 -> 590, IR-only and passing 130 -> 130, legacy units 1,261 -> 1,261, no
verdict flip) was measured on the first cut, not on this one.

The #7287 case "message: function-initialized, reassigned to a number"
pinned the legacy trap (`legacyTraps`); legacy now throws the same TypeError
as the IR, so the case asserts that and the field is gone.
