---
id: 6630
title: "ensureObjectRuntime's fctx=null bootstrap bakes stale funcIdx values when a native is registered after it"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: hard
owner: ""
---

## Problem

`ensureObjectRuntime`'s bootstrap (`src/codegen/object-runtime.ts`, called via
`flushLateImportShifts(ctx, null)` at its own top) compiles
`__extern_method_call`'s body — including `buildResolvedCalleeGuard`'s
(`src/codegen/resolved-callee-guard.ts`) `.call()`/method-call TypeError guard
— with **whatever func indices happen to be live at that moment**, and with
`fctx = null` there is no live `FunctionContext` for `flushLateImportShifts`
to register this freshly-baked body against for a LATER shift correction (the
module's own docstring already says this explicitly: "this builder runs from
inside `ensureObjectRuntime`'s bootstrap … which has no live `FunctionContext`
to relocate a fresh import's index shift against").

If **any native function gets registered for the first time AFTER**
`ensureObjectRuntime`'s bootstrap has already run — e.g. lazily materialising
`Function.prototype` for the first time in a module (a `$Object` "reified
builtin FUNCTION constructor" carrier gets minted, which is uncommon enough
that most modules never trigger it before their first `.call()`) — every
funcIdx `ensureObjectRuntime`'s bootstrap already baked into `fctx.body`
(and NOT just `buildResolvedCalleeGuard`'s two captured constants,
`isCallableIdx`/`typeofFunctionIdx`/`brandIdxs` — the entire pre-baked
`__extern_method_call` body) is now wrong, because the module inserted new
func(s) ahead of it in index space.

**Reproduced, minimal, independent of `main`/#5383's stack**: on
`b84898a96c` (the accepted #5383 S41b head, with NO other changes) —

```ts
var fp = Function.prototype;
function g(this: any) { return this; }
var o: any = {};
export function test(): number { return (g as any).call(o) === o ? 1 : 0; }
```

throws an uncaught `WebAssembly.Exception` at runtime (an ordinary function
`g`, unrelated to `fp`, fails to `.call()`). `Function.prototype` alone —
no `Object.getPrototypeOf`, no class — is enough to trigger it.

## Why this surfaced now

It was dormant: nothing in the #5383 stack's own 150 witnesses combines
"materialise `Function.prototype`" with a LATER unrelated `.call()` in the
same module. #6629 (S42, syncing #5383 onto `origin/main`) restores
`tryEmitDynamicCallableGetPrototypeOf` (#6609/#6625) to actually run for
`Object.getPrototypeOf` on an `any`-typed receiver in modules that also use an
iterator (main's #6484 S1 had accidentally short-circuited it — see #6629)
— and that predicate itself reads `Function.prototype`. Restoring the
predicate's reachability is correct and necessary (#6609/#6625's own
witnesses), but it also means `Function.prototype` now gets materialised in
far more modules than before, which is what exposed this pre-existing gap:
`tests/issue-6484-iterator-prototypes.test.ts`'s `"%IteratorPrototype% is the
shared parent, with an own [Symbol.iterator]"` case (which reads
`Object.getPrototypeOf` twice, transitively reaching `Function.prototype` via
neither test directly — its own later steps use `.call()`) now fails on the
post-#6629 merged tree, even though #6629's own fix is correct and its own
150 witnesses are green.

## What was tried in #6629 and did NOT fix it

Moved `buildResolvedCalleeGuard`'s `isCallableIdx`/`typeofFunctionIdx` capture
from "once at factory-build time" to "fresh, inside `buildClassNotCallableCheck`,
looked up on each closure invocation" — plausible given the factory's own
"captured once" language, but the repro STILL threw. This proves the staleness
is not limited to those two named constants; the ENTIRE `__extern_method_call`
body baked by the `fctx=null` bootstrap is untracked, so a narrow fix at the
two-constant level cannot close it. Reverted (not shipped) — see #6629's
findings.

## Suggested directions (not attempted — architecture-level, needs a design pass)

1. Make `ensureObjectRuntime`'s bootstrap track its own emitted body for later
   shift correction even with `fctx = null` (e.g. register it in
   `ctx.liveBodies` — see `late-imports.ts`'s existing `ctx.liveBodies`
   mechanism, which patches bodies NOT reachable through
   `fctx.savedBodies`/`ctx.currentFunc` chains — if `ensureObjectRuntime`'s
   bootstrap output isn't already going through that registry, route it
   there).
2. Force-register `__is_callable`/`__typeof_function`/the Function-constructor
   carrier brand BEFORE `ensureObjectRuntime`'s bootstrap ever runs (rejected
   once already per the module's own docstring, for module-size reasons — the
   tradeoff might read differently now that #6629 makes the predicate's
   reachability the common case rather than the exception).
3. Defer `ensureObjectRuntime`'s bootstrap until genuinely first needed (verify
   it isn't running eagerly at module prelude regardless of source order —
   unconfirmed here, worth checking directly with a funcIdx dump before vs.
   after the `Function.prototype` statement).

## Acceptance criteria

- `Function.prototype` (or any other currently-lazy native/carrier) read
  anywhere in a standalone module no longer corrupts a later, unrelated
  `.call()`/method-call in the same module.
- `tests/issue-6484-iterator-prototypes.test.ts`'s `"%IteratorPrototype% is
  the shared parent, with an own [Symbol.iterator]"` case passes.
- A new regression test pins the minimal repro above directly (no iterator,
  no class — just `Function.prototype` + an unrelated `.call()`).
- No existing witness (#5383 stack's 150, or `tests/issue-6484-*`,
  `tests/issue-6609-*`, `tests/issue-6625-*`) regresses.
