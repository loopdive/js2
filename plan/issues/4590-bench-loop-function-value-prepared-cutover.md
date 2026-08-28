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

## Completion evidence

- `tests/issue-4590-bench-loop-prepared-cutover.test.ts`: 21/21 passed.
- `tests/issue-4589-multi-prepared-scalar-leaf.test.ts`: 15/15 passed.
- `tests/issue-2138-multi-module-ir-overlay.test.ts`: 6/6 passed (with the
  Vitest fork heap raised above its default 512 MB ceiling).
- Typecheck, Prettier, LOC/function/oracle/fallback/format/diff gates: passed
  without allowances.
