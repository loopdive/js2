---
id: 6723
title: "test262: give the standalone lane the linked-harness oracle — compile the harness prefix once per include-set on standalone too (standalone is ~82 % of merge_group test262 work)"
status: ready
sprint: current
priority: high
horizon: l
goal: maintainability
reasoning_effort: max
requested_by: ttraenkler/opus-lead
created: 2026-09-28
related: [3451, 6486, 6492, 5383, 5407, 6722, 6676]
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
