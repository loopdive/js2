---
id: 4630
title: "Standalone: asyncHelpers harness self-tests — thenable coercion through asyncTest closures"
status: in-progress
sprint: Backlog
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: test262-conformance
lane: B
files:
  - src/codegen/fn-global-shadow.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/declarations/param-return-inference.ts
  - src/codegen/async-eager-promise.ts
  - src/codegen/closures.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/context/types.ts
loc-budget-allow:
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/declarations/param-return-inference.ts
  - src/codegen/index.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/statements/control-flow.ts
oracle-ratchet-allow:
  # The catch-var detector needs the raw SYMBOL's valueDeclaration to see that
  # a call argument is bound by a `catch (e)` clause — a declaration-IDENTITY
  # question about the binding, not a type question `ctx.oracle` can answer.
  - src/codegen/declarations/param-return-inference.ts
func-budget-allow:
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/declarations/param-return-inference.ts::inferParamTypeFromCallSites
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/closures.ts::compileLiftedClosureBody
---

# #4630 — Standalone asyncHelpers self-tests (4 tests + 1 trap)

## Problem

Five `test/harness/asyncHelpers-*` self-tests fail standalone (measured
2026-08-23 via `runTest262File(..., "standalone")`):

| Test | Symptom |
| --- | --- |
| asyncTest-return-not-thenable | `[false×6]` vs `[true×6]` — none of the six non-thenable return values produced the expected synchronous Test262Error rejection path |
| asyncTest-returns-undefined | `Test262:AsyncTestFailure:Test262Error: [object Object]` |
| asyncTest-then-rejects | same |
| asyncTest-then-resolves | same |
| throwsAsync-same-realm | `RuntimeError: dereferencing a null pointer in __closure_111 (via asyncTest ← __fn_tramp…)` — a hard trap, distinct from the four soft failures (also depends on #4634's realm shim) |

## What the harness needs

`asyncTest(testFunc)` (harness/asyncHelpers.js):

1. calls `testFunc()` and inspects the RESULT for thenable-ness
   (`res && typeof res.then === "function"`) — a duck-typed `.then` read on
   an `any` value that may be a compiled closure result, a native Promise
   carrier, a plain `$Object` with a `then` member, or a primitive;
2. chains `.then(onFulfilled, onRejected)` with harness closures and
   routes the outcome to `$DONE`;
3. `assert.throwsAsync` builds its OWN promise around the thenable and
   compares constructor identities on rejection values.

The `[object Object]` rendering in three of the failures means the
rejection VALUE reached `$DONE`, but it stringifies as a plain object —
the Test262Error's message is not recovered — so either the wrong value is
propagated or `String(err)`/`err.message` on it misses.

## Progress (2026-08-23)

FIXED (3 of 5 net): returns-undefined, then-rejects, then-resolves.
return-not-thenable briefly flipped with a FULL catch-var ref-withdrawal,
but that rule regressed 11 baseline-passing throwsAsync-* tests (widening
`$DONE`'s inferred param cascades into the standalone async/.then lowering
— the async producer demotes and its result stops ref-testing as $Promise).
The withdrawal is scoped to NATIVE-STRING agreements; the struct-ref
agreement + catch-var mis-coercion (return-not-thenable's exact shape)
remains and needs the cascade understood first. Two root causes, neither the thenable duck-typing the survey
guessed:

1. **`globalThis.$DONE = fn` never shadowed the bare `$DONE`**
   (`fn-global-shadow.ts`): standalone, the write landed on the native
   globalThis `$Object` singleton while bare reads kept the static compiled
   binding (§16.1.7 requires aliasing). Fixed with per-name override slots: a
   pre-scan collects `globalThis.<name> =` targets that are top-level
   function declarations; the write also copies the value into a mutable
   slot; bare reads compile to `slot ?? static closure` and bare calls to
   `__apply_closure(slot ?? static, null, argsVec)`. Never-reassigned modules
   are byte-identical.
2. **A catch-clause binding poisoned cross-call-site param inference**
   (`param-return-inference.ts`): `catch (e) { sink(e) }` next to
   `sink("fulfilled")` agreed the param onto native-string; the thrown
   TypeError then coerced to a null string ref and `err instanceof
   TypeError` read null. A catch var is now an OPAQUE any-arg (withdraws
   narrowing), joining the #4530 poison shapes.

REMAINING: return-not-thenable (above) and throwsAsync-same-realm — needs the dynamic-async
substrate: an async function invoked through an `any` binding must return a
native `$Promise` the native `.then` accepts (today the closure call runs
the body eagerly, a sync throw leaks, and the result fails the `ref.test
$Promise`), plus Promise-executor resolve/reject capture. Blocked on that;
also see #4634 for the realm half (landed).

> **Superseded by the second slice below.** The "11 throwsAsync-\* regressions"
> in the paragraph above were **false passes**, not regressions, and the
> "cascade" is not a cascade — see "Progress — second slice". The
> dynamic-async substrate diagnosis in this paragraph was correct and has
> landed for the closure (function-expression / arrow) half.

## Progress — second slice (2026-08-23): the cascade was a FALSE-PASS pair

**The "11 throwsAsync-\* regressions" that blocked the catch-var widening were
never passes.** Measured, not inferred (`runTest262File(…, "standalone")` on
`test/harness/`, this worktree, 2026-08-23):

1. `testFunc()` inside `asyncHelpers.js`'s `asyncTest` **never** produced a
   `$Promise`, at baseline or under the widening. Compile traces show identical
   decisions on both sides: `isAsyncCallExpression=false`,
   `calleeIsDriveLowered=false`, and the async function EXPRESSION's closure
   `decision=PARKED ret=null` — i.e. a **void** wasm result. The dynamic
   closure dispatch therefore substitutes `undefined`, `.then` fails its
   `ref.test $Promise`, `__promise_has_callable_then` is false, and the
   §27.2.5.4 step-2 TypeError is thrown. Site identified by tagging the
   emitted TypeError message with its receiver: `[site testFunc() @48]`.
2. Twelve of the thirteen `asyncHelpers-throwsAsync-*` tests reported **PASS
   anyway**, because a second defect cancelled the first: `$DONE`'s parameter
   was narrowed by call-site agreement to `(ref null $Test262Error)` (the
   `$DONE(new Test262Error(…))` site in `asyncTest`), so the TypeError handed
   to `catch (syncError) { $DONE(syncError) }` **guard-cast to NULL** and
   `doneprintHandle`'s `if (error)` printed `Test262:AsyncTestComplete`.

Proof the widening is not the cause: a call site that widens `$DONE` with **no
catch var at all** (`if (bag.length > 99) $DONE(bag[0])` — an opaque-any arg,
the #4530 rule) reproduces the identical failure on the unmodified test
(`.tmp` repro 2/6). Proof the body really runs: injecting `assert(false)` at the
top of the async test body fails the baseline build with
`Test262:AsyncTestFailure:Test262Error: [object Object]` — the eager
pass-through executes, and the `[object Object]` rendering is the same
`$DONE`-narrowing artifact this issue opened on.

### Landed: the dynamic-async substrate (item B), `src/codegen/async-eager-promise.ts`

A **parked** async arrow / function expression whose unwrapped result is `void`
now gets an `externref` result and settles its completion value through
`Promise.resolve(v)` (`emitStandalonePromiseResolve`, already §27.2.4.7
idempotent). Carrier-gated (`isStandalonePromiseActive`), so gc/host is
untouched. Scope is deliberately the **void** result only: a parked async
closure that returns a VALUE has consumers reading that raw `T` today
(`asyncResultConsumedAsValue`, the #1727 numeric-sink rule) and handing them a
`$Promise` would unbox to NaN — whereas a void closure's dispatch currently
yields `undefined`, so the wrap can only add information.

Measured (full `test/harness/` category, standalone, 116 files):

| build | pass / not-pass | notes |
| --- | --- | --- |
| base (predecessor branch) | **112 / 4** | return-not-thenable, throwsAsync-same-realm, deepEqual-primitives-bigint, wellKnownIntrinsicObjects |
| + eager-async wrap | **113 / 3** | throwsAsync-same-realm flips; **12 throwsAsync-\* now pass HONESTLY** (same-realm needed no realm work beyond #4634) |
| + wrap + full catch-var withdrawal | **114 / 2** | return-not-thenable also flips — but see the cost below |

Regression samples with the wrap alone: standalone 60/60, js-host 59/60 (the
pre-existing `AsyncDisposableStack` failure), a 90-file targeted
async/Promise pass-sample 90/90, and the **whole** standalone-passing
`asyncTest(`-using population (72 files) 72/72.

### NOT landed, with the number that decides it: the full catch-var withdrawal (item A)

Widening the withdrawal from native-string-only to every GC-`ref` agreement is
**correct** — `catch (e)` binds whatever was thrown and is never evidence for
the other call sites' type — and it does flip `asyncTest-return-not-thenable`.
It is held back because it **un-hides 12 pre-existing standalone failures for
1 gain**. Measured on the 72-file `asyncTest(`-using population:

- 72/72 with the wrap alone → **60/72** with the wrap + withdrawal.
- The 12: 4 × `Array.fromAsync is not yet implemented in --target standalone`;
  4 × `then called on a non-Promise receiver` (the **declaration** analogue —
  `asyncTest(foo)` where `foo` is an async function *declaration*, whose wasm
  result is likewise void; `evaluation-this-value-global.js`, the three
  `expressions/await/syntax-await-*`); 1 × standalone dynamic import (#3494);
  1 × `for await: iteration limit exceeded`; 1 × `await-using` null property;
  1 × for-await-of `value is not iterable`.
- Every one of those was passing **only** through the `$DONE`-nulling. None is
  caused by the withdrawal; the withdrawal stops hiding them.

Prerequisites before the withdrawal can land conformance-neutral:
1. the **declaration** side of the substrate — a parked async function
   *declaration* referenced as a value must also return a `$Promise`. Note the
   ordering hazard: `wrapAsyncReturn` reads `wasmFuncReturnsVoid(funcIdx)` at
   the call site, so promoting a declaration's result after some call sites
   have compiled can desync the stack (the same hazard `maybeActivateAsync`'s
   `rewriteFuncResultType` already lives with);
2. `Array.fromAsync` standalone (4 tests), `#3494` dynamic import (1),
   for-await iteration-limit (1), `await-using` (1), for-await-of iterator
   close (1) — or an accepted, deliberate net-negative decision from the lead.

## Implementation Plan (updated 2026-08-23, post-slice)

Two remaining tests, two independent work items:

### A. asyncTest-return-not-thenable — the \$DONE widening cascade

Known facts (measured):
- `$DONE`'s param agreement in this module is the Test262Error struct
  (`ref_null` 17/19); the catch-var arg (a thrown TypeError) guard-casts to
  null, so `error instanceof TypeError` reads null → `[false×6]`.
- Withdrawing the struct-ref agreement (JS2_CV_FULL experiment, see the
  scoping comment in param-return-inference.ts) FIXES this test but breaks
  11 throwsAsync-* tests with `Promise.prototype.then called on a
  non-Promise receiver` — i.e. widening `$DONE(param)` to externref makes
  `testFunc().then(...)` inside asyncTest receive something that fails the
  native then's `ref.test $Promise`.
1. Diagnose the cascade FIRST: re-apply the full withdrawal locally, take
   asyncHelpers-throwsAsync-no-arg.js, and trace WHY the async testFunc's
   result stops being a `$Promise` (suspects: the standalone async-producer
   gate consults inferred callback/param types and demotes the producer;
   or the .then receiver arm's carrier acceptance). Use the mark-trace
   method (prepend env-gated console.error probes, or return-instrument
   compileNewExpression-style) — do not guess.
2. Fix the cascade at its site (the producer gate or the then-receiver
   acceptance), THEN widen the catch-var withdrawal from anyStr-only to all
   ref/ref_null agreements.
3. Acceptance: FULL standalone harness category run (.tmp/run-harness-all
   equivalent) — return-not-thenable passes AND all 13 throwsAsync-* stay
   green; the 60/60 standalone + 60/60-1 js-host samples stay clean.

### B. throwsAsync-same-realm — dynamic-async substrate

Repro (from the survey): `driver(async function () { throw new
Test262Error("boom"); })` with driver calling `testFunc().then(f, r)` —
today the async body runs eagerly, the sync throw leaks, and the returned
value fails `ref.test $Promise`.
1. Make a dynamically-invoked async FUNCTION EXPRESSION return the native
   `$Promise` carrier (body throw → rejected promise, return → resolved),
   at least for the await-carrying shapes asyncTest exercises.
2. `new Promise(function (onF, onR) { outer1 = onF; outer2 = onR; })` —
   executor capture into outer vars must hand out working resolve/reject.
3. Acceptance: asyncHelpers-throwsAsync-same-realm.js passes (its realm
   half already landed in #4634); full category + samples clean.

## Original Implementation Plan

1. **Reproduce small**: reduce each failure in `.tmp/` probes:
   (a) `typeof x.then === "function"` for x = compiled async fn result,
   plain object with `then`, number; (b) `.then(f, r)` on a native promise
   held in `any`; (c) `String(thrownTest262Error)` through the async
   rejection path. Identify which of the three legs breaks per test.
2. **Fix the `.then` duck-typing leg** first (likely shared with #4629's
   any-member-read mechanics): the native Promise carrier must answer a
   callable `then` through `__extern_get`.
3. **Fix rejection-value fidelity**: the async frame's rejection plumbing
   (async-frame.ts) must hand the ORIGINAL thrown value to the `onRejected`
   closure, not a re-boxed generic object; verify `err.message` and
   `err.constructor` survive (constructor identity additionally needs the
   fnctor proto machinery, cf. #4626 third-slice notes).
4. **Trap in throwsAsync-same-realm**: chase the null deref in
   `__closure_111` separately — reproduce with the full-harness assembly,
   bisect includes; do NOT fold into the soft fixes.
5. **Acceptance**: the four soft tests pass standalone;
   the trap test at minimum stops trapping (its pass additionally requires
   #4634); 20-test standalone sample over `built-ins/Promise/**`
   baseline-pass tests shows 0 regressions.
