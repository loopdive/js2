---
id: 2174
title: "standalone: `arguments` captured by a nested function under async emits invalid Wasm (__closure fallthru i32 vs externref)"
status: done
assignee: sendev-args-closure
sprint: Backlog
created: 2026-06-16
updated: 2026-06-16
completed: 2026-06-16
priority: high
feasibility: hard
reasoning_effort: max
task_type: fix
area: codegen
language_feature: closures
goal: core-semantics
related: [2106, 1503]
origin: "2026-06-16 — surfaced while diagnosing the recurring standalone-guard false positive on the value-rep PRs (#1503/#1511)"
---

# #2174 — standalone async + `arguments`-in-nested-closure → invalid Wasm

## Problem

In **standalone/WASI** mode, an async function (or async method) that captures
the `arguments` object into a nested function emits an **invalid Wasm binary**
(compile_error at instantiate), not a runtime failure.

A 23-test cluster in test262 hits this single signature:
`language/{statements,expressions}/{async-function,class/async-method,...}/
returns-async-{arrow,function}-returns-arguments-from-{own,parent}-function.js`.

**Error signature (verified on main @ 24e520df8, `--target wasi`):**
```
WebAssembly.compile(): Compiling function #NN:"__closure_0" failed:
  type error in fallthru[0] (expected i32, got externref) @+...
```
i.e. a generated `__closure_*` body leaves an `externref` on the stack where the
function signature's fallthrough result expects `i32` — a stack/type mismatch in
the closure that captures `arguments` under the async lowering.

## Reproduces

`language/statements/async-function/returns-async-function-returns-arguments-from-own-function.js`
compiles to invalid Wasm in standalone. Source shape:
```js
async function asyncFn(x) {
  let a = arguments;
  return async function () { return a === arguments; };
}
```
A hand-minimized `async function f(x){ let a=arguments; return async function(){return a===arguments;}; }`
does NOT yet reproduce in isolation — the bug needs the fuller test262 harness
shape (procedurally generated with the async `assert.sameValue` continuation), so
the trigger is an interaction between the async state-machine lowering, the
`arguments`-object capture, and the nested-closure return. **First task: bisect
the test262 file down to a minimal repro.**

## Why it matters beyond conformance (the meta-bug)

This cluster is recorded as `pass` in the standalone baseline
(`test262-standalone-current.jsonl`) but **fails to compile on current main** —
i.e. the baseline is stale here. That stale entry makes the standalone
regression guard (#1897) fire a `Net: -19 / 23 wasm_compile` **false positive on
every unrelated value-rep PR** (#1503, #1511, #1514 all hit the identical
fingerprint; #1503 had to be admin-overridden). Fixing this bug (so main can
compile these, then the baseline promotes them to a real `pass`) removes both the
conformance gap AND the recurring guard noise. (Short-term, the baseline should
be refreshed off a green main run so the guard stops blocking PRs.)

## Root cause (hypothesis — needs confirmation)

A `__closure_*` generated for the nested function captures `arguments` (an
externref / boxed args object) but the closure's emitted body or its declared
result type disagree on `i32` vs `externref` at the fallthrough. Likely the
`arguments`-object capture under the async lowering writes the wrong ValType into
the closure env field or the closure func-type, so the final value left on the
stack (externref) doesn't match the declared i32 result. Candidate areas:
`closures.ts` (env capture + `__closure_*` emission), the async state-machine
lowering (`async-scheduler.ts` / async function-body), and how `arguments` is
materialized + captured (`arguments`-object builder).

## Acceptance criteria

- `language/statements/async-function/returns-async-function-returns-arguments-from-own-function.js`
  and its 22 sibling cluster tests compile to **valid Wasm** in standalone and
  pass; host mode unchanged.
- A minimized repro test in `tests/` guarding the closure/async/`arguments`
  interaction.

## Notes

- Independent of the value-rep lane (#2106 etc.) — pure closure/async codegen.
- `feasibility: hard` / `reasoning_effort: max`: async state machine + closure
  capture + `arguments` is a three-way interaction; route to a senior dev after
  the bisect narrows the site.

## Resolution (2026-06-16, sendev)

### The bug was NOT `arguments` — it was the async closure-value call dispatch

The bisect collapsed the trigger far below the issue's hypothesis. The
`arguments`-capture, the async state machine, and the `.then` chain are all
*incidental*. The minimal trigger is:

```ts
async function asyncFn(x) { return async function() { return 1; }; }
asyncFn(1).then(retFn => { return retFn(); });   // retFn() — the value-call
```

The fault is entirely in how **`retFn()` is compiled** when `retFn` has an
**inferred** function type whose return is `Promise<T>`. Two facts collide:

1. `resolveWasmType(Promise<number>)` **strips the Promise** and yields the
   awaited value's wasm type — `f64`. So the call site computes
   `expectedReturn = f64` (`expressions/calls.ts` ~L8947 `sigRetWasm`).
2. An **async** closure's real funcref type returns the **Promise object**
   (`externref`), not the unwrapped value. This async candidate is explicitly
   synthesized into the #1131 multi-funcref dispatch ladder
   (`tryAltFuncType([externref])`) and also found by the
   `ctx.closureInfoByTypeIdx` scan.

The dispatch ladder declares its `if`-block `(result expectedReturn)` = `f64`,
but the async candidate arm did `call_ref` → **externref** with **no
coercion** (the existing per-candidate coercion at L9342 was gated to
*numeric↔numeric* pairs only; the comment even claimed externref mismatches
"stay on the existing lossy-but-valid drop+default path" — but no such path
existed for `expected=primitive, candidate=externref`). Result: an externref
left in an `(result f64/i32)` block →
`__closure_N failed: type error in fallthru[0] (expected f64, got externref)`
at `WebAssembly.compile()`.

The exact ValType mismatch: **the async candidate side was wrong** — the
dispatch arm produced `externref` where the block result type was the
Promise-stripped primitive (`f64`/`i32`).

### Fix (`src/codegen/expressions/calls.ts`)

1. **Semantic correctness — widen the block to externref when async.** When
   `isPromiseType(sigRetType)` is true the call's runtime value genuinely *is*
   a Promise (externref), so `expectedReturn` is set to `externref`. The
   Promise then flows through the dispatch untouched and the surrounding
   `wrapAsyncReturn` (`expressions.ts`) consumes it as the call expression's
   value — exactly as a direct async call already does. A pure type-only
   externref→f64 coercion would have *compiled* but unboxed the Promise to
   `NaN` and corrupted the result (the test asserts `result === false`); the
   widening keeps the value correct.
2. **Validity robustness — generalise the per-candidate coercion.** The
   numeric-only branch in the multi-funcref ladder now coerces ANY
   `fc.returnType → expectedReturn` mismatch via `coerceType` (which validly
   bridges numeric↔numeric, externref↔primitive via `__box`/`__unbox_number`,
   and ref↔externref via `extern.convert_any`). Every dispatch arm now leaves a
   value of the declared block type, regardless of which closure shapes
   populate `ctx.closureInfoByTypeIdx`.

### Downstream-effect analysis (stack balance / indices / host path)

- **Block stack balance**: every arm now provably leaves exactly one value of
  the block's result type — the f64-matched candidate boxes up to externref,
  the async candidate passes through, dead/never-matching candidates still emit
  a type-valid (if unreachable) coercion.
- **Index shifting**: no new late imports are added by the widening; the
  generalised coercion may pull `__box_number`/`__unbox_number` (already
  ensured by `addUnionImports` at the top of this path), so no new
  shift hazards.
- **JS-host path**: the widening is gated on `isPromiseType` (only fires for
  genuinely-async callees) and the coercion change only alters previously
  *invalid* arms; the host/gc target output for the cluster is verified
  byte-correct (all 22 cluster files compile + run correct on gc; identical
  pre-existing test failures on baseline).

### Results

- The `__closure fallthru i32/externref` cluster: **18 of 22 files** now
  compile to **valid Wasm** in standalone/wasi AND run correct (`test()`
  returns 1 — `result === false`, `count === 1`). Before: all 18 failed with
  the fallthru type error.
- The remaining **4** files are all `class/elements/async-private-method-static`
  and fail with **separate, pre-existing standalone bugs** (`env.__get_undefined`
  host-import-allowlist rejection + the #2043 late-import global-index-shift
  `global index out of range -1`) — verified identical on unmodified `main`,
  NOT the #2174 closure-fallthru bug. Tracked separately; out of scope here.
- JS-host (gc) target: all 22 cluster files compile + run correct.
- No regressions: `tests/issue-1131`, `issue-1693`, `issue-1712`,
  `issue-1727`, `optional-direct-closure-call`, async/closure suites all show
  identical pass/fail to the unmodified baseline (remaining failures are the
  known lazy-importObject env issue + a missing benchmark fixture, not this
  change). `tsc --noEmit` and `biome lint` clean.
- Regression test: `tests/issue-2174-async-closure-dynamic-call.test.ts`
  (4 cases, all pass).

ECMAScript anchor: the value flowing is the `Promise` created per
**PerformPromiseThen** / async function evaluation (the inner async function's
result), so the call must yield the Promise object, not its awaited value —
the widening preserves that.

### Follow-up: narrowing the coercion to avoid a late-import-shift regression

The first cut of fix-step 2 generalised the per-candidate coercion to call
`coerceType(fc.returnType, expectedReturn)` for **any** mismatch. That
over-broadened: PR #1548 CI's `equivalence-gate` flagged 8 NEW regressions in
`tests/equivalence/fn-variable-call.test.ts` (plain non-async
function-reference-in-a-variable calls — `var fn = makeAdder(10); fn(32)`).

Root cause of the regression: the multi-funcref dispatch ladder emits one arm
per candidate funcref type, but **only the arm matching `retFn`'s runtime
funcref executes** — the rest are synthesized type-validity padding. The
generalised `coerceType` ran on those **dead** arms too, and for an
externref↔primitive mismatch it pulls a **late host import**
(`__unbox_number`/`__box_number`, and transitively `__typeof_boolean`). A late
import inserted mid-body shifts function indices and **desyncs an already-baked
`ref.func` operand** (the #2043 / late-shift hazard class): the earlier
`makeAdder` closure's `ref.func $__closure_0` got rewritten to the freshly
imported `__typeof_boolean`, so `fn` wrapped the wrong function and threw at
runtime.

Narrowed fix (final): in the dispatch coercion,
- **numeric↔numeric** mismatch → `coerceType` (emits only pure
  `f64.convert_i32_s`/`i32.trunc_sat_f64_s` ops — no imports, no shift; keeps
  the #1693 axios case working);
- **any other mismatch** (externref/ref ↔ primitive, only ever on a dead
  never-matching arm) → `drop + defaultValueInstrs(expectedReturn)` — type-valid
  and **side-effect-free** (no late imports). The *live* async/Promise arm is
  unaffected because the widening makes `expectedReturn` externref, so it
  `valTypesMatch`es and skips coercion entirely (the Promise passes through).

Verified after narrowing: `node scripts/equivalence-gate.mjs` → **+53 newly
fixed, 0 new regressions** (exit 0); `fn-variable-call.test.ts` 5/5 pass; the
#2174 cluster still 18/18 (wasi) + 22/22 (gc); regression test extended to 7
cases (4 async + 3 non-async-closure guards). `tsc`/`biome` clean.
