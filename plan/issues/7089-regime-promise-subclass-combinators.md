---
id: 7089
title: "Regime gap: Promise combinators called on a subclass (`Promise.all.call(SubPromise, …)`, `withResolvers.call`) throw instead of constructing through the subclass"
status: done
completed: 2026-10-19
assignee: ttraenkler/opus-7089-subclass
created: 2026-10-19
updated: 2026-10-19
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler, runtime
language_feature: Promise
goal: architecture
sprint: current
parent: 5385
related: [6708, 6979, 2637, 7090]
import-cycles-allow:
  - largestSccSize: 718 # 2026-10-19 (#7089): codegen/promise/receiver-capability.ts joins the codegen SCC (called from call-namespace-static.ts via the #7090 routing call; uses shared.js compileExpression and the D3/D4 promise-class-receiver providers, like with-resolvers.ts did for 717); its runtime body stays in runtime/wasmgc/promise/with-resolvers-bodies.ts, outside the SCC
---

# #7089 — Promise combinators on a subclass under the native regime

Found during the #6708 flip (2026-10-16): under the native-first default in
a JavaScript environment, and on standalone, these calls throw a Wasm
exception instead of building the result promise through the subclass
constructor:

- `Promise.all`, `Promise.race`, `Promise.any`, `Promise.allSettled`,
  `Promise.try` with `.call(SubPromise, …)`;
- `Promise.withResolvers.call(SubPromise)`.

Under the retired `host-assisted` profile the same programs pass all four
checks of `tests/issue-2637-b2-ctor-closure-registration.test.ts` ("runs the
user body on the capability promise", asserts #1–#4). The flip's follow-up
(PR 6758) pinned that test file to the explicit `host-assisted` spelling, so
no CI row tracks the regime behaviour today. S7 (#6979) deletes that
spelling, at which point the test must either assert the regime or be
retired with this issue as its replacement.

## Plan

1. Reproduce with a `.tmp` probe compiled with `semanticProviders:
   "native-first"` (JS environment, through `wrapCompiledExports`) and with
   `target: "standalone"`: `class Sub extends Promise {}`;
   `Promise.all.call(Sub, [])` → result is a `Sub`, executor ran, resolution
   observable; the same for `race`/`any`/`allSettled`/`try`/`withResolvers`.
   Record which step traps (NewPromiseCapability on a non-%Promise%
   constructor, the executor callback bridge, or the species read).
2. Implement NewPromiseCapability(C) on the native path (`src/codegen/
   async-scheduler.ts` / the native promise provider): call `C` with a fresh
   executor, capture `resolve`/`reject`, validate callable, and route the
   combinator result through it; `withResolvers` returns `{ promise, resolve,
   reject }` from the same capability. Keep the fast path for `C ===
   %Promise%` byte-identical.
3. Tests: re-point `tests/issue-2637-b2-ctor-closure-registration.test.ts`
   at the default profile (and standalone) once green; add the
   `withResolvers.call` case; the test262 `built-ins/Promise/{all,race,any,
   allSettled,withResolvers}/` rows that exercise a subclass must not regress
   on standalone (quote before/after counts).
4. Acceptance: equivalence gate "No new equivalence regressions"; no new host
   import (the promise provider stays native); the direct-AST freeze
   (`plan/method/ir-only-development-freeze.md`) is respected — the fix is
   shared runtime/provider code, not new AST body lowering.

## Measurements (2026-10-19)

Probe: `class Sub extends Promise { constructor(a) { super(a); … } }` and the
test262 `ctx-ctor` bit mask (1 = `instance.constructor === Sub`, 2 =
`instanceof Sub`, 4 = constructor ran once, 8 = executor is a function; 15 =
all four). Native-first = `semanticProviders: "native-first"` through
`wrapCompiledExports`; standalone = `--target standalone`, zero imports.

| Call | native-first before | standalone before | after (both lanes) |
| --- | --- | --- | --- |
| `Promise.all.call(Sub, [])` | 15 | 15 | 15 |
| `Promise.race.call(Sub, [])` | 15 | 15 | 15 |
| `Promise.any.call(Sub, [])` | 15 | 15 | 15 |
| `Promise.allSettled.call(Sub, [])` | 15 | 15 | 15 |
| `Promise.try.call(Sub, fn)` | throws `TypeError: Promise.try is not yet implemented in --target standalone` | same (native error) | 15 |
| `Promise.withResolvers.call(Sub).promise` | throws `TypeError: Promise.withResolvers is not yet implemented …` | same | 15 |
| `(Promise.all as any).call(Sub, [])` (TS-cast spelling, ×4 combinators) | throws `Promise.all is not yet implemented …` | same | 15 |
| `Promise.try(fn, ...args)` (direct, `%Promise%`) | CE `'__get_builtin' … not yet supported in --target standalone (#1472 Phase B)` | same | resolves / rejects correctly |

**Which step trapped.** None of the three suspected steps (NewPromiseCapability
on a non-`%Promise%` constructor, the executor bridge, the species read). The
plain `Promise.<combinator>.call(Sub, …)` spelling was already served natively
by the #6651 D3/D4 class-receiver providers, which construct the compiled
subclass through the native construct driver. Every failing form fell past
those syntactic arms to the **first-class builtin value closure** of
`builtin-value-read.ts`, whose generic body is the #2984 "not yet implemented"
TypeError and whose ABI carries no `this`:

- `Promise.try` and `Promise.withResolvers.call` had no arm at all;
- the TS-cast spelling `(Promise.all as any).call(…)` — the one
  `tests/issue-2637-b2-ctor-closure-registration.test.ts` uses — is not a
  `PropertyAccessExpression` under `.call`, so the D3/D4 arms never saw it;
- direct `Promise.try(fn)` had no native lowering, so it reached `__get_builtin`.

test262 standalone lane, `TEST262_PATH_FILTER` = the six directories
`built-ins/Promise/{all,race,any,allSettled,withResolvers,try}/` (the runner
splits the filter on `|` into substrings, so the regex spelling in the task
brief matched unrelated paths; the directories were listed one by one),
`TEST262_WORKERS=2`, `JS2WASM_EVAL_ENGINE=interpreter`:

| Directory | before (pass / total, compile timeouts) | after |
| --- | --- | --- |
| `all/` | 95 / 98 (3 timeouts) | 98 / 98 |
| `race/` | 92 / 94 (2) | 94 / 94 |
| `any/` | 48 / 94 (9) | 51 / 94 |
| `allSettled/` | 52 / 104 (11) | 61 / 104 |
| `try/` | 5 / 12 (1) | 11 / 12 |
| `withResolvers/` | 4 / 6 | 5 / 6 |
| **total** | **296 / 408** | **320 / 408** |

The base run had 26 rows hit the 10 s compile timeout because the box was
loaded. The rerun had none, so most of the +24 headline is timeout noise. The
**deterministic** delta (rows that are not a timeout on either side) is **+6, 0
regressions**: `try/ctx-ctor`, `try/ctx-ctor-throws`, `try/args`,
`try/return-value`, `try/throws` and `withResolvers/ctx-ctor`. `try/ctx-non-ctor`
(a timeout before; now passes through the IsConstructor arm) is a seventh gain.
Rows that showed up in only one run were re-run on both sides with an exact
filter:
- the six `*/ctx-non-ctor.js` rows failed once with "Import
  js2wasm:runtime-eval: module is not an object" because a mid-run merge changed
  the runtime-eval provider key; they pass on re-run;
- `any/invoke-{resolve,then,then-get}-error-close` (worker SIGABRT),
  `any/iter-arg-is-poisoned` and `allSettled/resolve-element-function-prototype`
  (#2961 host-import CE) give the identical verdict on base and after.
`try/promise.js` (CE → fail) and `withResolvers/promise.js` still fail on the
`.constructor` gap below.

## Implementation notes

- **Owner.** The receiver-reading statics are `%Promise%` intrinsics, so they
  live in the native promise provider:
  `src/codegen/promise/receiver-capability.ts` (new) plus one more runtime body
  in `src/runtime/wasmgc/promise/with-resolvers-bodies.ts`. The direct-AST
  change is routing only: the #7090 call in `compileNamespaceStaticCall` now
  calls `tryEmitNativePromiseReceiverCall` (which tries the #7090 direct form
  first), and `try` joins the statically-proven IsConstructor TypeError set in
  `promise-static-call-typeerror.ts` (so `Promise.try.call(eval)` does not
  compile `eval`).
- **One capability record, two constructors.** NewPromiseCapability(C) always
  fills the existing `$__promise_custom_capability` record (resolve, reject)
  that the D1–D4 executor writes:
  - `C = %Promise%` (direct `Promise.try`, `.call(Promise, …)`):
    `__promise_intrinsic_capability(record) -> externref`, the same pending
    `$Promise` + shared resolving-pair latch + `$__promise_settle_cap` closures
    that `__promise_with_resolvers` builds, stored into the record. No executor
    runs, exactly as for `new Promise(executor)`.
  - `C` a compiled class (including `class X extends Promise`) or an ordinary
    function: Construct(C, «executor») through the native construct driver,
    then IsCallable on both slots (§27.2.1.5 steps 8-9) — the same sequence as
    D4's `emitClassReceiverSettle`, so the subclass constructor body runs once
    and the result is a real `Sub` instance.
  - Any other receiver declines and keeps its previous lowering.
- **`Promise.try`.** Arguments (C, callbackfn, rest) are evaluated first, then
  NewPromiseCapability(C), then `Call(callbackfn, undefined, args)` through
  `__apply_closure` inside a tag `try`. Only the callback call is inside the
  `try`: the following `Call(resolve | reject, undefined, «value»)` is outside
  it, so a throwing settle function propagates as the spec's `?` requires, and
  a throwing constructor (`ctx-ctor-throws.js`) propagates before the callback
  runs.
- **`withResolvers.call(C)`.** `C = %Promise%` calls the #7090 function
  unchanged; a custom `C` builds the same ordinary `{ promise, resolve, reject }`
  object from the custom capability.
- **TS-cast `.call` spellings** of the combinators and `resolve`/`reject` route
  to the existing D3/D4 providers. The plain spelling keeps its dedicated arms,
  so those modules do not change.
- **Fast path is byte-identical.** `with-resolvers-bodies.ts` was refactored
  into shared `pendingPromiseInstrs` / `settleValueInstrs` helpers that emit the
  identical instruction sequence. A/B: 1,720 sources (the 13 playground
  examples, 1,701 module sources extracted from `tests/equivalence/*.ts`, and 6
  Promise programs covering direct `withResolvers`, `all`/`any` and the plain
  `.call(Sub)` combinator and `resolve` arms), each compiled on the default,
  native-first and standalone lanes: 5,160 / 5,160 binaries identical (SHA-256;
  175 compile errors identical on both sides). This A/B was measured before
  `try` joined the IsConstructor set. That change can only reach a
  `Promise.try.call(<non-constructor>)` site, and the corpus has no `.try` at
  all (grep).

## Left out (and why)

- **First-class values (`const f = Promise.withResolvers; f.call(Sub)`).**
  This still throws the generic TypeError. `f()` already throws a TypeError, as
  the spec requires (`this` is undefined, so IsConstructor fails). Making
  `f.call(Sub)` work needs a `this`-aware value-closure body. That body would
  read `__current_this`, but only some call sites install it: a plain `f()` does
  not reset it, so it could read a stale outer receiver. That is call-site work
  in the frozen direct-AST emitters, not provider work, so it needs its own
  issue.
- **`await` on a subclass promise does not species-construct.** Node runs the
  subclass constructor a second time on `await subPromise` (through
  `then`'s SpeciesConstructor); the native regime does not. That is pre-existing
  and outside these statics; the focused test counts constructions before the
  `await`.
- **`try/promise.js`, `withResolvers/promise.js`** still fail on the separate
  `$Promise` `.constructor` read gap that #7090 recorded.
- **Pre-existing, seen while testing:** `r += await p.then(f, g)` on a
  rejected `p` answers 0 on both native lanes (the plain
  `const v = await …` form is correct); not Promise-statics specific.

## Test

- `tests/issue-7089-regime-promise-subclass-combinators.test.ts`: 33 cases.
  Each of 16 programs runs on native-first (JS environment) and on standalone
  (zero imports), and each result is compared with Node, which uses the
  repository's `Promise.try` polyfill where Node lacks it. The programs cover
  the four combinators, `try` and `withResolvers` on a subclass (the four-bit
  ctx-ctor mask), both TS-cast spellings, `withResolvers` on a
  default-constructor subclass, reject through the subclass capability, direct
  `Promise.try` with arguments and with a throw, `try.call(Sub)` resolution,
  `try.call(Promise)`, and the non-callable-resolver TypeError for both
  methods.
- `tests/issue-2637-b2-ctor-closure-registration.test.ts` now targets the
  default profile and standalone instead of the retired `host-assisted`
  spelling, and adds a `withResolvers` row (16 cases).
- Equivalence gate (local, `--configLoader runner`): "20 failing, 2020
  passing, 22 known-failures in baseline … ✓ No new equivalence regressions"
  (2 baseline failures now pass; `delete-sentinel` and `reflect-api`, not
  touched by this change).
- `check:host-import-policy` OK (`legacySemanticImports: 0`); standalone
  modules in both test files assert zero imports.
