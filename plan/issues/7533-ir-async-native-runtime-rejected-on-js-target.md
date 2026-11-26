---
id: 7533
title: "IR async on the JS target: the native async runtime is selected, then rejected by an environment guard (since #6672)"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: backend-agnostic-ir
related: [6708, 6672, 6979, 4102, 4106, 4110, 4241, 4574, 5385, 5197]
---

# #7533: native async runtime rejected on the JS environment

## Problem

On the default JS target, a module whose IR async owner gets the native runtime fails to compile:
`Codegen error: IR path failed for setTimeout: IR async function fetchUser selected a native standalone runtime on the
wrong target [IR-FALLBACK]`. The throw sits in the module-wide async census, so every unit of the IR batch reports
"IR path failed for <name>" and the compile returns `success: false` with no binary. There is no legacy fallback.

- Tests that hit the guard: `tests/issue-4106-ir-async-fetch-user` (1 row), `4110-ir-fetch-all-parallel` (7 rows) and
  `4241-carrier-bag-slot` (1 row). `4102-ir-promise-delay-closure-compile-once` has no async function and never
  reaches the guard: its 3 reds are test pins only (see Measurements).
- First bad commit, found by first-parent bisect (lane S25, 2026-11-26, not re-run here): `99e6e8908`, the merge of
  PR #6672 (#6708 S6-A, native-first default). On its parent `50a173471` all four files pass, except one unrelated
  WAT regex row in 4110.
- Lead decision (2026-11-26): fix it, do not retire it. The JS environment runs the same native core (#6708).

## Root cause (verified on `a9cdc8857a`)

- **Selection.** `src/ir/runtime/intrinsic-preparation.ts` `attachAsyncRuntime` (L963–1030) picks
  `kind: "standalone-native-wasmgc"` whenever every selected provider is `native-managed`. That holds on every WasmGC
  build since S6-A plus S7-c (`assertNativeRegime`, `src/codegen/context/create-context.ts` L586).
- **The IR layers already agree with the native pick:**
  - `projectIrBackendTargetProfile` (`src/ir/backend/legality.ts` L74–91, #5385) maps the JS environment plus the
    native regime to `target: "standalone"`;
  - `irProgramRuntimePolicy` (`src/ir/integration.ts` L1461–1482) gives the manifest `target: "standalone"` for every
    non-WASI build;
  - the attachment validator (`src/ir/runtime/async-attachment.ts` L175–185, inside
    `assertPreparedIrAsyncRuntimeCurrent`) accepts a native runtime only under that `standalone` policy.
- **The guard disagrees.** Only the codegen guard in `collectPreparedAsyncRuntimeRequests`
  (`src/codegen/ir-async-runtime-adapters.ts` L101–104) adds `ctx.targetProfile.environment !== "none"`. That is an
  embedder fact, not a semantic one. It came in with `e78df70331` (standalone async family moved to the native
  runtime), when only standalone could select native; S6-A made the JS environment select native too.
- **Selection admission reads a different fact.** `src/codegen/async-ir-planning.ts` admits a native async owner with
  `!ctx.wasi && ctx.nativeStrings`, written out 4 times: L1366–1368 (`usesPromiseAbi`), L1410–1413
  (`canPrepareSuspendingAsync`), L1439 (`preparedAsyncPromiseAllPlan`), L1470 (negated, `collectPreparedIrAsyncOwners`).
  The guard is the only reader of `environment`, so select claims an owner that codegen then rejects.
- **S7-c (`9b0daa543`) dropped `!ctx.standalone ||`** from `preparedIrAsyncSourceCanSuspendOnTarget` (L766) and
  rewrote the 4 copies above. That is intended (one core). It means the JS target now admits exactly the standalone
  family, so host-era claims are refused at select. Example: the native identity owner (`exactStandaloneFetchUser`,
  L649–678) requires `delay(30, id * 10)`, so 4106's `fetchUser` with `delay(0, …)` is legacy on both targets.

## Measurements (2026-11-26, origin/main a9cdc8857a)

**Tests.** `npx vitest run <file>`, pass/fail per file. "Guard-only" means changing the L102 condition to
`ctx.wasi || !ctx.nativeStrings` in a file copy (restored afterwards).

| File | main | guard-only | Red rows left after guard-only |
| --- | --- | --- | --- |
| `issue-4102-ir-promise-delay-closure-compile-once` | 1/4 | 1/4 | L58 ×2: (c) `delay__closure_*` names, and (b); L82: (a)+(b) |
| `issue-4106-ir-async-fetch-user` | 1/8 | 2/8 | L156 (c)+(a)+(b); L197 (a); L239 (c) + real bug; L264 (a); L293 (a); L335 (c) |
| `issue-4110-ir-fetch-all-parallel` | 12/19 | 13/19 | L155 (c); L208 (a)+(b); L236 (a)+(c); L284 (c); L327 (c); L382 "ordinary array": native gap |
| `issue-4241-carrier-bag-slot` | 15/16 | 16/16 | none |
| siblings: `4102-program-abi-closure-support` 11/12, `4241-instance-carrier-bag-slot` 11/11, `4104-ir-async-plan-runtime-consumer` 16/17 | same | same | pre-existing, unrelated (4104 red at L751) |

After the guard-only change, no "wrong target" message appears anywhere in the run (on main, 9 red rows fail with
it: 4106 ×1, 4110 ×7, 4241 ×1).
`tests/equivalence/issue-6995*` and `issue-6996*` pass 45/45 with it.

Red-row kinds:

- **(a)** The test reads raw `instance.exports`, so an async result is a native `$Promise` struct (`{}`). Measured
  through `setInstance` + `wrapCompiledExports`: 4106 `fetchUser` 70 (exact, tail and IR-off), `test` 100,
  `fetchFlag` true; 4110 `fetchAllParallel` 60, string-support variant 84, `fetchUser` ×3 `[10, 20, 30]`.
- **(b)** The test calls `setExports` only. The IR timer callback then runs through the generic fallback in
  `src/runtime/standalone-timer-callback-bridge.ts`, because `readAuthority` (L112) trusts only the branded
  `setInstance` path. The timer task throws an uncaught `TypeError: standalone timer callback dispatcher is not
  available` and the awaited promise never settles. This happens on main too, for every program whose `delay` is
  IR-claimed (4106 exact source); it is not caused by the guard.
- **(c)** The test pins the retired host projection: `ASYNC_HOST_ADAPTERS` imports, `delay__closure_*` names (the
  native `__ir_promise_delay_native` provider has no lifted closure), `Promise_all_import`, `__box_number_import`,
  `env.Promise_*` hooks, `__extern_is_undefined` as the late import, WAT continuations printed with inline
  `(param …) (result f64)` (native prints `(type N)`), and IR claims that the native admission refuses at select.
- **Real bugs found while re-pinning (not caused by this issue):**
  - `async function f(): Promise<void>` resolves to `null` instead of `undefined` on the JS target, with the IR on or
    off (4106 L239 value assertion).
  - 4110 "ordinary array" near miss: legacy codegen of `Promise.all(pending)` with `pending: number[]` needs the
    retired `env::Promise_all`. `--target standalone` fails the same way, so this is a native Promise.all admission
    gap for a non-Promise array argument, not #5385.

**Bytes.** sha256 of `result.binary` for the 13 `website/playground/examples/**/*.ts` files plus 5 test sources
(4106 exact/tail/void, 4110 exact, 4102 delay), on gc, standalone and wasi, main vs guard-only:

- 52 of 54 hashes are identical, including all 13 playground files on every target and every standalone and WASI
  hash.
- The 2 that differ are gc `4106-tail` and gc `4110-exact`. On main both failed with the wrong-target fallback and
  produced no binary.
- No playground file reaches the guard on main. `js/async.ts` on gc is refused at select (`main`:
  `host-surface-unavailable`; the other owners: `call-graph-closure`), while standalone IR-claims all six owners.
  `check:ir-fallbacks` reads only that corpus, so it cannot move.

## Implementation Plan

**Design.** Keep the selection; the guard is the bug. Choosing a host runtime on the JS target would bring back a host
semantic import, which the one-native-core rule (#6708) forbids. The `host-wasmgc` arm cannot be reached through the
compiler on WasmGC (the manifest policy is never `host`; `irProgramRuntimePolicy` returns `standalone`/`wasi`), but
`tests/issue-4104` still drives it directly, so it is not deleted here: retiring it is its own reviewed change.

**Reuse check.** No existing named fact expresses "native async admissible":

- `targetProfile.nativeRegime` is true on WASI too (S7-c), and WASI stays outside this async slice;
- `nativeRegimeInJs` covers gc only;
- `irProgramRuntimePolicy(ctx).target === "standalone"` drops the `nativeStrings` half, and the validator already
  checks it.

So one new predicate, placed next to the selection options it guards.

1. `src/codegen/async-ir-planning.ts`: add
   `export function preparedIrAsyncNativeTarget(ctx: CodegenContext): boolean { return !ctx.wasi && ctx.nativeStrings; }`
   beside `prepareIrAsyncSelectionOptions`. The name follows the file's `preparedIrAsync*` prefix. Replace the 4
   copies listed in Root cause; L1470 becomes `if (!preparedIrAsyncNativeTarget(ctx)) return owners;`. This is a pure
   rename, so the bytes do not change.
2. `src/codegen/ir-async-runtime-adapters.ts` L101–104: the native arm throws iff `!preparedIrAsyncNativeTarget(ctx)`,
   imported from `./async-ir-planning.js` (no import cycle: the planning module does not import the adapters). No
   `environment` read. The host arm is untouched.
   - Why keep a check that the validator implies today: it states the select/codegen contract (the claimed owner was
     admitted by exactly this predicate). It also catches a manifest prepared under one context and materialized under
     another.
   - If the review rules it dead code, deleting the native arm's context check is acceptable. Adding any other target
     read is not.
3. Tests, in the same PR. Instantiate the way an embedder does.
   - Add one helper, `instantiateJsFacing(result, deps?)`, to `tests/helpers/compile.ts`:
     `buildCompiledImports(result, deps)` → `WebAssembly.instantiate` → `setInstance` →
     `{ exports: jsFacingExports(result, instance), instance }`. It has 3 users and replaces 9 copies: the local
     `instantiate` in 4102, 5 inline copies in 4106 and 3 in 4110. `jsFacingExports` only wraps; it does not call
     `setInstance`.
   - Keep raw-export vector construction (`numberVec`) in 4110: `wrapCompiledExports` does not marshal a JS array into
     a `number[]` parameter, with the IR on or off.
   - Replace the local `extractFunctionBody` / `watFunctionIndex` with `watFunction` / `watFunctionNames` /
     `watCallTargets` from `tests/helpers/wat-functions.ts`.
   - Every removed host assertion gets a native counterpart that checks behaviour (the settled value), and the PR body
     lists each re-pin. Per file:
   - **4241** `carrier-bag-slot`: no edit (16/16 after step 2).
   - **4102** `promise-delay-closure-compile-once`:
     - L58: claims `delay`, has no `delay__closure_*`, WAT contains `__ir_promise_delay_native` (add `emitWat`); values
       through the helper;
     - L82: helper only.
   - **4106** `async-fetch-user`:
     - L156: assert that `fetchUser`'s gc route equals its standalone route (both legacy today); drop the
       `ASYNC_HOST_ADAPTERS` and `__box/__unbox` import pins; value 70.
     - L197, L264, L293: helper only.
     - L213: add value 70 (this row is IR-emitted natively).
     - L239: `linearVoid` route equals standalone (refused at select: numeric settled operand,
       `preparedIrAsyncLinearAwaitOperandCanLower`). The value assertion stays `toBeUndefined()`, which is red: the
       `Promise<void>` → `null` bug.
     - L335: use the tail source (IR-claimed natively) instead of `EXACT_SOURCE`.
   - **4110** `fetch-all-parallel`:
     - L155: `Promise_all_import` → `__ir_async_promise_all_native`; the scalar bridges are the defined
       `__box_number` / `__unbox_number`. Derive the continuation carrier from the `__vec_from_extern_<N>` name instead
       of the inline-signature regex. Re-pin `expectExactMaterializedContinuation` the same way.
     - L208: helper only (84).
     - L236: inject `setTimeout` through `buildCompiledImports` deps instead of patching `globalThis`; drop the
       `env.Promise_all` capture. Keep the event order and the values `[10, 20, 30]` / 60 (measured natively: 3 starts
       before any done, 60).
     - L284: `lateDirect` must still add a late import on the JS target. Use `Date.now()` (→ `env.__date_now`, as in
       4102 L82) instead of the `any === "A"` body, which imports nothing natively.
     - L327: replace the `Promise_new_pending` / `settle` / `Promise_all` hooks with a timer registration failure at
       ordinal 1, injected through deps (the #4574 L630 technique). Assert that the JS-facing promise rejects and that
       all three registrations started. Measured rejection reason: `null` (the native sentinel documented in #4574),
       not the thrown Error; pin it with a comment. The exactly-once settlement proof stays in #4574, which runs the
       same runtime.
     - L382 "ordinary array": no edit. It stays red under its own issue, not skipped and not marked todo.
4. Follow-ups, ids from the lead:
   - (i) `Promise<void>` resolves to `null` on the JS target (blocks 4106 L239);
   - (ii) native `Promise.all` over a non-Promise `number[]` (4110 L382; also red on standalone);
   - (iii) retire `host-wasmgc` and rename `standalone-native-wasmgc` to `native-wasmgc`. Fold the same-fact provider
     guards into the predicate in the same change: `ir-native-async-runtime.ts` L70, `ir-native-promise-delay.ts`
     L100, `ir-overlay-finalize.ts` L593. Folding them now would make two provider modules import a planning module;
   - (iv) an embedder that uses `setExports` with an IR timer callback gets an uncaught `TypeError` and a promise that
     never settles: fail at instantiation, or export the dispatcher;
   - (v) optional: gc refuses the playground `js/async.ts` family at select (`host-surface-unavailable`), while
     standalone claims it.

   Not copies of this fact, and left alone: `index.ts` L3127 and L5854, and `program-abi-fnctor-producer.ts` L190
   (these add `!ctx.fast`). `calendar-codegen-planning.ts` L52 and `native-promise-number-boundary.ts` L38 key on
   `environment === "none"` for the DOM/calendar capability and the number boundary.

## Acceptance criteria

- The four files pass, except 4110 L382 and the value assertion of 4106 L239, each linked to its follow-up issue. No
  "wrong target" text appears in the run output.
- `tests/issue-4104-ir-async-plan-runtime-consumer` is unchanged at 16/17 (its L751 red is pre-existing), and the
  host-arm "host runtime on the wrong target" rows still pass.
- **Bytes.** Re-run the Measurements byte probe on the final diff, using the file-copy A/B pattern: 52 of 54 hashes
  identical, and the only differences are gc `4106-tail` and gc `4110-exact` (no binary on main). All standalone and
  WASI hashes are identical. `pnpm run check:ir-fallbacks` does not grow.
- `node scripts/equivalence-gate.mjs` passes, and so do `tests/equivalence/issue-6995*` / `issue-6996*`.
- **Code quality:**
  - one predicate, with zero inline `!ctx.wasi && ctx.nativeStrings` / `ctx.wasi || !ctx.nativeStrings` left in
    `async-ir-planning.ts`;
  - no `environment` read in the async guard;
  - one shared test helper with 3 users, and no local WAT-extraction copies in the re-pinned files;
  - the ratchet gates pass;
  - a fresh-context adversarial review verdict is recorded in the PR.

## Risks

- Native async on the JS target needs the full embedder lifecycle (`buildCompiledImports` + `setInstance`). A raw
  `setExports` embedder gets an uncaught `TypeError` and an unsettled promise. That is already true on main for
  IR-claimed `delay`; the fix extends it to the programs that used to fail to compile (follow-up iv).
- The 2 gc binaries above change by design. Any other gc difference in the A/B run is a regression to explain before
  merge.
