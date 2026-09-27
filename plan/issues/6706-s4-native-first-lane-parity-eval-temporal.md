---
id: 6706
title: "S4: the native-first measurement lane links the same eval and Temporal providers as the standalone lane"
status: ready
created: 2026-09-27
updated: 2026-09-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci, testing
language_feature: test262-runner
goal: architecture
sprint: current
parent: 5385
depends_on: [6685]
related: [2928, 4242, 5353, 5383, 6489]
---

# #6706 — S4: measurement-lane parity for the native regime

Slice S4 of the #5385 "Implementation Plan v2". Until this lands the nightly
native-first number is not comparable to the host lane: it runs the cheap
REFUSAL eval tier built in-job and does not link the Temporal provider at all.
Measured on nightly 36228065594 (2026-09-26, before S1–S3): **473** rows lost
to `dynamic code evaluation is not supported … refusal` and **1,507** rows
`ReferenceError: Temporal is not defined` (both host-passing).

## Change (`.github/workflows/test262-sharded.yml`)

### A. Eval provider

1. `runtime-eval-provider` job (≈ L665): its `if:` has arms for
   `merge_group`, `push` and `workflow_dispatch` only. Add the `schedule` arm
   the `temporal-provider` job already carries (≈ L789–L804, #6489), and make
   the per-step `needs.changes.outputs.run_standalone != 'false'` guards treat
   a `schedule` run as "run" (on `schedule` the `changes` job is skipped, so
   those outputs read empty — see the note at ≈ L796). Keep the default
   engine `quickjs` so the lane measures the same tier as standalone.
2. `test262-native-first` job (≈ L946): add `needs: [runtime-eval-provider,
   temporal-provider]` (plus the existing needs), drop the in-job
   `JS2WASM_EVAL_ENGINE: interpreter` + "Build runtime-eval REFUSAL provider"
   step (#5385 checkpoint), and copy the standalone shard's two steps —
   "Download selected runtime-eval provider" and "Verify shared runtime-eval
   provider cache" (≈ L1672–L1690) — with their `if:` re-keyed from
   `matrix.target.test262_target == 'standalone'` to unconditional inside this
   job. Set `JS2WASM_EVAL_ENGINE: ${{ inputs.eval_engine || 'quickjs' }}` in
   the job env.
3. Runner side is already done (S0/#5385: `scripts/test262-import-object.mjs`
   attaches `js2wasm:runtime-eval` for `semanticProviders === "native-first"`).
   Verify `scripts/run-test262-vitest.sh` prebuild block also selects
   `quickjs` for native-first when `JS2WASM_EVAL_ENGINE` is unset (today it
   inherits the default; keep it that way).

### B. Temporal provider

The host lane links a provider compiled with host semantics; the standalone
lane links a host-free one (#5383 S3, opt-in). The regime needs a provider
compiled under the same regime it links against, or the linked module's
imports will not resolve.

1. `scripts/test262-temporal.mjs` `temporalProviderCompileOptions(target)`
   (≈ L66): accept a second argument `semanticProviders` and return
   `{ semanticProviders: "native-first", hostBridge: "always" }` for the
   regime lane (env `JS2WASM_NATIVE_REGIME_JS=1` is set by the lane, so the
   provider compiles under the regime). The cache stamp must include the
   provider policy so a host-semantics stamp never certifies a regime
   binary (mirror how #5383 keyed the standalone stamp).
2. `scripts/prewarm-temporal-provider.mjs`: add `--semantic-providers
   native-first` (target stays `host`), and call it in the `temporal-provider`
   job for the `schedule`/`native_first` case; upload under a distinct
   artifact name so the host lane's artifact is untouched.
3. `test262-native-first` shard: download that artifact into
   `.test262-cache/temporal` and let the worker link it (the worker already
   links when a matching stamp is present; `scripts/test262-worker.mjs`
   ≈ L1336 `getWorkerTemporalProvider(target)` must pass the lane's
   `semanticProviders` through to the stamp check).
4. If linking under the regime fails to compile within the job budget,
   land part A alone and record the Temporal residual as a known lane gap in
   the #5385 census; do not silently fall back to the host-semantics provider
   (that would label host results as regime results).

## Acceptance

- [ ] A `workflow_dispatch` run with `native_first: true` shows the
      native-first shards downloading and verifying the QuickJS eval provider
      (no "REFUSAL" tier announcement in the shard logs).
- [ ] The next nightly's native-first JSONL has zero
      `dynamic code evaluation is not supported` rows that pass in the host
      lane (before: 473).
- [ ] Temporal rows: either linked (before: 1,507 `Temporal is not defined`
      host-passing rows → ≤ the standalone lane's count) or explicitly
      recorded as a lane gap per B.4.
- [ ] Host lane and standalone lane artifacts, stamps and baselines are
      byte-for-byte unaffected (compare the promoted `test262-current.json`
      and `test262-standalone-current.json` before/after; the promote job
      never reads native-first artifacts).
- [ ] `tests/issue-3431-mg-matrix.test.ts` and the workflow lint pass.
