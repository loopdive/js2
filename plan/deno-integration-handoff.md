# Deno integration handoff

Updated: 2026-09-09. Checkpoint, not completed Deno compatibility.

## Revisions and ownership

- Compiler branch: `codex/4376-deno-realm-main-sync`, implementation tip `ac17b3a939b983`.
- `loopdive/js2` main `0f5f34db78010466ef1224a0c6846f2d34aee1a2` merged via `465c7ba865691b`.
- Runtime branch: `codex/4376-deno-realm-bootstrap`, tip `0eaa1d8cb4aaeeb3ce159951e1bc1e652f36aecf`.
- Runtime build scripts still pin compiler `bda15bdf70baefc3d7620f32a03dc3660c2fd005`, the last complete paired artifact build. Do not silently relabel it as the latest compiler.
- Deno source: `1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44`; `libs/core` unchanged. Only the runner's Cargo dependency/lock selects v8x.

The detailed history is in [the integration issue](issues/4376-v8x-js2wasm-deno-core-compatibility-spike.md), titled “Spike v8x as a rusty_v8-compatible js2wasm backend for a compiler-free Deno runtime”.

## What is verified

- Compiler-free native Deno `hello_world` exits 0 and prints sum 6 followed by its expected caught serde TypeError. That exception is part of the example, not failed bootstrap.
- Native `op2` exits 0 and invokes four normal callbacks, including state access.
- Three selected unchanged Deno unit tests pass: script return, disabled op, platform initialization. This is not a full 429-test pass.
- `disable_ops` intentionally unwraps an error and exits 134 under the release `panic=abort` profile. This is an expected error-path observation, not a successful exit.
- Shared Symbol state, linked realm values, callback arguments/exceptions, native Error identity, and numeric-conversion timing were repaired and have targeted evidence in the issue.
- Latest compiler fixes: allocated subtypes retain base-field computed getters; Acorn-style node copying passes 8/8 checks, selected related suites 29/29.
- Expression-free object-pattern parameters now bind correctly. Twelve native-comparison cases pass. The rebuilt raw provider returns the correct result for shorthand parameters.
- Interpreter suite: 266 assertions pass across eight files. Its reporting-only corpus still lists known mismatches, so this is not a corpus-conformance claim.
- TypeScript7 (`--types node`), exact-main LOC/function budgets, coercion and oracle gates pass. Dead-export command exits 0 but strict graph closure remains OPEN/FAIL on unresolved dynamic imports; retirement is not certified.

## Remaining work

1. Implement general async interpreter semantics. `FLAG_ASYNC` is reserved; `emitAwait` only forwards dynamic imports. Preserve a resumable `DispatchState`, schedule promise reactions, resume fulfilled values or route rejected values at the original await PC, return promises from async calls, and preserve catch/finally and realm ownership. Do not treat forwarding a promise as general await support.
2. Complete parameter semantics: defaults/computed keys need parameter-environment isolation and TDZ; arrays need iterator semantics; rest is unimplemented. These currently remain explicit refusals.
3. Rebuild, wasm-opt, precompile, and replay unchanged Deno async tests with pinned compiler/runtime revisions. The current next test is `runtime::tests::misc::test_set_macrotask_callback_set_next_tick_callback`; the old full pair fails during parsing. The repaired provider exposes the next explicit await limitation.
4. Expand native Deno coverage and fix remaining host API/ABI gaps. Never infer full integration from examples or three selected tests.
5. Update runtime compiler pins only with a corresponding verified artifact pair. Both checkpoint PRs are now published; keep their revisions coordinated.
6. Measure V8, QuickJS, and js2wasm using the same supported Deno workload. Record versions, compile/precompile costs separately from runtime costs, startup, warm execution, per-instance RSS, shared payload, repetitions and correctness checks. Unsupported workload rows must be reported as unsupported, not estimated.

## Local reproduction state

- Compiler: `/private/tmp/js2-deno-main-sync-20260908`.
- Runtime: `/private/tmp/v8x-deno-followup-20260908`.
- Native runner: `/private/tmp/deno-realm-run-20260908`.
- Complete artifact pair: `/private/tmp/deno-number-coercion-build.7sSHn7/{core,provider}-O3.cwasm` at compiler bda15/runtime 0eaa.
- Diagnostic newer providers in compiler `.tmp/`: `provider-inherited-fields.wasm` at 7a43, `provider-object-parameters.wasm` from the ac17 source change. These are not the paired production build.
- Scratch scripts: `build-inherited-fields-provider.mjs` and `probe-inherited-provider.mjs`. The probe activates the structural result decoder and uses the owning provider's error renderer. It asserts actual numeric results for five supported cases; general await still fails honestly.
- Vitest config: `.tmp/vitest-deno-carrier.config.ts`, single fork, `--liftoff-only --experimental-wasm-exnref` as an argument array.
- Preserve all worktrees and artifacts, including unrelated primary-checkout changes. Do not prune or kill existing test sessions.

## Publishing and measurement status

Compiler PR: https://github.com/loopdive/js2/pull/5784\n\nRuntime PR: https://github.com/loopdive/v8x/pull/2\n\n[Measured Deno-core process comparison](https://github.com/loopdive/v8x/blob/codex/4376-deno-realm-bootstrap/tools/deno/results/2026-09-09-core-processes.md): seven runs per engine, all21 correct. V8/QuickJS/js2wasm deployment payload37.3/5.4/546.1MiB, peak RSS20.2/17.6/494.3MiB, median launch-through-exit57.7/44.8/13482.2ms. This is the unchanged hello_world on the last fully paired bda15/0eaa build, not warm execution, additional-instance density, latest-ac17 artifacts, or full Deno CLI support. The report includes substantial timing ranges and raw hashes/results. Earlier engine-only benchmark numbers must not be substituted for these full-core observations.\n\nThe requested wrap-up stops implementation at this checkpoint. General async and remaining integration work are handed off, not completed. No active build or measurement remains; preserve old unrelated idle processes and all worktrees.
