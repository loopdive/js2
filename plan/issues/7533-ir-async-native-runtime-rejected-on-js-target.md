---
id: 7533
title: "IR async on the JS target: the native async runtime is selected, then rejected by an environment guard (since #6672)"
status: ready
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
related: [6708, 6672, 6979, 4102, 4106, 4110, 4241, 5385]
---

# #7533: native async runtime rejected on the JS environment

## Problem

On the default JS target, IR async functions fail with
`Codegen error: IR path failed for setTimeout: IR async function fetchUser selected a native standalone runtime on the
wrong target [IR-FALLBACK]`. Because the throw sits in a module-wide census, the whole IR batch is withdrawn.

- Affected tests: `tests/issue-4102-ir-promise-delay-closure-compile-once`, `4106-ir-async-fetch-user`,
  `4110-ir-fetch-all-parallel` and `4241-carrier-bag-slot`.
- First bad commit, found by first-parent bisect (lane S25, 2026-11-26): `99e6e8908`, PR #6672 (#6708 S6-A,
  native-first default). On its parent `50a173471` all four pass, except one unrelated WAT regex row in 4110.
- Lead decision (2026-11-26): fix it, do not retire it. The JS environment runs the same native core (#6708).

## Root cause (verified on `1a726b3e`)

- **Selection.** `src/ir/runtime/intrinsic-preparation.ts` `attachAsyncRuntime` (~L963–1027) picks
  `kind: "standalone-native-wasmgc"` whenever every selected provider is `native-managed`. That holds on every WasmGC
  build since S6-A plus S7-c (`assertNativeRegime`).
- **The IR layers already agree with the native pick:**
  - `projectIrBackendTargetProfile` (`src/ir/backend/legality.ts` L74–90, #5385) maps JS environment + native regime to
    `target: "standalone"`;
  - `irProgramRuntimePolicy` (`src/ir/integration.ts` ~L1460);
  - the attachment validator (`src/ir/runtime/async-attachment.ts` L175–185).
- **The guard disagrees.** Only the codegen guard in `collectPreparedAsyncRuntimeRequests`
  (`src/codegen/ir-async-runtime-adapters.ts` L101–104) re-derives admissibility from
  `ctx.targetProfile.environment !== "none"`. That is an embedder fact, not a semantic one.
- **Probe.** In a patched copy, changing only that condition gives:
  - #4241: 16/16;
  - #4106: the post-await tail row passes;
  - #4110: 6 red, down from 7.
- **The remaining reds are mostly host-projection pins in the tests:**
  - (a) They read raw `instance.exports`, so the async result is a native `$Promise` struct (`{}`).
    `wrapCompiledExports` gives 70, 98 and 99.
  - (b) They use `setExports`. The IR timer callback is dispatched through the branded authority in
    `src/runtime/standalone-timer-callback-bridge.ts` `readAuthority`, which only `setInstance` establishes.
  - (c) They assert the retired host projection: `ASYNC_HOST_ADAPTERS` imports, `delay__closure_*` names (the native
    `__ir_promise_delay_native` deliberately removes that closure), `Promise_all_import`.
- **S7-c (9b0daa543) also dropped `!ctx.standalone ||`** from `preparedIrAsyncSourceCanSuspendOnTarget`
  (`src/codegen/async-ir-planning.ts` ~L766). That is intended (one core), and it means old host-shape claims such as
  `fetchUser` with `delay(0, …)` are now correctly refused at select.

## Implementation Plan

**Design.** Keep the selection; the guard is the bug. Choosing a host runtime on the JS target would bring back a host
semantic import, which the one-native-core rule (#6708) forbids. The `host-wasmgc` arm is now unreachable on WasmGC, but
it is not deleted here: retiring it is its own reviewed change.

1. `src/codegen/async-ir-planning.ts`: export one predicate, `preparedNativeAsyncTarget(ctx)`
   (`!ctx.wasi && ctx.nativeStrings`), replacing the 4 inline copies (~L1367, 1411, 1439, 1470). Selection admission
   and the guard then read one fact.
2. `src/codegen/ir-async-runtime-adapters.ts` L101–104: the native arm throws iff `!preparedNativeAsyncTarget(ctx)`.
   No `environment` read. The host arm is untouched.
3. Tests, in the same PR:
   - instantiate with `setInstance` and read results through `jsFacingExports` (`tests/helpers/compile.ts`, no new
     helper);
   - re-pin each host-projection assertion to the native projection. Every removed host assertion gets a native
     counterpart that checks behaviour (the settled value), not only names, and each re-pin is listed in the PR body.
4. Known remaining red: the #4110 "ordinary array near miss" row fails in legacy codegen with "would need retired host
   imports: env::Promise_all" (from S7, #6979; it belongs with #5385). It is not skipped or marked todo. It stays red
   under its own issue; ask the lead for an id.
5. Follow-ups, ids from the lead:
   - retire `host-wasmgc` and rename `standalone-native-wasmgc` to `native-wasmgc`;
   - an embedder using `setExports` with an IR timer callback hangs silently: fail loudly or export the generic
     dispatcher.

## Acceptance criteria

- The four tests pass (except the 4110 row in step 4), and no "wrong target" IR-FALLBACK appears in stderr.
- **Bytes**, measured with the file-copy A/B pattern and sha256 of `result.binary` over
  `website/playground/examples/**/*.ts` plus the four test sources:
  - gc binaries change only for modules whose base compile logged the wrong-target fallback;
  - standalone and WASI hashes are identical;
  - `pnpm run check:ir-fallbacks` does not grow.
- `node scripts/equivalence-gate.mjs` passes, and so do `tests/equivalence/issue-6995*` / `issue-6996*`.
- **Code quality:**
  - one predicate, with zero inline `!ctx.wasi && ctx.nativeStrings` copies left in `async-ir-planning.ts`;
  - no new `environment` reads in async codegen;
  - no single-use helper;
  - the ratchet gates pass;
  - a fresh-context adversarial review verdict is recorded in the PR.

## Risks

- Native async on JS depends on the boundary adapter (`__drain_microtasks`, `setInstance`). A raw `setExports`
  embedder hangs silently; that is follow-up (b).
- More programs claim through IR on gc, so their binaries change by design. The A/B diff must list exactly those.
