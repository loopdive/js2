---
id: 4590
title: "Cut the exact bench_loop function-value leaf over to Prepared IR"
status: done
created: 2026-08-21
updated: 2026-08-21
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

## Completion evidence

- `tests/issue-4590-bench-loop-prepared-cutover.test.ts`: 21/21 passed.
- `tests/issue-4589-multi-prepared-scalar-leaf.test.ts`: 15/15 passed.
- `tests/issue-2138-multi-module-ir-overlay.test.ts`: 6/6 passed (with the
  Vitest fork heap raised above its default 512 MB ceiling).
- Typecheck, Prettier, LOC/function/oracle/fallback/format/diff gates: passed
  without allowances.
