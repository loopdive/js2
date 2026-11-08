---
id: 7334
title: "Legacy: calling a script var reassigned from a function to a number traps instead of throwing TypeError"
status: ready
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
