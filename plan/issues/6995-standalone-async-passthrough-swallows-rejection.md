---
id: 6995
title: "standalone async: the legacy synchronous pass-through lane silently miscompiles every shape the drive engine declines — a rejected `await` inside nested try/catch/finally is swallowed (function fulfils), `await <thenable>` returns the thenable, `await <struct object>` traps `illegal cast`; the #3587 loud refusal returns early for standalone/wasi"
status: done
completed: 2026-10-15
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: async-await, try-finally, promises
goal: standalone-gap
related: [3587, 2895, 2865, 6428, 6996]
# 2026-10-15 (#6995): growth is the honest-unwrap/refusal fix itself, kept in
# the modules that own each half — async-frame.ts (the settled-operand
# predicate shares its private checker helpers; thenable-adoption wiring at the
# native await), lower-generic.ts (the IR await arm's lockstep mirror, extracted
# to a module-level helper so the two giant functions grow by one call line),
# expressions.ts (the call-site drive predicate + throwOnRejected flag).
loc-budget-allow:
  - src/codegen/async-frame.ts
  - src/ir/lower-generic.ts
  - src/codegen/expressions.ts
func-budget-allow:
  - src/codegen/async-frame.ts::ensureAsyncResumeFunction
  - src/codegen/async-frame.ts::buildStateBody
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
---

# Standalone async: declined shapes fall to a lane that cannot see rejection

Found by the 2026-10-15 audit (control-flow lane). Standalone only; the gc lane REFUSES to compile the same shape (#3587 loud refusal), standalone miscompiles silently.

## Repro (node → wasm, `target: "standalone"`)

```js
async function a(){ let s=""; try { try { await Promise.reject(1); } catch(e){ s+="c"; throw e; } finally { s+="f"; } } catch(e2){ s+="o"+e2; } return s; }
a().then(v => console.log(v));     // node "cfo1", wasm "f" — and the promise FULFILS
```
Same with no rethrow (`"cf"` vs `"f"`), with an outer try/finally (`"cfF"` vs `"fF"`), with the inner try wrapped in a `{}` block, or preceded by `await null`. Non-nested try/catch/finally around the await is fine (admitted by the drive engine).

```js
async function a(){ return await { then(res){ res(42); } }; }   // node 42, wasm "[object Object]"
async function a(){ const o={k:1}; const r = await o; return r.k; } a().then(log)   // node 1, wasm RuntimeError: illegal cast (after the following statement ran)
```

## Root cause

- `src/codegen/async-activation.ts:86-92` — on the native-`$Promise` carrier lane the only admission is `asyncFnNeedsDrive` (`src/codegen/async-frame.ts:968-1046`); a try/catch/finally nested inside another `try` has no linear/loop/try-catch plan (`planLinearAwaits` → null, `computeTryCatchSpills` → null) ⇒ decline ⇒ legacy synchronous pass-through.
- `src/codegen/async-activation.ts:225` — `reportDeclinedAsyncRejectionHazard` returns early `if (ctx.wasi === true || ctx.standalone === true)`, so the decline is silent on exactly the lanes that miscompile.
- `src/codegen/async-value-sink-unwrap.ts:38-66` `emitStandaloneAwaitUnwrap` (called from `src/codegen/expressions.ts:1611-1618`) does `ref.test $Promise` → `struct.get $Promise.value` WITHOUT checking `.state`; a rejected `$Promise`'s reason is treated as the fulfilled value. `elseBody` passes a non-`$Promise` externref through untouched (no `then` lookup), and a non-externref operand returns its own static type, which the completion path later `ref.cast`s.
- It also sets `$Promise` field 4 (handled) on every legacy await, so the swallowed rejection never surfaces as unhandled either.

## Implementation Plan

Two layers, both in this PR; the first is the safety net, the second the fix for the common shapes.

1. **Never silent.** Make `reportDeclinedAsyncRejectionHazard` apply to standalone/wasi: when the drive engine declines a body that has a real suspension inside a `try` (same condition the host lane uses), emit the same loud compile error (or a typed refusal) instead of falling to the pass-through. Keep the `ASYNC_CPS_ENABLED` and `realSuspension` conditions. Measure the blast radius first: compile `tests/equivalence/*async*` and a test262 stride of `built-ins/Promise` + `language/statements/async-function` with the refusal on and record how many files flip from pass to compile-error in this issue file. If it is large, keep the refusal but ALSO land step 2 so the common shapes keep compiling.
2. **Make the unwrap honest.** In `emitStandaloneAwaitUnwrap`: read `$Promise.state` (field index per `getOrRegisterPromiseType`); fulfilled → value; rejected → mark handled and `throw` the reason through the standard exception tag (`ensureExnTag` / the same path `throw` statements use in standalone, see `statements/exceptions.ts`); pending → this lane cannot suspend: refuse at compile time (step 1 covers it; at runtime `unreachable` is acceptable only if the compile-time gate guarantees it is dead). Keep `src/ir/lower-generic.ts`'s `await` arm in lockstep (the file says so at `ir/backend/lower-contracts.ts` L272) — update both or the IR path drifts.
3. Thenable: in the `else` arm, if the operand is a non-null externref that is an object with a callable `then`, route through the existing `__promise_thenable_job` / promise-resolve machinery used by `promise-combinators.ts`; if that helper is host-only, restrict this PR to refusing (`await` of a provably-non-promise object is a compile-time refusal on this lane) and note the gap here.
4. Struct operand: in `expressions.ts:1611-1618`, when the operand's static type is a `ref` to a struct (not externref), either box to externref before the unwrap (so the result type is uniformly externref) or refuse. Do not return `operandType` unchanged.
5. Tests: the four repros above plus the audit's variants (outer try/finally, block-wrapped inner try, `await null` before). Assert the swallowed case now either throws `"cfo1"`-equivalent output or fails to compile with the refusal — the test must pin whichever you ship, and the PR body must say which.

## Acceptance

- No standalone compile of a real-suspension-in-try shape produces a fulfilled promise for a rejected await. Either correct output or a compile-time refusal; never silent.
- `tests/equivalence/*async*` pass; standalone test262 `built-ins/Promise` + `async-function` stride does not regress beyond the files you listed as newly-refused (list them).
- gc lane byte-identical.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-6995-standalone-async-passthrough-swallows-rejection.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.

## Implementation notes (2026-10-15)

Shipped: honest unwrap + a NARROWED refusal + the two adjacent repro fixes.
All five nested-try repros now print node's output on standalone and wasi
(`"cfo1"`, `"cf"`, `"cfF"`, …); the thenable repro prints `42`; the struct
repro prints `1`.

### What changed

1. **Honest unwrap** (`emitStandaloneAwaitUnwrap(ctx, fctx, throwOnRejected)`,
   `src/codegen/async-value-sink-unwrap.ts`; the `await` site in
   `expressions.ts` passes `true`). A `$Promise` in state REJECTED throws its
   reason through `ensureExnTag` (the same `throw $exn` a `throw` statement
   emits), after marking it handled. The #6428 value sink keeps the old
   behaviour (`false`). `src/ir/lower-generic.ts`'s `await` arm emits the same
   state test + throw (lockstep; the resolver's `ensureExnTag`).
   `tests/issue-4376-ir-await-rejection-events.test.ts` pinned the old
   "rejected → return the reason" contract; it now asserts the throw (payload
   read back through an exported tag).
2. **Never silent — scoped refusal.** `reportDeclinedAsyncRejectionHazard` no
   longer returns early for standalone/wasi. On those lanes it covers:
   - only the drive engine's claimable entry points — top-level, non-generator
     `async function` declarations. Arrows / function expressions / nested
     declarations are parked on the native lane (`planAsyncClosureActivation`)
     and methods are #2957 residue, so the engine never claims them at any
     shape; refusing them would refuse a population, not a residue (the same
     reasoning #3587 used for methods). They get the honest unwrap instead.
   - only awaits whose operand may still be PENDING
     (`awaitOperandProvablySettled`, `async-frame.ts`): statically-resolved
     operands, provably non-thenable operands, a once-written settled local,
     `Promise.reject(...)` and `Promise.resolve(<non-thenable>)` are delivered
     exactly by the honest unwrap (value, or a thrown rejection), so they are
     not a hazard. The host lane keeps every await (unchanged).

   Why narrowed: the plain "drop the early return" (step 1 as written) refused
   20 test262 files in the try+await population, 18 of them async arrows /
   function expressions / harness `asyncTest(async function …)` bodies, and it
   refused `tests/issue-2906-3c-trycatch.test.ts` "leads before the
   return-await run once" — a top-level wasi declaration whose in-try awaits
   are `Promise.resolve(<number>)` and which the honest unwrap runs correctly.
3. **Thenable adoption on the drive lane.** The thenable repro is driven (not
   the pass-through the plan assumed); `buildNativeAwaitClassification`
   delivered any non-`$Promise` operand as a plain value. It now takes an
   optional `thenableAdoption` (`src/runtime/wasmgc/async/native-await.ts`):
   a non-`$Promise` operand goes through PromiseResolve — a fresh pending
   `$Promise` (minted handled) resolved with the operand by
   `__promise_resolve_value`, which performs the ONE observable `Get(then)`
   and carries the fetched function into the #3125 PromiseResolveThenableJob.
   The fresh promise is then classified like any awaited `$Promise`:
   fulfilled (non-thenable) delivers, rejected (throwing getter) throws into
   the frame, pending (callable `then`) suspends. Wired from `async-frame.ts`
   (`nativeThenableAdoption`); the prepared IR engine caller is unchanged.
   (Review on PR #6700: the first cut probed `__promise_has_callable_then`
   and then resolved, i.e. two `Get(then)` — a getter saw 2 reads and the
   second-fetched function ran. Controls pinned in the #6995 test: read count
   `1 1`, first-fetched function used, throwing getter rejects with the thrown
   value, plain value / non-callable `then` delivered as-is. Re-measured: the
   two test262 populations and the 69 related files are unchanged by it.)
4. **Struct operand (`illegal cast`).** Root cause was not the await operand
   (plan step 4) but the call site: `calleeIsDriveLowered` (expressions.ts)
   keyed on `asyncFnNeedsCps`, which admits `await <non-thenable struct>`
   while the activation gate `asyncFnNeedsDrive` declines it — so the caller
   skipped the Promise wrap around a raw `T` and `ref.cast`-trapped. It now
   requires both predicates. The await operand itself is left as is (a
   non-externref operand cannot be a `$Promise`; passing it through is the
   right value).

### Measurements (all `--standalone`, `scripts/run-test262-paths.mts`, base = `origin/main` 3032e7c2, same tree with the six src files swapped)

| population | base pass / fail / CE | this PR |
|---|---|---|
| stride: every 3rd `built-ins/Promise` + all `language/statements/async-function` (317 files) | 237 / 65 / 15 | 238 / 63 / 16 |
| every test262 file containing both `try {` and `await` (91 files) | 45 / 18 / 25 | 51 / 11 / 26 |

Per-file, try+await population (stride rows are a subset):

- **pass → compile_error (newly refused, 1):**
  `language/statements/async-function/try-reject-finally-reject.js` — the
  operand is `new Promise(function (resolve, reject) { reject(...) })`, which
  the settled-operand rule does not prove. It passed vacuously before (the
  swallowed rejection fulfilled `f()`, and the test's onFulfilled is `$DONE`).
- **pass → fail (1):** `harness/asyncHelpers-throwsAsync-custom-typeerror.js` —
  also a vacuous pass: its first `await p` (outside any `try`) awaits a
  promise the wasm `assert.throwsAsync` rejects (a shadowed `function
  TypeError(){}` collision), and the swallowed rejection hid that. The honest
  unwrap surfaces the pre-existing throwsAsync bug.
- **fail → pass (8):** `try-return-finally-reject.js` and
  `try-throw-finally-reject.js` in each of `expressions/async-arrow-function`,
  `expressions/async-function` and `statements/async-function` (6), plus
  `await-awaits-thenables-that-throw.js` in `expressions/await` and
  `module-code/top-level-await` (2).

Related unit/equivalence files (69 files: `tests/*async*`,
`tests/equivalence/*async*|*await*`, `issue-2865*`, `2867*`, `1326*`, `3469*`,
`6428*`, `6780*`, `3587*`, `2906*`, `3220*`, `1373*`), single run each on the
merged tree: base 698 pass / 63 fail → 718 / 43. The only flip outside the new
file was `issue-4574-standalone-native-async-family` "keeps the grounded loop,
Promise.all …": its `/promise.*all/i` call-count regex also matched the new
thenable probe `__promise_has_callable_then`; tightened to `/promise_all/i`.
The 43 remaining failures are the identical pre-existing set.

gc lane: byte-identical. Every `await`-bearing source in
`tests/equivalence/{async-function,async-iteration,await-settled-operand-yields,for-await-of}.test.ts`,
`tests/issue-6780-await-static-suspends.test.ts` and
`tests/issue-3587-async-rejection-delivery.test.ts` compiled on the default
lane hashes identically before and after (32 compiled sources, 75,448 bytes,
sha256 prefix `d6deba1317f84df8`; the 49 fragments that do not compile alone
fail with identical messages). Every changed path is gated on
`isStandalonePromiseActive` / `ctx.wasi || ctx.standalone`.

### Left out / residue

- **Parked arrows / function expressions / nested declarations / methods with
  a PENDING operand inside a `try`** still continue past the await with the
  pending promise's `undefined` value (the AG0 synchronous model). They are
  not refused for the population reason above; fixing them needs the native
  closure park lifted (#2957 / #6780 step 4).
- **`await <thenable>` on the pass-through** (an arrow, not a driven
  declaration) still yields the thenable object: that lane cannot suspend for
  the thenable job.
- **Adjacent, pre-existing (not touched):** on standalone, `.then(f, g)` with
  BOTH handlers over a promise resolved from a thenable reads `null` in `f` —
  `Promise.resolve({ then(r) { r(42); } }).then((v) => log(v), (e) => log(e))`
  logs `null` (one handler logs `42`). Same with `new Promise((r) => r(thenable))`.
  The new test pins the single-handler form.
- `harness/asyncHelpers-throwsAsync-custom-typeerror.js` (above): a
  pre-existing throwsAsync constructor-name collision bug, now visible.
