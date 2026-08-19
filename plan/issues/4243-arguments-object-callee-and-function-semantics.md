---
id: 4243
title: "arguments.callee as a real own property, and the remaining function-semantics pool"
status: done
completed: 2026-08-08
sprint: 78
created: 2026-08-08
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: es5
related: [4221, 4220, 4222, 4223, 4224, 2916]
# loc-budget (wave-3 PR aggregate vs main): emitCachedFuncClosureExternref cast-free reader beside the singleton it guards
loc-budget-allow:
  - src/codegen/expressions/calls-closures.ts
  # closures.ts (+4): one import plus a two-line call at the ONLY point where a
  # lifted function expression's arguments vec exists and its `__self` is still
  # in scope — immediately after `emitArgumentsVecBody`. The seed body itself
  # lives in the satellite `arguments-callee.ts`; this is the call site, and it
  # cannot move without moving the arguments-vec construction with it.
  - src/codegen/closures.ts
func-budget-allow:
  # Both are the same shape: a single call appended to the arguments-object
  # construction block of an existing giant builder. The seed needs the block's
  # `argsLocal` and (in the closure case) its param-0 `__self`, neither of which
  # survives extraction; splitting either host function is #3399-class work
  # unrelated to this issue.
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/function-body.ts::compileFunctionBody
origin: "2026-08-08 — ES5-standalone-90 Wave 3, WP2 continuation (#4221 leftovers)"
---

# #4243 — the `arguments`-object model in standalone

Continuation of #4221, whose "deliberately NOT in scope" list ends with:

> `language/arguments-object` — `arguments.callee` as a real own property with
> descriptor attributes, and `arguments.constructor`. Untouched.

That was the right call there — it is its own model change, and this issue is
that change.

## Baseline

`language/arguments-object`, standalone lane, 43 ES5-tagged files, measured
sequentially with `runTest262File` (the #4162 shared seam) on the Wave-2 branch
tip `ccd037fe`: **26 pass / 17 fail**, matching the recorded bucket exactly.

A **method note that cost real time**: five of those files first measured as
`TypeError: WebAssembly.instantiate(): Import #0 module="js2wasm:runtime-eval"`
— not a compiler result at all, but this worktree's missing runtime-eval
provider cache. `node --import tsx scripts/build-runtime-eval-provider.mjs
--refusal-only` builds it. The bare `node` invocation fails with "no compiler
available"; the `--import tsx` form is the one that works from a fresh
worktree. Without it, five files carry an instrument artifact instead of their
real signature, which is exactly the #4162 failure mode.

## Problem 1 — `callee` is not an own property (non-strict)

The standalone arguments object is a `__vec_externref` struct built by
`emitArgumentsVecBody`: elements plus `length`, nothing else. ES5 §10.6 step
13.a additionally creates

```
callee: { value: func, writable: true, enumerable: false, configurable: true }
```

on every non-strict arguments object. That step was never emitted, so
`arguments.callee` answered `undefined`, `arguments.hasOwnProperty("callee")`
was `false`, and `Object.getOwnPropertyDescriptor(arguments, "callee")` was
`undefined`.

### Fix

`src/codegen/arguments-callee.ts` (new) installs `callee` through the same
native `__defineProperty_value` that a source-level
`Object.defineProperty(arguments, "callee", …)` already lowers to in this lane,
so the descriptor comes out right by construction and the array-exotic
[[DefineOwnProperty]] arm from the WP1 descriptor work is reused.

Deliberately NOT the #3537 vec expando bag (`__vec_prop_set`): that would make
the read work, but `buildBagValueSeed` reflects every bag entry into the #3251
descriptor companion with one fixed `SEED_FLAGS = 0xBF`, i.e.
`enumerable: true`. `callee` is specified non-enumerable and `10.6-12-2` checks
exactly that bit.

The callee VALUE is supplied by the caller as a thunk, because the two
construction sites have different — and equally canonical — answers:

| site | callee value |
| --- | --- |
| `function-body.ts` (hoisted declaration) | the cached closure singleton for its name — the same object an `f1` identifier read yields, which is what makes `arguments.callee === f1` hold by identity |
| `closures.ts` (lifted function expression) | `__self`, local 0 — already the closure struct the caller invoked, so identity is free |

### The regression this produced first, and why it is worth recording

The first cut used `emitCachedFuncClosureAccess` at the declaration site and
**killed two tests that had been passing** — `10.6-6-2` and `10.6-11-b-1` — with
`RuntimeError: illegal cast`, inside the very function the seed was added to.

Root cause is a live hazard in shared machinery, not in the seed:
`ensureFuncClosureSingleton` memoizes the trampoline + cache global by NAME but
recomputes `closureStructTypeIdx` from the `constructible` flag on every call,
and the constructible wrapper is a **subtype** of the plain one
(`superTypeIdx: base.structTypeIdx`). Two callers that disagree about the flag
therefore share one cache global and disagree about the struct type — and the
mismatch is asymmetric:

- cast a stored **constructible** wrapper to the **base** type → succeeds;
- cast a stored **base** wrapper to the **constructible** type → **traps**.

A module-init binding seed had already stored the base wrapper, and the seed's
`ref.cast` to the constructible type trapped. Instrumented proof from the
compile of `10.6-6-2`:

```
[singleton] testcase key=testcase constructible=false struct=160 cache=180
[singleton] testcase key=testcase constructible=true  struct=179 cache=180
```

Same cache, two struct types.

Fix: `emitCachedFuncClosureExternref` (new, in `closures/method-trampolines.ts`)
— the externref-only half of `emitCachedFuncClosureAccess`, which skips the
struct recovery entirely. A caller that wants a first-class VALUE, not a
`call_ref` fast path, never needs the struct view, and `arguments.callee` is
exactly that caller: the value goes straight into a property descriptor. The
seed also passes the WIDER (constructible) flavor, which is the safe direction
for the store.

The underlying flavor-vs-cache hazard is left in place — it predates this issue
and fixing it properly means recording the flavor per key — but it is now
documented at both ends.

## Problem 2 — strict `arguments.callee` does not throw

§10.6 step 14 gives a STRICT arguments object a `callee` ACCESSOR whose
`[[Get]]` and `[[Set]]` are both %ThrowTypeError%, `{enumerable: false,
configurable: false}`. Minting that faithfully needs an in-module callable
throwing-function value, which this lane does not have.

What it CAN do without that machinery is the case the spec text exists to
produce: a direct `arguments.callee` read in strict code throws a TypeError.
That is decidable syntactically, so it needs no runtime accessor —
`src/codegen/arguments-callee-poison.ts` is the deliberate twin of #4221's
`function-poison-pill-access.ts`, dispatched from the same
`tryCompileFunctionPoisonRead` hook so both `property-access.ts` call sites get
it without a third entry point. It is lane-independent, because strictness is a
source property, not a target one.

The load-bearing negative case is the receiver test: the poison fires only on
the IMPLICIT `arguments` binding. A function that declares its own (`var
arguments = …`, legal in sloppy code, and used by `10.6-6-3`/`10.6-6-4` in this
very directory) must keep its ordinary property read, so a non-`undefined`
`oracle.valueDeclarationOf` declines.

## Tests

`tests/es5-standalone-arguments-callee.test.ts` — 12 cases covering both halves.
The two that guard against silent breakage rather than asserting the feature:

- *"stays out of for-in"* — test262's `propertyHelper.js` decides enumerability
  with a `for (x in obj)` scan, not by reading the descriptor, so a descriptor
  that says `enumerable: false` while the key still shows up in for-in fails
  `verifyProperty` even though the descriptor assertion passes.
- *"does NOT throw when the function declares its own `arguments`"* — the
  poison's negative case, above.

Note the harness helper passes `inferModuleStrictArguments: false`: the probe's
own `export function test()` makes TypeScript classify the source as a module,
and module code is strict (§11.2.2), so with the default every function under
test would be strict and take the step-14 path instead. Same reason the test262
harness passes `false` for script-goal tests (#2119).

## Measured flips

Standalone lane, `runTest262File`, sequential re-verify of every transition:

| test | before | after | from |
| --- | --- | --- | --- |
| `language/arguments-object/10.6-12-2` | fail | **pass** | problem 1 |
| `language/arguments-object/S10.6_A4` | fail | **pass** | problem 1 |
| `language/arguments-object/10.6-2gs` | fail | **pass** | problem 2 |
| `language/arguments-object/10.6-13-c-1-s` | fail | **pass** | problem 2 |

Bucket total 26 → **30** pass of 43, **0 regressions**.

Two more files improved without flipping, which the count hides:
`S10.6_A3_T1` and `10.6-13-c-2-s` now pass their sloppy run and fail only on the
`strict rerun:` line — both are waiting on the real accessor.

### Regression sampling

A 94-file cross-section of the tests that actually exercise this code — every
file under `language/{statements/function,function-code,expressions/call,
expressions/function,statements/return}` and `built-ins/Function` that mentions
`arguments`, sampled deterministically — run sequentially on both sides of a
build-level kill switch:

| | pass | fail | compile_error |
| --- | --- | --- | --- |
| without #4243 | 71 | 22 | 1 |
| with #4243 | 71 | 22 | 1 |

Byte-for-byte identical: **0 regressions, 0 in-sample gains** (the gains are all
inside `language/arguments-object`, measured separately above).

**Method note, inherited from #4221 and confirmed again here.** A first attempt
at a broader 435-file cross-section had to be abandoned: another agent's test
run put this box at load ~10, and `runTest262File` reports a TIMEOUT as
`compile_error`, so a sample taken under that load manufactures phantom
regressions. Every transition reported above was re-verified sequentially.

## Deliberately NOT in scope (leftovers, with the mechanism named)

- **The real strict `callee` ACCESSOR (§10.6 step 14).** The syntactic poison
  covers the direct read; a descriptor QUERY still needs an accessor with
  `configurable: false` and both `get`/`set` present (`10.6-13-c-3-s` asserts
  `desc.hasOwnProperty('get')`). That needs a callable in-module
  %ThrowTypeError% value — mint a defined func that throws, then wrap it with
  the closure ABI so `__defineProperty_accessor` can take it. Blocks
  `10.6-13-c-3-s`, `10.6-14-c-4-s` (assignment through an ESCAPED arguments
  object, which is a value not an identifier and so out of the syntactic
  poison's reach), and the strict reruns of `S10.6_A3_T1` / `10.6-13-c-2-s`.
- **Inlined IIFEs have no function object.** `(function () { return arguments })()`
  is inlined by `expressions/call-tail-dispatch.ts` — no lifted closure, no
  `__self`, no wasm function to reference — so there is nothing to install as
  `callee`. Confirmed by instrumentation: `emitArgumentsVecBody` is never
  reached for that shape; the IIFE builds its arguments vec inline. Blocks
  `10.6-13-a-1` and `10.6-14-c-1-s`. Naming a callee here means either
  materializing a closure for an inlined body (defeats the inlining) or
  declining the inline when the body reads `arguments`.
- **`arguments.length` is not a real writable property** — `arguments.length = str`
  with a STRING value does not round-trip (the vec `length` field is i32), and
  `delete arguments.length` throws instead of answering `true`. Blocks
  `S10.6_A5_T3`, `S10.6_A5_T4`, `10.6-7-1`. Separate mechanism: `length` needs
  to move into the descriptor companion the way `callee` now is.
- **`Object.defineProperty(arguments, "length", …)` throws** — pre-existing, and
  verified pre-existing by A/B (it throws identically with the seed disabled).
- **`arguments.constructor`** (`S10.6_A2`) — untouched; wants
  `%Object.prototype%` on the vec's proto chain.
- **`10.6-6-3` / `10.6-6-4`** — `var arguments = undefined;` in an outer function
  shadowing the implicit binding, then a nested IIFE reading `arguments.length`,
  null-derefs. Independent shadowing bug.
