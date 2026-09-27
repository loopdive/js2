---
id: 6706
title: "S4: the native-first measurement lane links the same eval and Temporal providers as the standalone lane"
status: done
created: 2026-09-27
updated: 2026-09-27
completed: 2026-09-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci, testing
language_feature: test262-runner
goal: architecture
sprint: current
assignee: ttraenkler/opus-6706
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

## Outcome (2026-09-27, opus-6706)

**A landed in full; B is plumbed and fail-closed (B.4).**

- **A.** `runtime-eval-provider` has the `schedule` arm (its step guards are
  `run_standalone != 'false'`, which the empty `changes` outputs on `schedule`
  already satisfy). `test262-native-first` `needs: [runtime-eval-provider,
  temporal-provider]`, downloads + verifies the shared provider
  (`--require-cache` / `--require-full-cache`), and no longer builds the
  REFUSAL tier. Its `if:` is `!cancelled()` + explicit `needs.*.result ==
  'success'` rather than the implicit `success()`: on `schedule` the
  providers' ancestors (`changes`, `mg-artifact-probe`) are skipped, and the
  implicit form cascade-skips the job. The same trap currently skips every
  `test262-honest-audit` shard on the nightly (run 36228065594: temporal-provider
  `success`, all audit shards `skipped`) — out of scope here, worth its own fix.
  The lane also takes the standalone cells' `TEST262_FULL_RUNTIME_EVAL=1` and
  `TEST262_IT_TIMEOUT_MS=300000` (eval-heavy rows killed by vitest write no row
  and would fail the completeness validator).
- **B.** `temporalProviderCompileOptions(target, semanticProviders)` returns
  `{ semanticProviders: "native-first", hostBridge: "always" }` for the JS-host
  native-first lane; its stamp is `prewarm-native-first.json` and records
  `semanticProviders` + `nativeRegime` (the cache key does not see the
  `JS2WASM_NATIVE_REGIME_JS` opt-in, so the stamp does and the consumer
  compares). `prewarm-temporal-provider.mjs --semantic-providers native-first`
  (host only, requires `JS2WASM_NATIVE_REGIME_JS=1`). The `temporal-provider`
  job builds it soft into its own dir/cache/artifact
  (`temporal-provider-native-first-<run>`); the host artifact is untouched.
  The worker passes the lane's `semanticProviders` to the stamp check; with no
  regime stamp the rows run unlinked, announced once per fork — never against
  the host-semantics provider.

### Finding — why the regime Temporal provider does not build yet (input for a follow-up)

`JS2WASM_NATIVE_REGIME_JS=1 node scripts/prewarm-temporal-provider.mjs --target host --semantic-providers native-first`
fails: the linker's provider compile (`src/package-linker.ts` ~L1907, source
`@js-temporal/polyfill`) is rejected by the native-first import gate
(`src/compiler.ts` ~L1203):

> Native-first semantic-provider policy rejected implicit or unclassified host
> imports: `env::__exn` (unknown, owner #4401).

`env::__exn` is the shared exception tag the linker requests for every provider
and consumer (`sharedExceptionTag: true`, #5226). `src/codegen/context/create-context.ts`
~L248 makes it an **imported** tag only when the target is not `standalone`/`wasi`,
and the host-import inventory classifies it `unknown`. The standalone Temporal
provider does not carry it (built 2026-09-27: 3.78 MB, `WebAssembly.Module.imports` = `[]`).
So a JS-environment-only arm still mints a raw `__exn` import under the regime.
The consumer side (`compileWithTemporalGlobal`, also `sharedExceptionTag: true`)
will hit the same gate. Fix belongs in `src/` (classify the linker's shared tag,
or define it module-locally under the regime) — not in this CI slice. Until
then the nightly regime build step fails soft each run (~1 min).

## Test Results

- `tests/issue-6706-native-first-lane-providers.test.ts` (new, 7) pass;
  `issue-3431-mg-matrix`, `issue-2928-e6-provider-cache`, `issue-4242-eval-engine-parity`,
  `issue-5353-sharded-temporal-lane`, `test262-per-lane-gating`,
  `test262-baseline-pair-admission`, `issue-2178-*`, `issue-3303`, and the
  `S3` block of `issue-5383-*` pass. Pre-existing on base and unrelated:
  `issue-5385-test262-native-lane` "worker compile branches",
  `issue-5382` "separates every fingerprinted option".
- Workflow YAML parses; `run-test262-vitest.sh` still defaults
  `EVAL_ENGINE=quickjs` for native-first.
- Scoped local run (`TEST262_SEMANTIC_PROVIDERS=native-first`,
  `TEST262_PATH_FILTER=built-ins/Temporal/Now/`, interpreter engine): prewarm
  reports UNAVAILABLE, each fork announces `Temporal provider NOT linked (the
  host/native-first lane has no eligible provider)`; 48/66 rows `Temporal is
  not defined`, unchanged from before (the lane was unlinked before too).
- `tests/issue-5383-standalone-temporal-provider.test.ts` is left at main's
  content (the #3008 changed-file gate would otherwise root on it, and its
  "S2i … DYNAMIC class-value receiver" test fails on main independently:
  `expected NaN to be 8`). The #6706 source-shape assertions live in
  `tests/issue-6706-native-first-lane-providers.test.ts`.
