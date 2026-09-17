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

## S43 findings (2026-09-17) — the true shape, and why the two "what was tried" narrower fixes could not close it

**The decoded runtime error is NOT a stale-funcIdx crash — it is a
misdispatch through the native-proto glue "member not wired" refusal.**
Decoded via `WebAssembly.Exception.getArg` (the S42 repro threw an opaque
externref object that read as `[Object: null prototype] {}` when printed
directly — decoding it gives the real message):

```
Function.prototype.call is not yet implemented in --target standalone
```

That string is minted by `native-proto.ts`'s generic glue-member VALUE-READ
fallback (`emitMemberBody` declined, `refusalBodyFallback: true`), not by
anything in `resolved-callee-guard.ts`. This means `g.call(o)` is NOT reaching
`__extern_method_call`'s dynamic dispatch (which I verified, with WAT
evidence below, dispatches correctly) — it is instead resolving `g.call` as
if it were a READ of `%Function.prototype%.call` as a VALUE off some
native-proto-glue-modeled object, and then invoking that unwired stub.

**WAT evidence that the originally-filed hypothesis (stale `isCallableIdx`/
`typeofFunctionIdx` baked by `buildResolvedCalleeGuard`) does not hold.**
Compiled the minimal repro with `emitWat: true`, dumped
`__extern_method_call`'s body, and cross-referenced against the func-index
order (`grep -n '^  (func \$' *.wat` — the Nth `(func $name ...)` entry is
absolute func index N-1, since this module has zero host imports). Debug
instrumentation in `buildResolvedCalleeGuard` printed
`isCallableIdx=83 typeofFunctionIdx=82` at capture time; the WAT func-order
dump independently confirms `$__typeof_function` is the 83rd func entry
(index 82) and `$__is_callable` is the 84th (index 83) — **the captured
indices are exactly correct**, and the guard's own emitted `call 82`/`call 83`
inside `__extern_method_call` target the right functions. `__new_TypeError`
(the guard's throw target, `call 70`) also resolves to the correct function
(70th entry). None of the funcIdx values baked by `buildResolvedCalleeGuard`
are stale. The "moved capture into `buildClassNotCallableCheck`, still threw"
attempt recorded above was chasing a symptom that was never the cause.

**Compile-time dispatch tracing (debug prints in `expressions/calls.ts`)
shows `g.call(o)` takes the SAME static path whether or not
`Function.prototype` was read earlier** — it falls through every static arm
(no explicit-this-param match since the checker doesn't see through the
`as any` cast; `innerExpr` is an `AsExpression`, not a bare identifier, so
Case 1's `ts.isIdentifier` gate never fires either) all the way to the
generic dynamic `__extern_method_call` dispatch, in BOTH the working and
failing case. The divergence is therefore purely a RUNTIME difference in
what `__extern_method_call` (or something it calls) does for the identical
receiver — not a different compile-time decision.

**The real trigger: `ensureObjectRuntime`'s bootstrap running EARLY/
mid-expression, from ANY caller — not specifically `Function.prototype`.**
Bisected with `.tmp/s43/bisect.mts` / `bisect2.mts` (both copied into the
issue for reproducibility — see the PR): a module that reads
`Function.prototype` (directly, or via `tryEmitDynamicCallableGetPrototypeOf`)
before an ordinary closure's `.call()`/`.apply()` breaks that call. S43 fixed
the `tryEmitDynamicCallableGetPrototypeOf` call site (see the S43 commit,
`object-get-prototype-of.ts`) to only materialise `%Function.prototype%`
*after* `__is_callable`/`__is_class_object` have proven it is needed, which
is a real, regression-free improvement (verified against the 150-witness
family + `tests/issue-6484-*`/`6609-*`/`6625-*`, no change). But it did NOT
close `tests/issue-6484-iterator-prototypes.test.ts`'s failing case, because
that test's trigger is a THIRD, unrelated path:
`ensureIterRecPrototypeHelper` (`src/codegen/iterator-proto-next.ts`)
unconditionally builds **all four** iterator-prototype singletons
(`emitIteratorPrototypeSingleton`, which itself calls `ensureObjectRuntime`
at its own top) on the FIRST `Object.getPrototypeOf(<any-typed iterator>)` in
a module, regardless of which family the program actually uses — this
function is unrelated to S42/S43's own diffs (main-authored, unmodified by
either), and it alone is enough to trigger the same failure
(`.tmp/s43/bisect2.mts` case `I1`: `Object.getPrototypeOf(iter)` once,
nothing else, still breaks a later `g.call(o)`).

**So the true shape of #6630 is: `ensureObjectRuntime`'s bootstrap has an
ordering hazard that fires whenever ANYTHING triggers it early/mid-expression
— not "whenever `Function.prototype` is read".** Every caller that reaches
`ensureObjectRuntime(ctx)` for the first time from inside a nested expression
(rather than at a stable, well-known point) is a candidate trigger; a
call-site-local fix (make one caller lazy) closes that ONE caller's exposure
but not the class of bug. I did not find, within the S43 budget, the specific
piece of state inside `ensureObjectRuntime`'s bootstrap that differs between
an "early" and "natural-order" run and causes the closure `.call`/`.apply`
misdispatch — `CLOSURE_METHOD_CALL` is reserved unconditionally near the top
of the bootstrap (before `__extern_method_call`'s body bakes) and its BODY is
filled generically at FINALIZE (`fillClosureMethodCall`, independent of
materialisation order), so the mechanism the original filing named
(`buildResolvedCalleeGuard`'s captured indices) is ruled out, and the
`CLOSURE_METHOD_CALL` reservation/fill split I checked next did not explain
it either. The suggested directions below (registering the bootstrap's
emitted body in `ctx.liveBodies`, or forcing `ensureObjectRuntime` to run at
a single well-known early point for every standalone/wasi module regardless
of whether the module ends up using it) remain the two most promising
architecture-level fixes; the second is a bigger behavioural change (it would
make every standalone module pay `ensureObjectRuntime`'s registration cost
even when unused) and would need its own measurement pass.

Repro scripts are in `.tmp/s43/repro-6630.mts`, `.tmp/s43/bisect.mts`,
`.tmp/s43/bisect2.mts`, `.tmp/s43/dump-wat.mts` in the S43 worktree/branch
(gitignored — copy them out if resuming this issue).
