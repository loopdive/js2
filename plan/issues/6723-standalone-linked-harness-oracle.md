---
id: 6723
title: "test262: give the standalone lane the linked-harness oracle — compile the harness prefix once per include-set on standalone too (standalone is ~82 % of merge_group test262 work)"
status: in-progress
assignee: ttraenkler/opus-6723-d4-errors
sprint: current
priority: high
horizon: l
goal: maintainability
reasoning_effort: max
requested_by: ttraenkler/opus-lead
created: 2026-09-28
related: [3451, 6486, 6492, 5383, 5407, 6722, 6676]
# 2026-09-28 (#6723 P0 D1): the provider allow-list admits `js2wasm:runtime-eval`
# for standalone providers via one spread line in compileLinkedProject; the
# rationale lives in the new helper `standaloneProviderRuntimeImports` (+12
# lines of helper + doc, +1 line in the function).
# 2026-09-29 (#6723 D4 errors): a linked standalone consumer must import the
# provider's Error-family carrier cells BEFORE it defines its first global (an
# import global's index sits below every defined one and nothing renumbers
# globals), so the call has to sit right after createCodegenContext in both
# drivers: +1 line in generateModule, +1 in generateMultiModule, +1 import line
# in index.ts. The mechanism itself lives in standalone-link-error-ctor-cells.ts.
loc-budget-allow:
  - src/package-linker.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/package-linker.ts::compileLinkedProject
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

## Problem

Since the #3451 slice 6 flip (2026-09-17) the js-host test262 lane compiles
the harness prefix once per include-set and links each test body against it.
The standalone lane still compiles the whole assembly (harness + body) for
every row. The gate is one condition in `tests/test262-shared.ts`
(`TEST262_ORACLE_MODE === "linked" && IS_HOST_LANE`).

Cost today, from the promoted standalone baseline (2026-09-24, 48,735 rows)
and six merge_group runs (2026-09-28, see #6722):

| | js-host (linked) | standalone (honest) |
|---|---:|---:|
| `Run shard` runner-seconds per merge_group | ~8.5k | ~39.7k |
| compile per row, median | ~0.25 s | 2.25 s |
| compile, whole corpus | — | 38.8 core-h |
| of which Temporal rows (4,603) | — | 8.45 core-h |

#6722 rebalances the matrix (20/82) so the lanes finish together, but the
standalone lane is still ~82 % of all test262 work in every merge group.

The original reason for host-only was that the provider "crosses its values
through the JS host bridge, which a standalone/WASI binary does not have"
(`tests/test262-shared.ts` comment). That reason is stale: the harness
provider rides the same package linker as the Temporal provider, and #5383
built a host-free standalone Temporal provider whose consumers link with zero
host imports (`result.imports === []`, measured 2026-09-12). The machinery
exists; three defects stop it on standalone.

## Measurement (2026-09-28, this plan's evidence)

Local A/B on a seeded random sample of 360 non-Temporal, non-intl402
standalone rows (`random.seed(6723)` over the baseline jsonl), same bundles,
fresh harness cache per run, `COMPILER_POOL_SIZE=3`,
`TEST262_TARGET=standalone TEST262_ORACLE_MODE=linked`. Arm A: current gate
(honest). Arm B: `IS_HOST_LANE` removed from the gate (file-copy swap of
`tests/test262-shared.ts`, restored after). Result files:
`benchmarks/results/salinked-{honest,linked}-results-*.jsonl` (local only).

| | honest | linked (gate removed) |
|---|---:|---:|
| wall | 481 s | 751 s |
| pass / fail / CE / timeout | 300 / 43 / 17 / 0 | 285 / 54 / 17 / 4 |
| rows actually linked | — | 15 (345 fell back) |

Only one include-set family built a provider (`testTypedArray.js` ±
`compareArray` / `propertyHelper` / `detachArrayBuffer`). On its 11 linked
rows that did not hit the fork budget, body compile fell from **94.3 s to
22.1 s (4.3×)**. The other four linked rows hit the 30 s fork budget because
the cold provider build was charged to them. Small sample, one family — the
speed figure is a direction, not a forecast.

Three defects, each reproduced:

**D1 — the default include-set cannot build a standalone provider.** 17 of
the provider builds failed with
`Harness provider was not linked separately (plan=bundled, reason=test262-harness provider requires unsupported import js2wasm:runtime-eval)`.
The default prefix (`__js2wasm_test262_runtime__.js` + `assert.js` +
`sta.js`, 10.2 KB) compiled alone for standalone reports `imports: []`, so the
eval import is one the row path satisfies at instantiation
(`scripts/test262-import-object.mjs` → `instantiateTest262Module`) and the
compile's import list deliberately hides. The package linker's provider check
(`src/package-linker.ts` ~L1934, `allowedProviderModules`) reads the RAW
Wasm imports and admits only `env`, `wasm:js-string`, the string-constant
namespaces, `options.link` and dependency bindings. `js2wasm:runtime-eval`
is none of those, so the provider falls back to a bundled plan and
`buildHarnessProvider` throws.

**D2 — linked standalone bodies cannot see harness bindings.** Every linked
TypedArray row that passes honest failed linked, 9 of 10, with
`ReferenceError: testWithTypedArrayConstructors is not defined`,
`verifyProperty is not defined`, `TypedArray is not defined`. The body's
binding prelude (`var <name> = __h_<name>()`, `harnessBindingPrelude` in
`src/test262-harness-provider.ts`) either does not reach the standalone
global resolution the body uses, or the getter returns before the provider's
`__module_init` has run on standalone. Repro:
`test/built-ins/TypedArray/prototype/findIndex/name.js`.

**D3 — standalone fallback rows lose strict mode.** Four rows that fell back
(`linked-harness-fallback`) flipped pass→fail with
`Expected a TypeError to be thrown but no exception was thrown at all`:
`language/expressions/compound-assignment/11.13.2-23-s.js`,
`built-ins/Function/15.3.5.4_2-21gs.js`,
`language/arguments-object/10.5-1-s.js`,
`language/function-code/10.4.3-1-9gs.js`. The fallback compiles
`linkedHarness.harnessPrefix + source` (`scripts/test262-worker.mjs`
~L1665), not the honest assembly; on standalone the strict variant loses its
directive position. The host lane does **not** show this: 359 of 360 strict
host fallback rows pass in the promoted baseline, so it is standalone-only.

Side finding, host lane: 9,280 of 48,735 promoted host rows (19 %) are
`linked-harness-fallback`, 4,611 of them Temporal (the worker compiles
Temporal rows honestly by design, L1598), the rest mostly linked compile
failures on syntax the body-only unit rejects
(`Expression expected`, `Rest element may not have a default initializer`,
`A rest element must be last`, `Invalid left-hand side`, ~280 each). Those
are cost on host too, and the same classes will appear on standalone.

## Implementation Plan

Mirrors the #3451 slice 6 host flip. Opus implements; each phase is its own
PR, measured before the next.

### P0 — make the linked lane correct on standalone (no CI change)

1. **D1, provider imports.** In `src/package-linker.ts`, admit
   `js2wasm:runtime-eval` in `allowedProviderModules` when the provider is
   compiled for `target: "standalone"`. Then make the provider instance
   receive the same runtime-eval binding the row gets: the harness provider is
   instantiated by `instantiateLinkedProviders` (runtime bundle); it must be
   handed the per-test runtime-eval provider from
   `scripts/test262-import-object.mjs`, the one seam that already owns tier
   selection. Check first whether the prefix needs the import at all: if the
   eval import is emitted unconditionally, compiling the provider with the
   #6676 option (`false`: no runtime-eval provider will be linked) may remove
   it, which is the smaller fix. Measure both on the default prefix before
   choosing.
   - Unit test: `buildHarnessProvider` for the default prefix with
     `target: "standalone"` returns a provider (no throw), and a consumer
     compiled with `compileHarnessLinkedBody` reports `imports: []`.
2. **D2, bindings.** Reproduce on `TypedArray/prototype/findIndex/name.js`
   linked. Establish whether the getter import resolves (inspect the
   consumer's WAT for the `__h_` imports and the prelude's `global.set`s), and
   whether standalone's undeclared-global lookup reads the script-goal `var`
   the prelude declares. The host path works; diff the host and standalone
   consumer WAT for the same body first. Unit test: a linked standalone body
   calling `verifyProperty` and `testWithTypedArrayConstructors` passes.
3. **D3, fallback strictness.** The fallback must compile exactly what the
   honest lane compiles. Replace `linkedHarness.harnessPrefix + source` with
   the honest assembly for the variant being run (the worker already has it:
   the row's original assembled source). Host keeps working (its fallback
   rows already pass) and standalone stops flipping. Unit test: one of the
   four rows above, fallback forced, keeps its strict verdict.
4. **Re-measure** the same 360-row sample (the seed and procedure above).
   Target: zero verdict diffs attributable to D1–D3, and every
   non-Temporal include-set in the sample building a provider.

### P1 — the 30 s fork budget: prewarm standalone harness providers

A cold provider build is charged to the first row of its include-set and
kills rows at 30 s (4 of 15 in the measurement).
`scripts/prewarm-test262-harness-providers.mjs` already accepts
`--target standalone`. Add a prewarm step to the standalone shard job (or a
single upstream job that uploads the cache as the Temporal provider does,
`temporal-provider` job ~L860), keyed on the compiler bundle hash. Note the
harness provider cache key currently has no compiler hash (see
`JS2WASM_TEST262_HARNESS_CACHE` handling), so a stale cache is a real hazard
in CI too; add the bundle hash to the key in the same PR.

### P2 — shadow measurement in CI

Dispatch-only run with the standalone cells in linked mode (a
`standalone_linked` workflow input, default off), parity report via
`scripts/test262-linked-parity.mjs` against the promoted standalone baseline.
Record in this issue: per-row compile, `Run shard` totals, pass→fail and
fail→pass counts, fallback-reason histogram. Gate to proceed: pass→fail ≤ the
host flip's rate (705 of ~40k before P0 there, 353 declared at flip), no
`illegal cast` / trap bucket (the #3189 trap ratchet is not excused by a
re-baseline), and a median standalone shard at least 2× faster.

### P3 — authority flip (the host slice 6 recipe, standalone cells)

1. `tests/test262-shared.ts`: drop `&& IS_HOST_LANE` from the linked arm
   only (the `fast` arm stays host-only; the native harness genuinely needs a
   JS host).
2. `tests/test262-oracle-version.ts`: `ORACLE_VERSION` 14 → 15, history note
   "standalone verdicts come from the linked-harness oracle"; this forward
   bump makes `diff-test262.ts` auto-rebase the first main run and
   promote-baseline re-seed `test262-standalone-current.jsonl` with
   `oracle_lane: linked-harness`.
3. Declare the measured P2 ceiling in this issue's frontmatter
   (`regressions-allow`, rebase mode, #3303), hand-edit the standalone
   edition-ratchet floors by exactly the measured per-edition delta with a
   `reason`, and re-seed the standalone high-water mark
   (`benchmarks/results/test262-standalone-highwater.json`) the same way the
   host flip documented.
4. Standalone honest audit: extend `test262-honest-audit` with standalone
   cells (nightly cron, never required), and point the parity report at them.
5. `scripts/gen-test262-mg-matrix.mjs`: re-derive the split from the first
   three green merge_group runs after the flip (procedure in that file).
6. CLAUDE.md "Test262" and `docs/ci-policy.md`: the linked oracle is
   authoritative for both lanes; honest is the audit for both.

### P4 — Temporal rows (separate issue when P3 lands)

Temporal rows are 8.45 of 38.8 standalone core-hours and compile honestly on
both lanes (`scripts/test262-worker.mjs` L1598). Linking the harness provider
and the Temporal provider into the same consumer depends on #5407's per-site
link cost. File it once P3's numbers show what is left.

## Acceptance

- [ ] P0: the 360-row sample shows no D1–D3 verdict diffs, and every
      non-Temporal include-set in it builds a standalone provider.
- [ ] P1: no `compile_timeout` row caused by a cold harness provider build in
      a standalone shard.
- [ ] P2: dispatch parity report recorded here, meeting the P2 gate.
- [ ] P3: merge_group standalone median shard ≥ 2× faster than the #6722
      baseline, first post-flip runs recorded, matrix re-derived.

## Expected gain (estimate, to be replaced by P2's measurement)

If P0 lifts the linked share on standalone to the host lane's 81 % and the
4.3× body speed-up holds beyond one include-set, the non-Temporal 30.4
core-hours drop to ~11.7, and the lane to ~20 core-hours with Temporal
unchanged: about 1.9× less standalone work per merge group. The P2
measurement decides whether P3 goes ahead.

## P0 results (2026-09-28)

Sample: the same 360 files as the Measurement section (taken verbatim from
the lead's `salinked-honest` result file; re-deriving `random.seed(6723)`
from today's re-promoted baseline gives a different sample, 3/360 overlap).
Same procedure: fresh harness cache per run, `COMPILER_POOL_SIZE=3`, quickjs
eval engine, 4-core box. Linked arm = `&& IS_HOST_LANE` removed from the
gate by file copy, never committed. Result files (local only):
`benchmarks/results/p0{new-sa-honest,base-sa-linked,b-sa-linked,base-host-linked,final-host-linked}-results-*.jsonl`.

### What each defect actually was

| | root cause | fix |
|---|---|---|
| D1 | `$262` is exported by the provider, so the runtime shim's `evalScript` direct eval stays live and the provider imports `js2wasm:runtime-eval` (the prefix compiled ALONE reports none only because `$262` is dead code there). `runtimeEvalProvider: false` does not remove it (measured: same refusal) and would change eval verdicts anyway. On this box EVERY include-set failed (359/360 rows "no harness provider"), not just the default one. | `src/package-linker.ts`: admit `js2wasm:runtime-eval` for `target: standalone` providers (not under `runtimeEvalProvider: false`). `scripts/test262-import-object.mjs`: attach the row's ONE runtime-eval instance when the consumer OR any linked provider imports it; the provider inherits it (non-env namespaces pass through `buildProviderImportObject`). |
| D2 | Not a binding bug. The compile-timeout and poison RETRIES in `tests/test262-shared.ts` re-sent the linked body-only unit without `linkedHarnessOpts`, so the retried row compiled the body with no harness. Every D2 row in the lead's file carries `retried: true`; the first attempts were cold-provider timeouts. Affects the host lane too (any timed-out linked row). | Spread `...linkedHarnessOpts` into both retry calls. |
| D3 | As diagnosed: `prefix + bodySource` puts the strict directive after the harness. | The parent sends `linkedHarnessHonestSource` (the honest assembly of the variant being run, primary or strict rerun); the worker's fallback and the Temporal branch compile it. Error-line offset switches to the honest one on fallback rows. |

Also (worker, standalone-only): exception payloads minted by the provider
(`Test262Error` from `assert.*`) are rendered through the provider's own
`__exn_render_*` exports, and the async drain runs every linked module's
microtask ring. Verdict-neutral except where the message decides a
runtime-negative match; it is what made the table below readable.

### Standalone, 360 rows

| arm | pass | fail | CE | timeout | rows linked | compile ms (all rows) |
|---|---:|---:|---:|---:|---:|---:|
| honest (`p0new-sa-honest`) | 313 | 31 | 16 | 0 | — | 1,034,969 |
| linked, main (`p0base-sa-linked`) | 309 | 35 | 16 | 0 | 1 | 1,506,951 |
| linked, P0 (`p0b-sa-linked`) | 193 | 153 | 14 | 0 | 305 | 646,191 |

- main linked vs honest: exactly the 4 D3 rows (`11.13.2-23-s`,
  `15.3.5.4_2-21gs`, `10.5-1-s`, `10.4.3-1-9gs`), all fallback rows.
- P0: every include-set in the sample built a provider (19 distinct
  providers, 27 cold builds, max 12.3 s, 0 "no harness provider"); the 55
  fallbacks are all body-level `linked compile failed` (syntax the body-only
  unit rejects, as on host).
- Compile on the 305 linked rows: honest 1,009,551 ms vs linked 595,007 ms
  (1.7×); median per row 2,542 ms vs 1,248 ms. Standalone linked body
  compile is ~5× the host lane's ~0.25 s, so the speed-up is much smaller
  than the 4.3× measured on 11 rows.
- No cold-build timeouts in this run (P1 still applies: 12.3 s builds are
  charged to rows).

### P0 is NOT correct yet: a new defect class (D4) appears once rows link

125 verdict diffs vs honest (122 pass→fail, 2 →pass, 1 CE→fail), none attributable to D1–D3.
They are cross-module semantics on standalone — two modules, two sets of
in-wasm intrinsics, and the provider reading consumer-minted values:

| count | class | example |
|---:|---|---|
| 39 | `assert.throws`: provider reads `thrown.constructor` of a consumer-minted error → `undefined` ("Expected a TypeError but got a undefined") | `TypedArray/prototype/filter/BigInt/callbackfn-not-callable-throws.js`, `arguments-object/10.5-1-s.js` |
| 27 | provider-minted/foreign payload not renderable (`[object Object]`), same family | `TypedArray/prototype/set/array-arg-return-abrupt-from-src-get-length.js` |
| 18 | async completion marker not observed: the provider's `print` compiles to the no-sink drop (no `__stdout_*` in either module) | `class/elements/async-gen-private-method-static/yield-star-getiter-sync-returns-number-throw.js` |
| 11 | `verifyProperty` descriptor reads on consumer functions (`length`/`name`) | `Array/prototype/toString/length.js` |
| 10 | provider's TypedArray constructors/prototypes used from the body → `undefined` methods | `TypedArray/prototype/map/return-new-typedarray-from-positive-length.js` |
| 4 | iterator protocol across modules ("value is not iterable") | `for-of/dstr/array-empty-iter-close.js` |
| 13 | other pass→fail (sameValue on foreign values, `asyncTest` flag, 1 illegal cast) | |

This is the #5383 reverse-peer boundary (`src/codegen/standalone-link-reverse-peer.ts`)
not yet covering getOwnPropertyDescriptor / `constructor` / iterator / typed
array arms, plus per-module intrinsics. Options, none chosen here:

1. Extend the reverse-peer ABI arm by arm (descriptor read, error
   `constructor`, iterator step, TypedArray brand) until the sample's diffs
   clear — incremental, but each arm is its own #5383-sized slice.
2. One intrinsic realm per linked graph: the provider owns the intrinsics
   and the consumer imports them (the host lane gets this for free from the
   JS realm). Removes most classes at once; large ABI change.
3. Gate the standalone linked lane per include-set / per body shape and
   fall back otherwise — cheap, but the classes above hit the core
   `assert.throws`/`verifyProperty` helpers, so little would link.
4. Fix the provider stdout sink separately (18 rows) — a compiler defect in
   the multi-file standalone plan, independent of 1–3.

### Host lane unchanged

`p0base-host-linked` (main) vs `p0final-host-linked` (P0), same 360 rows,
`TEST262_ORACLE_MODE=linked`: 302 / 57 / 1 CE both, 316 linked / 44
fallback both, **0 verdict diffs**.

## D4 slice: provider print sink (2026-09-29)

**Root cause — not a compiler defect, a worker option.** The provider DOES mint
the `__stdout_acc`/`__stdout_append` sink (the name is in its binary), and
`print` does append to it. Its readout exports `__stdout_prepare`/`__stdout_char`
are host-bridge exports, which `stripHostBridgeExports` removes on standalone
unless the compile passes `hostBridge: "always"`. Every worker compile site gets
that through `HARNESS_HOST_BRIDGE` (`compileSingleSource`/`compileMultipleSources`),
but the linked path compiles through `buildHarnessProvider` and
`compileHarnessLinkedBody` directly, bypassing both wrappers — so neither the
provider nor the body carried the bridge the honest standalone compile has.
The marker was written; nothing could read it. (Host is unaffected: on a JS
environment `"auto"` already resolves to the same `required` interop.)

**Fix** (`scripts/test262-worker.mjs`): `...HARNESS_HOST_BRIDGE` in
`harnessProviderCompileOptions` and in the linked `bodyOptions`. The provider
owns its own sink and the worker already reads every linked module's sink
(P0's `drainAndCaptureNativeStdout`), so no ABI change and no host import
(consumer `result.imports` stays `[]`, asserted in the new test). The provider
cache key already fingerprints `hostBridge`, so stale providers cannot be reused.

Unit test `tests/issue-6723-standalone-linked-print.test.ts`: async `$DONE`
marker observed through the provider's drained sink; a synchronous `$DONE()`
(its `print` running in the provider) observed; and the repro (default
`hostBridge`: provider publishes no `__stdout_*`, marker lost).

### Measurement — same 360 rows as P0 (P0's `.tmp/sample.txt`), same procedure

Fresh harness cache per run, `COMPILER_POOL_SIZE=3`, quickjs eval, linked arm
gated on by file copy (never committed). Base = `origin/main` 075e05dfc4
(includes P0). Result files (local only):
`benchmarks/results/d4{base,new}-{sa,host}-linked-results-*.jsonl`.

| arm | pass | fail | CE | timeout | rows linked | "marker not observed" |
|---|---:|---:|---:|---:|---:|---:|
| standalone linked, main (`d4base-sa-linked`) | 194 | 156 | 10 | 0 | 309 | 26 |
| standalone linked, fix (`d4new-sa-linked`) | **216** | 134 | 10 | 0 | 309 | **0** |
| host linked, main (`d4base-host-linked`) | 302 | 57 | 1 | 0 | 316 | 0 |
| host linked, fix (`d4new-host-linked`) | 302 | 57 | 1 | 0 | 316 | 0 |

(main's standalone linked arm today is 194/156/10, not P0's 193/153/14 — main
moved; the comparison above is against a base run executed today.)

- Standalone: **22 fail→pass, 0 pass→fail.** 18 are the D4 print rows
  (incl. `statements/class/elements/async-gen-private-method-static/yield-star-getiter-sync-returns-number-throw.js`
  and its `expressions/` twin). The other 4 are D4 `verifyProperty` `length`
  rows (`annexB/String/prototype/{fixed,sup}/length.js`,
  `Array/prototype/toString/length.js`, `String/prototype/repeat/length.js`):
  the body now also carries the bridge the honest compile has, which the
  descriptor read relies on.
- The 8 other base rows that reported "marker not observed" now report their
  real `Test262:AsyncTestFailure` text: 3 fail linked but pass honest, all the
  D4 `assert.throws` constructor class ("Expected a ReferenceError but got a
  undefined": `async-generator/dstr/obj-ptrn-prop-id.js`,
  `class/dstr/async-private-gen-meth-static-obj-ptrn-prop-ary.js`,
  `statements/class/dstr/async-private-gen-meth-ary-ptrn-elem-obj-prop-id.js`);
  5 fail or CE honest too.
- Host: **0 verdict diffs.**

### Still open (not this slice)

- A test body calling the provider's `print` DIRECTLY (`print("x")`, a
  `var print = function …` closure value) throws "Cannot access property on
  null or undefined" on standalone, while a call to a declared provider
  function (`$DONE()`) works — cross-module closure-value call, same family as
  the other D4 classes. Rare in test262 (async rows go through `$DONE`).
- D4 classes 1, 2, 5, 6, 7 unchanged.

## P1/P2 wiring (2026-09-29)

Scripts + workflow only; no `src/` change.

**Cache key (P1).** `test262HarnessProviderCacheDir()`
(`scripts/test262-harness-cache.mjs`) now returns
`<root>/bundle-<compiler bundle hash>`, where `<root>` is
`JS2WASM_TEST262_HARNESS_CACHE` (still the override) or the tmpdir default. The
hash is `test262CompilerBundleHash()` — the worker's #1521 `BUNDLE_HASH` rule
moved into that module (`TEST262_BUNDLE_HASH`, else sha256 of
`scripts/compiler-bundle.mjs` / `index.js`), and the worker now imports it, so
the result-row stamp and the cache key cannot disagree. A cache built by a
different compiler is a miss, never a stale provider. The prewarm's
`--cache-dir` is a root too. Why the directory and not the provider key:
the key lives in `src/test262-harness-provider.ts` (out of scope for this
lane) and a directory split also retires the whole stale set at once.

**Runtime opt-in (P2).** The oracle-lane choice moved from an inline ternary in
`tests/test262-shared.ts` to `test262OracleLane()` in the same module. With
`TEST262_STANDALONE_LINKED` unset it is the old gate exactly
(`TEST262_ORACLE_MODE === "linked" && IS_HOST_LANE`; asserted over every
mode x target in `tests/issue-6723-p1-harness-cache-lane.test.ts`). With it
`=1`, `linked` is admitted on `TEST262_TARGET=standalone` only (not wasi/linear).

**Workflow (`test262-sharded.yml`).** New `workflow_dispatch` input
`standalone_linked` (default false) and three jobs, all
`if: github.event_name == 'workflow_dispatch' && inputs.standalone_linked`:

| job | does |
|---|---|
| `standalone-harness-provider` | builds the compiler bundle, runs `node --import tsx scripts/prewarm-test262-harness-providers.mjs --target standalone` (soft), uploads `.test262-cache/harness` as `standalone-harness-provider-<run_id>` |
| `test262-standalone-linked` (57 chunks) | the standalone cells' env + `TEST262_ORACLE_MODE=linked`, `TEST262_STANDALONE_LINKED=1`, `TEST262_RESULT_PREFIX=test262-standalone-linked`; downloads Temporal, runtime-eval and harness providers |
| `merge-standalone-linked-report` | validates 57/57, builds a report, runs `scripts/test262-linked-parity.mjs` vs the promoted standalone baseline (`fetch-baseline-jsonl.mjs --standalone`) and vs the same run's honest standalone cells; uploads `test262-standalone-linked-<sha>` |

A separate matrix rather than flipping the standalone cells of `test262-shard`:
renaming those cells' prefix would leave `merge-report` with no standalone rows.
`promote-baseline` gains `!(workflow_dispatch && inputs.standalone_linked)`, so a
shadow dispatch never promotes. With the input off: no new job is scheduled on
any event, no existing job's steps or env changed, nothing required `needs:` the
new jobs. `merge-report`'s `test262-*-shard-*` download may pick up the shadow
artifacts on a dispatch, but every merge step globs
`test262-{js-host,standalone}-shard-*` only (same as the honest-audit ones).

**Dispatch the shadow run:** Actions -> Test262 Sharded -> Run workflow on
`main`, check `standalone_linked`. Evidence: artifact
`test262-standalone-linked-<sha>` (`*-parity-vs-baseline.json`,
`*-parity-same-run.json`, merged jsonl/report).

**Local proof** (4-core box, `COMPILER_POOL_SIZE=3`, quickjs, 20 rows drawn
with `random.seed(6723)` from the P0 360-row sample; script `.tmp/proof.sh`,
local only):

- `prewarm --target standalone --limit 8` into a fresh dir: 8 providers, 0
  failed, 32.5 s (2.6-5.4 s each, all `cacheHit=false`), cache
  `.tmp/hc/bundle-7366cd118fa1a6d8`.
- prewarm over the 20 rows' dir: 5 prefixes, 4 `cacheHit=true`, 1 new
  (`asyncHelpers` set) built.
- linked run (`TEST262_STANDALONE_LINKED=1`, no file edit): 9/9 provider loads
  `cacheHit=true`, **0 cold builds, 0 timeouts**; 16 linked + 4 fallback rows;
  10 pass / 9 fail / 1 CE; **20/20 verdicts identical** to P0's
  `p0b-sa-linked` rows (the fails are the known D4 classes). Result file
  `benchmarks/results/p1proof-sa-linked-results-p1proof.jsonl` (local only).
- First attempt had every eval-using row fail with "quickjs provider is not
  built": the local QuickJS adapter is keyed on the compiler bundle; rebuilt
  with `node scripts/build-quickjs-eval-provider.mjs`. CI builds it per run.

## P2 shadow run (2026-09-29) — gate NOT met

First full-corpus measurement of the standalone linked lane in CI: dispatch run
36527277756 (`standalone_linked=true`, head `473c25a18c`, i.e. P0 + print slice,
**without** the D4 error-objects fix `41d1f40ecb`). Parity report from job
`merge standalone-linked evidence` (109281638893), artifact
`test262-standalone-linked-473c25a18cc6f99bbb4f416985a222125bfa563e`.

| status | honest (today's standalone lane) | linked (shadow) |
|---|---:|---:|
| pass | 41,464 | 31,285 |
| fail | 5,069 | 15,424 |
| compile_error | 2,066 | 1,878 |
| compile_timeout | 22 | 34 |

- Agreement 37,990 / 48,735 (77.95 %). **pass → fail 10,401**, fail → pass 222,
  other 122.
- Linked-lane fallbacks 10,047 (20.62 %): 4,603 Temporal rows (compiled honestly
  by design), the rest linked compile failures on body syntax
  (`Expression expected` 284, native generator lowering 281, rest-element
  diagnostics 555, dynamic array length fill 254, `__get_builtin` 186, …).
- Largest difference buckets: `[object Object]` 8,155 (the error-rendering /
  error-constructor class the D4 errors slice addresses), `undefined` 623,
  async "Expected a ReferenceError" 324, `value is not iterable` 259,
  provider-function call "Cannot access property on null or undefined" ~150,
  `illegal cast` in `testPropertyOfStrings` 95 (a trap bucket).
- Time: row-summed compile 174.7M ms honest vs 128.2M ms linked (**1.36×**);
  `Run shard` median 859 s honest vs 666 s linked (**1.29×**), totals 47,072 s vs
  35,612 s over 57 shards each.

### Gate verdict

The P2 gate (pass→fail no worse than the host flip, no trap bucket, median shard
≥ 2× faster) fails on all three counts. The D4 error-objects slice recovered 58
of 360 sampled rows (216 → 274, 0 pass→fail); extrapolated, the corpus still
loses several thousand passes, and the achievable speed-up is capped near 1.4×
while Temporal rows (8.45 of 38.8 core-hours) and body-syntax fallbacks compile
honestly. P3 (authority flip) is not justified by these numbers. The matrix
rebalance (#6722, merged) remains the standalone speed-up that is live.
## D4 slice: cross-module error objects (2026-09-29)

**Root cause — identity, not reading.** Provider-side probes on a
consumer-thrown `TypeError` (linked pair, standalone): `message`, `name`,
`String(e)` and `e instanceof TypeError` were all correct (the error struct is a
canonical type, so field reads and the tag-based `instanceof` already cross the
boundary). Only identity failed: `e.constructor` answers the module-local
`__builtin_TypeError` carrier global (#3130), each module has its own, so the
provider's answer was a different object from the body's `TypeError`
(`thrown.constructor !== expectedErrorConstructor`). When the provider's arm ran
before any provider-side bare `TypeError` read, it lazily minted a naked object
(`typeof` "object", no `name`) — hence "…but got a undefined".
`Test262Error` had a second, separate cause: the body binds it to the
provider's constructor (`var Test262Error = <getter>()`) but lowers
`new Test262Error(…)` to a body-local error struct (#2902), whose `constructor`
neither module mapped back to that binding (body and provider both answered
`Error`).

**Is this D4 option 2?** Only for the eight Error-family constructors, and
without an ABI beyond named globals: the fix shares the existing carrier
CELLS rather than building a shared intrinsic realm. Reported here so the lead
can object; no other intrinsic moves.

**Fix.**
- `src/codegen/standalone-link-error-ctor-cells.ts` (new): a wasm-consumed
  standalone provider exports its eight `__builtin_<Name>` globals (mutable
  externref) as `__js2wasm_link_error_ctor_<Name>`; a standalone consumer that
  links a provider imports them as its own carriers, registered in
  `builtinObjectGlobals` before its first defined global (called right after
  `createCodegenContext` in both drivers; declines, i.e. keeps local carriers,
  if the window has passed). Every reader in both modules — the bare-identifier
  read and the `err.constructor` arm — already goes through that map with the
  same lazy materialise-if-null guard, so one cell = one constructor object per
  graph, first reader wins, nothing materialised eagerly. Consumer → provider
  import direction for the #5383 S2m reason (provider is compiled and cached
  first; no cyclic imports). Cost: every standalone provider (harness and npm
  packages) now carries up to eight extra null-initialised globals + exports.
- `Test262Error`: `userErrorCtorCarrierGlobal` returns the module global for a
  standalone module with linked package bindings when no function declaration
  exists (the body's prelude `var` IS the provider's constructor); the
  provider's `$Error_struct` `constructor` arm is built in every wasm-consumed
  standalone provider (`userErrorCtorArmApplies`), so it also answers for
  structs its consumer minted.
- `scripts/test262-worker.mjs`: a consumer render of exactly `[object Object]`
  is treated as "not mine" when a linked peer renders the payload (a
  provider-minted `Test262Error` has its `toString` on the provider's
  prototype). Message-only; the verdict logic is untouched.
- No host import: consumer `result.imports` stays `[]` (asserted in the test).

Unit test `tests/issue-6723-standalone-linked-errors.test.ts` (6 cases; 5 fail
on the base tree with exactly the messages above, all pass with the fix; also
pass with `.test262-cache/runtime-eval-refusal-*.wasm` and the quickjs adapter
moved away).

### Measurement — same 360 rows, same procedure as P0 / the print slice

Base = origin/main 3c9d85424a + the print slice (PR #6298, cherry-picked).
Fresh harness cache per run, `COMPILER_POOL_SIZE=3`, quickjs eval (adapter
rebuilt per compiler state), linked arm gated on by file copy, never
committed. Result files (local only):
`benchmarks/results/d4ebase2-{sa-linked,sa-honest,host-linked}-results-*.jsonl`
(base), `d4efin2-*` (this slice, final code incl. the worker render change),
`d4efin-*` (this slice before the render change — identical verdicts on all
three arms).

| arm | pass | fail | CE | timeout | rows linked |
|---|---:|---:|---:|---:|---:|
| standalone linked, base (`d4ebase2-sa-linked`) | 216 | 134 | 10 | 0 | 309 |
| standalone linked, fix (`d4efin2-sa-linked`) | **274** | 75 | 10 | 1 | 309 |
| standalone honest, base (`d4ebase2-sa-honest`) | 316 | 32 | 12 | 0 | — |
| standalone honest, fix (`d4efin2-sa-honest`) | 316 | 32 | 12 | 0 | — |
| host linked, base (`d4ebase2-host-linked`) | 302 | 57 | 1 | 0 | 316 |
| host linked, fix (`d4efin2-host-linked`) | 302 | 57 | 1 | 0 | 316 |

- Standalone linked: **58 fail→pass, 0 pass→fail**, 1 fail→compile_timeout
  (`TypedArray/prototype/map/return-new-typedarray-from-positive-length.js`,
  the run's first row, cold provider build while gate scripts were running on
  the same 4 cores; it is `fail` in both `d4ebase2` and `d4efin`).
- Standalone honest and host linked: **0 verdict diffs**.
- Non-pass rows whose error still reads `[object Object]` because the payload
  could not be rendered: 99 → 0 (the 3 remaining `[object Object]` strings
  are genuine `sameValue` messages).

Target rows (the P0 table's classes, re-derived as honest-pass ∧ P0-linked-fail
from `p0new-sa-honest` / `p0b-sa-linked`: exactly 39 + 27; plus the print
slice's 3 async rows):

| class | rows | pass now | still failing |
|---|---:|---:|---:|
| `assert.throws` constructor → `undefined` | 39 | 37 | 2 |
| payload not renderable (`[object Object]`) | 27 | 17 | 10 |
| async "Expected a ReferenceError but got a undefined" | 3 | 3 | 0 |

(57 of the 58 flips are these rows; the 58th is
`class/dstr/async-gen-meth-dflt-obj-ptrn-prop-id-init-unresolvable.js`.)

The 12 still failing now report their real cause, each another named class:

| rows | now reports | class |
|---:|---|---|
| 4 | `…Expected a Test262Error but got a TypeError` (`assignment/dstr/array-empty-iter-close-err`, `class/dstr/gen-meth-static-ary-ptrn-elem-id-iter-val-err`, `object/dstr/async-gen-meth-dflt-ary-ptrn-elem-id-iter-val-err`, `variable/dstr/ary-ptrn-elem-id-iter-step-err`) | D4 iterator class: a body-local `g[Symbol.iterator]` object destructured in the linked body throws "value is not iterable" (probe: same with `RangeError`, so not error-related) |
| 4 | `TypedArray/prototype/set/array-arg-return-abrupt-from-src-get-length`, `TypedArrayConstructors/{ctors/object-arg/throws-from-property,from/iter-access-error,internals/Set/key-is-not-numeric-index-set-throws}` | D4 TypedArray class: the provider's `TA` constructors used from the body (`sample.set` throws TypeError; the direct body-local repro passes) |
| 2 | `Object/defineProperties/15.2.3.7-6-a-283`, `Object/defineProperty/15.2.3.6-4-538-6` (descriptor assertion messages) | D4 `verifyProperty` descriptor class |
| 1 | `Map/iterator-items-are-not-object`: "no exception was thrown" | body-local: `new Map([Symbol("a")])` does not throw in the linked body (the other six sub-cases do) — not an error-object defect |
| 1 | `annexB/.../indirect/global-if-decl-else-stmt-eval-global-skip-early-err-block`: thrown value renders `undefined` | indirect-eval global declaration under the linked lane; not diagnosed further (the unit harness has no eval engine) |

### Still open (not this slice)

- D4 iterator, TypedArray and `verifyProperty` classes (above).
- Cross-module construct/call of a provider closure VALUE from the body
  (`new MyCtor()` with `function MyCtor` in the provider throws; the print
  slice saw the call twin). Not needed here — `new Test262Error` keeps the
  body-local struct and only its `constructor` was re-pointed — but it is why
  routing that `new` through the provider was not an option.
- The naked-object lazy materialisation in the `err.constructor` arm (a
  `constructor` read before any bare-identifier read yields an object without
  `name`/`prototype`) is pre-existing and single-module too (#4262 "ordering
  residual"); sharing the cells makes the body's `TypeError` argument, which
  is evaluated first, the usual winner.
