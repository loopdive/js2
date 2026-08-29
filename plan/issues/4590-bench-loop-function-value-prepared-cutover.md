---
id: 4590
title: "Cut the exact bench_loop function-value leaf over to Prepared IR"
status: done
created: 2026-08-21
updated: 2026-08-28
completed: 2026-08-21
priority: critical
feasibility: medium
reasoning_effort: high
task_type: refactor
area: compiler, codegen, ir
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
loc-budget-allow:
  - src/codegen/index.ts
parent: 3525
depends_on: [2138, 3520, 4589]
related: [3090, 3518, 3520, 3525, 3792, 4583, 4589, 4591]
assignee: ttraenkler/codex
files:
  - src/codegen/index.ts
  - src/codegen/multi-prepared-function-value-import-target.ts
  - src/codegen/multi-prepared-scalar-leaf.ts
  - tests/issue-4590-bench-loop-prepared-cutover.test.ts
  - plan/issues/4590-bench-loop-function-value-prepared-cutover.md
---

# #4590 — cut the exact bench_loop function-value leaf over to Prepared IR

## Problem

The real `website/playground/examples/benchmarks/loop.ts` graph already lowers
`bench_loop` through IR, but it previously emitted the direct AST body first.
That left both `compileFunctionBody` and `compileStatement` on the physical
route. Unlike #4589's scalar leaf, `bench_loop` is also read as a function value
by legacy `main` and passed to the imported `addBenchCard` helper. Prepared IR
therefore cannot skip its body until the exact target callable, trampoline, and
closure-cache global exist and are owned by Program ABI.

## Scope

- Recognize only one graph-wide, no-parameter numeric reduction function with
  the exact eight-way `| 0` loop shape used by the real benchmark.
- Require a singleton direct-call component and exactly one non-call function
  value reference in a distinct legacy owner.
- Require that reference to be one argument of a direct named import call. Join
  the exact `ImportSpecifier` to one canonical relative source record, require
  one direct exported bodyful target before oracle certification, and reject
  merged or ambiguous declaration populations.
- Preallocate the exact `bench_loop` source callable plus one
  `__fn_tramp_bench_loop_cached` / `__fn_closure_bench_loop` support pair before
  Prepared sealing. Carry their allocator objects, handles, binding IDs, and
  locators through the late overlay and re-prove them after legacy owners run.
  At that same seam, re-prove the candidate declaration, value-reference
  parent/oracle identity, enclosing legacy-owner declaration/UnitId, and
  imported callee target/UnitId from the frozen receipt.
- Carry the one Prepared report and skipped UnitId through the existing #4589
  late completion seam exactly once. The #4589 syntactic scalar predicate and
  late-provider exclusion set remain unchanged.
- Keep the route default-on with
  `JS2WASM_MULTI_PREPARED_BENCH_LOOP_CUTOVER=0` as the true pre-#4590 artifact
  rollback.

## Non-goals

- Generic callable-value routing, imported-call planning in the standalone
  host-disabled lane, or name-based `bench_loop` authorization.
- The Fibonacci pair. `bench_fib` and `fib` form a two-terminal recursive
  component and require a later atomic cutover (#4591).
- Cross-source callable components, stored or repeated function values,
  module initialization, classes, derived units, CommonJS, fast, WASI, or
  default host/GC ownership.
- Hiding allocation-order changes by preallocating support when the public
  kill switch is disabled. The switch intentionally remains the old baseline.

## Acceptance criteria

- [x] The default route survives a poisoned direct `bench_loop` body; the
      dedicated kill switch restores the poison and both physical entries.
- [x] The exact audit moves from 16 to 14 total legacy rows and from 14 to 12
      non-`compileDeclarations` rows. Only `bench_loop`'s
      `compileFunctionBody` and `compileStatement` rows disappear.
- [x] The target disposition is `terminal-ir`, with
      `legacyBodyEmitted: false`, `irBodyEmitted: true`, and one nonempty
      Prepared component ID.
- [x] Raw `bench_loop` instructions are exact against the old control. Both the
      target and inlined trampoline retain eight reduction accumulators and the
      125,000-trip unrolled loop.
- [x] Raw and optimized DTS, import descriptors/helper, Wasm imports/exports,
      and string pool are exact. Raw and optimized runtime both return
      `1783293664`.
- [x] Optimized target and trampoline bodies are exact against the old control;
      the preserve-names optimized artifact does not grow.
- [x] Program ABI retains the same source/trampoline/cache binding contracts
      and one exact object per role in both lanes. Each lane certifies its own
      final slots; this is not a claim of cross-lane support-slot parity.
- [x] Unsupported sealing withdraws before skip. Altered loop/import/value
      flow, extra direct callers, support-name collisions, and module-init
      shapes stay direct-owned. Post-certification support tampering is an
      Invariant.
- [x] Renaming every declaration/use of `bench_loop` preserves the Prepared
      route and still bypasses a poisoned renamed direct body; no source name
      allowlist participates in eligibility.
- [x] Default GC, fast, WASI, IR-first-disabled, and IR-disabled controls stay
      direct-owned. The adjacent #4589 and #2138 suites remain green.

## Measured checkpoint

The public kill-switch control is byte-identical to parent `f78fa8c34a0567`:
115,072 raw bytes, SHA-256
`7792f5445cf8ab65885fbb63922638f513903eff4b5924866940e517fdf1735d`,
with both legacy rows present. The Prepared artifact is 115,037 bytes, SHA-256
`b7d9f0147aa483851029c99173791107f3515812e16aa3d42bcc36269b6408a8`.
The intentional 35-byte reduction comes from allocating the required support
pair before Prepared sealing: the trampoline moves from raw type 66 / late
inliner prefix 226 to type 61 / early prefix 22. Normalizing those allocator
labels leaves the raw trampoline body exact; `bench_loop` itself is text-exact.

With `optimize: true` and preserved names, both lanes are 50,363 bytes. Binaryen
prints text-exact optimized bodies for `bench_loop` and its trampoline, and
both return `1783293664`. Whole-module hashes are deliberately not claimed:
the required preallocation changes internal type/function order while leaving
the target bodies and external contract exact.

Program ABI binding-contract parity is exact. The source callable remains
function slot 76 in both lanes with signature `[] -> f64`. The Prepared lane's
preallocated trampoline/cache resolve to function/global slots 78/10; the true
old control resolves the same binding roles to 252/129. Each final slot points
to the single expected allocator object, the trampoline signature agrees with
its published callable intent, and the cache is one mutable `externref` global.

## 2026-08-28 current-main pin maintenance and telemetry-only control

Unrelated allocator growth since the original landing changed the physical
whole-module positions while leaving every semantic #4590 invariant intact.
On current `main` at `48abcb949c9d1b539cb58472256e4545cacd9dc8`, under the
strict 10-core load gate (`finite, non-negative load < 8`), the exact raw
artifacts are now:

- Prepared: 131,207 bytes, SHA-256
  `8cd1ba375acef40b417be2aa534065c865eda06072a14c6911ba453ec22227e8`;
- direct kill-switch control: 131,235 bytes, SHA-256
  `935b394bced571155c15a889a488ed449ce395dea3e10d6f50f3bfc1e5eddb88`;
- exact Prepared reduction: 28 bytes, replacing the obsolete 35-byte pin;
- Prepared source/trampoline/cache slots: `76 / 78 / 10` (unchanged); and
- direct source/trampoline/cache slots: `76 / 290 / 136`, replacing the
  obsolete `76 / 252 / 129` physical positions.

Both lanes contain exactly 321 defined functions and 165 globals. The existing
raw/optimized target and trampoline body equality, Program ABI binding IDs and
intents, exact singleton allocator objects, signatures, import/export surface,
string pool, DTS/helper, binary validity, and runtime result remain the
authority. Update only the obsolete physical pins after remeasuring them on the
rebased implementation head. Do not replace them with inequalities, derive the
expected slots from the actual objects under test, or relabel allocator drift
as a size regression.

The M0 telemetry lifecycle defect tracked by #3525 is independently
non-vacuous in `tests/issue-3525-multi-prepared-program-census.test.ts`: with
`experimentalIR: false`, `trackIrOutcomes: true`, and a poisoned direct body,
compilation must reach and report the exact direct-body poison rather than stop
earlier with `multi-prepared-program:completion-order`. The production repair
belongs only to #3525's telemetry-only owner lifecycle; #4590 must not bypass
the owner, disable tracking, or accept the lifecycle error as expected output.

Carry this pin-only maintenance in the same #3525 repair checkpoint because
the mandatory changed-root hook selects the full #4590 suite and current
`main` already fails its two obsolete physical assertions. This is not an
allowance: require #4590 to return to 21/21 before the commit, then run its
adjacent #4589, #4591, #3525, #3518, and #2138 controls, TypeScript 7 and 5, IR
fallback/layering/dialect/optimization gates, and the LOC and function ratchets
immediately before the signed commit. After #3525 merges, refresh and rebase the
separate declaration-snapshot checkpoint onto these maintained pins. No
baseline, LOC, function, precommit, or prepush exception is authorized.

## 2026-08-28 CI optimizer-refusal oracle

PR #5165's Linux `quality` job exposed a second environment-sensitive test
assumption after every production and telemetry assertion passed. The
changed-root lane compiled both `optimize: true` controls successfully but
returned their original binaries: Prepared was 131,207 bytes and direct was
131,235 bytes. The existing optimized-only equality then compared those two
raw artifacts and failed 20/21. The same head passes 21/21 locally with and
without `JS2WASM_EVAL_ENGINE=interpreter`, so the engine label is not the
oracle. The compiler's explicit `wasm-opt` fallback warning and byte retention
are.

Repair only the optimized-parity test and this plan. Compile one raw control
for each lane alongside the two optimize-request controls, then classify the
result from exact compiler evidence. Both raw lanes already carry ten canonical
#2961 host-import warnings. Require each optimize-request diagnostic population
to begin with the byte-for-byte exact diagnostics of its own raw control, and
classify only the remaining optimizer-added suffix; a changed, missing, or
reordered pre-existing diagnostic is a failure, not optimizer evidence. Pin the
raw authority as exactly ten ordered warnings with their exact severity/message
sequence and every stable source-position field (`line`, `column`, `code`, and
the expected `ENTRY`/`HELPERS` file identity where present). Merely proving two
equally empty or equally drifted raw populations is not sufficient.

- When neither optimize-request result carries a `wasm-opt` fallback warning,
  retain the existing optimized authority unchanged: Prepared/direct binary
  sizes, `bench_loop`, and trampoline bodies are exact, both bodies retain the
  125,000 literal, and all surfaces/runtime remain exact.
- When optimization is explicitly refused, require both lanes to carry the
  same single recognized `wasm-opt` fallback warning as their diagnostic
  suffix. Reject an asymmetric, duplicate, unrelated, or unrecognized
  optimizer delta. Compare the complete suffix diagnostic rows across lanes,
  including source anchoring and optional code/file fields; use the message
  only to recognize the authorized fallback class. Because this test requests
  the default O3 pass, a process-failure warning is recognized only as
  `wasm-opt -O3 failed: ...`, never another optimization level. Prove each
  optimize-request binary is byte-for-byte identical to its own separately
  compiled raw control; pin the raw sizes at
  131,207 and 131,235 and the exact Prepared reduction at 28 bytes. In this
  arm, require the raw `bench_loop` bodies to remain text-exact and compare
  trampolines only through the existing `normalizedRawTrampoline`
  allocator-label normalization. Keep the 125,000 literal, public surface,
  DTS/helper, string pool, validity, and runtime checks on both lanes.
- Select the WAT authority only after the certified optimizer disposition is
  known. The optimized arm continues to parse the optimized binaries with
  Binaryen. The fallback arm must use `rawPrepared.wat` and `rawDirect.wat`
  from the separately compiled raw controls, after byte-for-byte equality has
  proved that each optimize-request result retained that exact raw binary.
  Do not feed the raw GC bytes back through `binaryen.readBinary`: Linux
  Binaryen rejects their distinct recursive groups without an explicit GC
  parser feature before the body oracle can run. Do not enable a global parser
  feature or waive the body checks merely to make this harness path parse.
- Do not branch on `CI`, operating system, `JS2WASM_EVAL_ENGINE`, size
  coincidence, or a loose inequality. Do not derive an expected byte count
  from the result under test. A warning without exact raw-byte retention, raw
  bytes without an authorized warning, or mixed optimized/refused lanes must
  fail closed.

Keep the classifier mutations in the test itself. They must reject an equally
empty/drifted raw warning population, missing/asymmetric/duplicated suffixes,
wrong severity, wrong source anchoring, unrelated/unrecognized messages, mixed
recognized fallback messages, and fabricated O0/O9 process-failure warnings.

Run #4590 in both the ordinary local lane and the explicit interpreter-labelled
lane after the edit. Then repeat the #3525/#4590/#4591 changed-root set, the
adjacent controls, LOC and function ratchets immediately before the signed
commit, and the complete precommit and prepush hooks. Keep PR #5165 ready for
review (not draft) and re-enqueue it only through the protected merge queue.

## Completion evidence

- `tests/issue-4590-bench-loop-prepared-cutover.test.ts`: 21/21 passed.
- `tests/issue-4589-multi-prepared-scalar-leaf.test.ts`: 15/15 passed.
- `tests/issue-2138-multi-module-ir-overlay.test.ts`: 6/6 passed (with the
  Vitest fork heap raised above its default 512 MB ceiling).
- Typecheck, Prettier, LOC/function/oracle/fallback/format/diff gates: passed
  without allowances.

## 2026-08-28 pin remeasurement carried by the #4617 C1 checkpoint

Three physical pins in `tests/issue-4590-bench-loop-prepared-cutover.test.ts`
were obsolete on current `main` `f6c8e2ceaaa6dbaf0004596eb32dbe0a6d09310f` and
failed there before the #4617 C1 branch existed (18/21, exactly these three).
Remeasured on that clean tree and updated:

- raw Prepared bytes 131,207 to **133,067**;
- raw direct bytes 131,235 to **133,096**;
- the exact Prepared reduction 28 to **29** bytes;
- the direct cache global slot 136 to **139**.

Prepared and direct byte counts are identical with and without the C1 branch, so
this is unrelated allocator growth on `main`, not a route change. Source /
trampoline / cache slots 76 / 78 / 10 (Prepared) and the direct 76 / 290
source and trampoline slots are unchanged, as are every body, binding, surface,
and runtime authority. The suite grew from 21 to 26 tests: the five added cases
are the #4617 C1 positive replay, anti-vacuity poison control, armed-but-
unmatched injection, live-lane versus replay-lane parity, and post-certification
snapshot tamper. The 16-case one-fact mutation matrix lives in
`tests/issue-4617-declaration-replay-mutations.test.ts` so one CI fork's 512 MB
heap is not asked to hold ~40 compilations of the real benchmark graph.
