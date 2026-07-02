---
id: 2940
title: "standalone: __make_callback sole-leak is the harness-wrapper vacuous pass — gated on dynamic-closure-dispatch arity/type tolerance (sub-front 4 of #2903 yields 0)"
status: blocked
sprint: current
priority: high
feasibility: hard
reasoning_effort: max
task_type: research+bugfix
area: codegen
language_feature: closures, dynamic-dispatch, typed-arrays, test262-harness
goal: host-independence
assignee: ttraenkler/dev-callback
related: [2939, 2903, 2879, 2075]
blocked_on: "#2939 (formerly #2923; arity half landed via PR #2441): dynamic dispatch of `fn(...)` on an any-typed closure param must tolerate arity mismatch + coerce arg type-kinds (calls-closures.ts) — otherwise removing the import yields DISHONEST vacuous host-free passes"
created: 2026-07-02
updated: 2026-07-02
origin: "2026-07-02 __make_callback sole-leak-front measurement (dev-callback). origin/main @ 4d5287afc, target standalone, merged report run 28491700781."
---

# #2940 — `env::__make_callback` sole-leak: measured root cause + yield gate

> Formerly drafted as #2921, then #2931, then #2937 on this branch; all three
> ids were concurrently taken on main by parallel sessions (2921 =
> drain-microtasks intrinsic PR #2425; 2931 =
> live-binding-reassigned-function-decl; 2937 =
> acorn-host-object-hash-poison-null-deref-regression). Reallocated to #2940
> to clear the `check:issue-ids:against-main` collision (each hop via
> `claim-issue.mjs --allocate`).

## TL;DR / decision

The 1,364 standalone sole-`__make_callback` passes are **NOT** flippable by
TypedArray HOF native bodies (sub-front 4 of #2903): measured yield **0**. All
601 TypedArray files leak from the test262 **harness wrapper**
(`testWithBigIntTypedArrayConstructors(function(TA){…})`), not any HOF. Adding
the missing runner shim removes the import, but the bodies **stay vacuous** — the
compiler's dynamic dispatch of a closure held in an `any`-typed parameter
(`fn(ctor, factory)` inside the shim) only invokes the closure when the call
arg-count **and** arg type-kinds exactly match the callback's declared params.
So a shim-only change converts an _honestly-flagged_ leaky-pass into a
**dishonest clean (host-free) vacuous pass** — metric goes up but tests nothing.
**Genuine-flip yield with a bounded fix = 0**, below the 200 build-gate →
**blocked**, pending the dynamic-dispatch fix below.

The original import-gate hypothesis (#2405 pattern) is disproven: the import is
_referenced_ (`WebAssembly.instantiate(binary, {})` rejects `Import #0 "env"`),
consistent with merged research #2903.

## Measurement (origin/main @ 4d5287afc, `target: standalone`, run 28491700781)

- Sole-leak set (`status==pass`, `imports==["env::__make_callback"]`): **1,364**;
  total `__make_callback` touches: **5,572**. (Matches the brief.)
- Category: **TypedArray\* 601** (348 TypedArray + 253 TypedArrayConstructors),
  **Temporal 707**, Iterator 18, other 38.
- Of the 601 TypedArray: **601/601** contain the `testWith*Constructors(function…)`
  wrapper; **572** use `testWithBigIntTypedArrayConstructors`; only **~202** even
  call a HOF method; 337 use a 2-arg (`makeCtorArg`) callback.

### Why sub-front 4 yields 0

Live trace (`TypedArray/prototype/every/BigInt/callbackfn-returns-abrupt.js`,
standalone) shows the two `__make_callback` emissions are:

- the `function(TA, makeCtorArg){…}` **wrapper** → `compileArrowAsCallback` from
  `src/codegen/expressions/calls.ts:13393` ("graceful fallback for unknown
  functions": `testWithBigIntTypedArrayConstructors` is unresolved in `funcMap`);
- `assert.throws(T, function(){})` → closed-method dispatch (`calls.ts:11624`).

Neither is a HOF callback; the import is module-scoped, so native HOF bodies
remove **zero** imports.

### Why the wrapper is unresolved (runner shim gap)

`tests/test262-runner.ts` shims `testWithTypedArrayConstructors` but:

1. the gate `needsTestTypedArray` tested `/testWithTypedArrayConstructors/`,
   which does **not** match `testWith`**`BigInt`**`TypedArrayConstructors`;
2. no `testWithBigIntTypedArrayConstructors` shim existed;
3. the shim passed only 1 arg (`fn(ctor)`), so tests declaring
   `function(TA, makeCtorArg)` got `makeCtorArg === undefined`.
   A prototype shim (BigInt wrapper + a passthrough `makeCtorArg`, fixed regex)
   removes the import and instantiates **host-free** — confirmed on samples.

### But it stays VACUOUS — the real blocker

With the shim, the wrapper resolves and the callback goes the closure path (no
`__make_callback`), yet injecting `throw`/`log()` as the wrapper body's first
statement **never fires**. Isolated repro (`.tmp`) pins the compiler gap in the
dynamic dispatch of `fn(...)` where `fn` is an `any`-typed param
(`src/codegen/expressions/calls-closures.ts`, e.g. the exact-arity gate at
L688 `if (info.paramTypes.length !== sigParamCount) continue;` + the per-param
kind check L693–698):

| call                   | callback params     | invoked?                                |
| ---------------------- | ------------------- | --------------------------------------- |
| `fn(x)`                | `(TA)`              | YES                                     |
| `fn(x, y:number)`      | `(TA, m)`           | YES                                     |
| `fn(x)`                | `(TA, m)`           | NO (arity)                              |
| `fn(x, y)`             | `(TA)`              | NO (arity)                              |
| `fn(ctor[i], namedFn)` | `(TA, makeCtorArg)` | NO (arg type-kinds != externref params) |

Real 2-param BigInt tests: 25/25 sampled stay **vacuous** with the shim (the
shim passes a constructor value + a funcref, whose kinds don't match the
callback's `any`/externref params -> dispatch skips). So **genuine-flip yield with
shim alone = 0**, and shipping it would be _harmful_ (dishonest host-free
vacuous passes).

## The real fix (2 parts) — gated, not built

1. **Runner shim** (`tests/test262-runner.ts`): add
   `testWithBigIntTypedArrayConstructors` + a `makeCtorArg` passthrough factory,
   fix the `needsTestTypedArray` regex to `/testWith(?:BigInt)?TypedArrayConstructors/`.
   (Prototype done on this branch; do NOT ship alone.)
2. **Compiler — dynamic closure dispatch of an `any`-typed param**
   (`src/codegen/expressions/calls-closures.ts`): make `fn(...)` invoke the
   matched closure under **JS arity semantics** (pad missing args with
   `undefined`, drop extras) and **coerce args to the closure's param kinds**
   instead of requiring exact arg-count/type-kind match. This is a hot, fragile
   core-dispatch path — scope/verify carefully; it is a _general_ improvement
   (any dynamic `fn(...)` with arity/type mismatch), not TypedArray-specific.
3. Only then does genuine PASS depend on the underlying BigInt
   TypedArray/detached-buffer/species semantics per test — unmeasured, likely
   partial. Corpus OUTPUT-vs-js-host diff required before shipping (a vacuous
   host-free pass must be counted as a fail, not a pass, by the harness).

## Metric-safety caveat (corrects the earlier framing)

"Removing the import can only move the honest metric up" holds **only if the
body actually executes**. With the current compiler it does not — the shim
alone produces host-free _vacuous_ passes, which is a **dishonest** metric gain.
Metric-safety is contingent on part (2) landing.

## Status

Blocked pending the dynamic-dispatch fix (part 2). Genuine-flip yield with a
bounded fix = 0 (< the 200 build-gate). Analysis delivered; claim released;
recommend spinning part (2) as its own scoped codegen issue (broad value beyond
this leak). Import-gate hypothesis disproven; sub-front 4 disproven.

**Re-measured 2026-07-02 (dev-f2, task #16) after PR #2441 (arity fix)
landed: STILL BLOCKED — genuine flips remain 0.** The arity half works at
module top level, but the runner wraps every test body inside
`export function test()`, and a callback function-expression defined in a
nested scope is NOT a dispatch candidate — so the shimmed wrapper compiles
host-free with a dead body (9/9 sampled host-free files VACUOUS by
inject-throw; control on main = honestly leaky). Shim NOT shipped. Full data +
the deferred shim text now live in #2939 ("Re-measurement post PR #2441").
Remaining blocker = #2939 (a) nested-scope candidate registration, then
(b) kind coercion.
