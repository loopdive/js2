---
id: 3498
title: "Landing benchmark: four honest backend/runtime lanes"
status: ready
sprint: current
created: 2026-07-20
updated: 2026-07-20
priority: high
horizon: xl
complexity: L
feasibility: hard
reasoning_effort: max
task_type: performance
area: benchmarking, ir, codegen-linear, website, ci
goal: backend-agnostic-ir
depends_on: [3482, 3497, 3499, 3500, 3501, 3502]
related: [1760, 1764, 3288, 3336]
origin: "2026-07-20 user request to implement the landing-page four-lane backend benchmark"
---

# #3498 — Landing four-lane backend benchmark

## Objective

Benchmark the exact checked-in `fib.js`, `fib-recursive.js`, `array-sum.js`,
and `string-hash.js` sources through Node/V8, JS2 WasmGC under the existing
Wasmtime/Cranelift host, JS2 typed SSA/shared `LinearMemoryPlan` through Porffor
IR to Clang/native, and pinned plain Porffor to Clang/native. `object-ops.js` is
out of scope. The output must distinguish valid measurements from unsupported
or sanitizer-contaminated cells without ranking silently different semantics.

## Methodology

- Reuse the current landing corpus and Wasmtime generator plus #3482's generic
  exact-source, direct-native, sanitizer, and reporting helpers; do not copy or
  rewrite sources and do not narrow shared linear-memory IR.
- Hash and oracle every source. Validate each executable at `coldArg`,
  `runtimeArg`, and deterministic fixed inputs before accepting samples.
- Keep build, startup, cold-first-call, and warm steady-state evidence separate.
  Retain commands, versions, source SHA/bytes, phase timings, CPU/wall/RSS,
  artifact sizes, and raw interleaved samples (5 warmup + 21 measured where
  practical). Disclose any retained compatibility methodology.
- Keep Porffor optional. Preserve pinned plain-Porffor accesses except the
  existing LP64 printf normalization and run ASan/UBSan separately. Plain-lane
  UBSan makes optimized timing non-authoritative; JS2-native supported rows
  must be sanitizer-clean.

## Support-matrix semantics

The machine-readable result contains exactly one cell for each of four kernels
and four lanes. A cell is `supported`, `unsupported`, or
`unsafe-non-authoritative`. Unsupported cells have no timing value and include
a stable phase, diagnostic code, evidence, and follow-up when needed. Missing,
skipped-success, empty-success, and numeric-zero sentinel cells are invalid.

## Slices

1. Generalize the #3482 adapter through an additive API, publish the canonical
   corpus descriptor, and land a schema/oracle/support probe while preserving
   all #3482 hashes and behavior.
2. Execute and sanitize all four lanes for `fib` and `fib-recursive`, fixing
   only narrow backend-neutral defects that are safe in this PR.
3. Probe both native routes for arrays and strings; measure correct support or
   retain evidence-backed blocked cells and allocate focused follow-up plans.
4. Add the artifact-only/manual Ubuntu capture, documentation, package commands,
   and landing integration supported by the honest matrix. PR CI runs focused
   correctness/support/sanitizer probes; no performance thresholds are added.

## Acceptance criteria

- [x] The four canonical source files are the sole corpus, with asserted bytes,
      hashes, Node oracles, and no source substitution or silent omission.
- [x] Node/V8 and JS2 WasmGC/Wasmtime execute all four kernels correctly.
- [x] Both Porffor routes execute `fib` and `fib-recursive`, or a concrete
      compiler defect is represented by an explicit blocked cell and planned
      follow-up after any safe minimal fix is considered.
- [x] Arrays and strings are probed through both Porffor routes and are either
      correct measurements or explicit evidence-backed blocked cells with
      follow-up issues.
- [x] Focused `tests/issue-3498*.test.ts` cover schema completeness, exact-source
      identity, output equality, unsupported semantics, and sanitizer authority.
- [x] Documentation discloses frontend, ABI, runtime, optimizer, allocator, and
      measurement confounders; the manual workflow retains full artifacts and
      applies no speed threshold.

## User origin

Requested directly by the project owner on 2026-07-20, including the canonical
four-file corpus, exact four lanes, methodology constraints, minimum landing
slice, branch/claim workflow, and non-draft upstream PR handoff.

## Implementation notes

Current-main legality and implementation evidence:

- Exact Node oracles match the pinned hashes, byte counts, cold inputs, runtime
  inputs, and additional fixed inputs in the shared corpus descriptor.
- JS2 WasmGC executes all four sources under Wasmtime/Cranelift when the
  existing landing compatibility path is selected consistently with
  `experimentalIR:false`. The helper shared with
  `generate-wasmtime-hot-runtime.mjs` records the feature, normalization,
  precompile, and run commands.
- `compile(target:"linear", allocator:"analysis-stack", fileName:<exact path>)`
  selects no `run` function on current main. `fib`, `array-sum`, and
  `string-hash` reject `run` as `select:return-type-not-resolvable`;
  `fib-recursive` rejects both `fib` and `run` with the same code.
  `string-hash` additionally reports direct-codegen unsupported `.charAt()` and
  `.charCodeAt()` diagnostics. The first backend-neutral gap is JSDoc
  `@returns {number}` recovery, exclusively owned by #3497; this issue does not
  edit `src/ir/select.ts` or duplicate that fix.
- #3497 is proposed in PR #3446 (reported head `383d6b146`). Its current probe
  enables exact-source `fib` selection; `fib-recursive` then remains blocked by
  the unannotated internal `fib`, `array-sum` reaches empty-array element
  inference, and `string-hash` reaches the existing string-method gaps. #3498
  remains based on current-main behavior until that PR lands, then re-probes
  the landed code rather than cherry-picking the dependency.
- A disposable integration probe at #3446 head `383d6b146` confirmed those
  diagnostics and exposed one additional `fib` boundary:
  `lowerIrModuleToPorffor` rejects typed `js.bitor` before composite-op
  lowering. Follow-up plans are #3499 (typed bitwise), #3500 (recursive
  call-graph evidence), #3501 (empty-array element inference), and #3502
  (shared string construction/method lowering).
- Pinned plain `porf c --module -O1` succeeds for all four exact files. Untouched
  C sizes are respectively 182500, 183257, 211942, and 188200 bytes. Optimized
  Clang executables match all Node outputs. Separate ASan/UBSan probes reproduce
  a misaligned `f64` store in every plain-Porffor row, so all optimized values
  are classified UB-contaminated and non-authoritative.
- The additive generic #3482 adapter parameterizes only the exported unary
  function and source parameter. The canary wrapper retains its exact index,
  ABI assertions, safety checks, command model, hashes, and tests.
- Benchmark capture pins the Wasmtime CLI and embedded host to 46.0.1 and the
  host compiler/toolchain to exact Rust/Cargo 1.94.1 (`rust-version = "1.94"`
  in the host manifest). Its checkpoint identity includes the rebuilt host and
  exact 6-warmup/9-measured median configuration. Resume and final validation
  enforce the phase/round rotation formula, so a valid-looking permutation
  cannot be reused under a different interleave schedule.

Why the native JS2 cells are blocked instead of patched here: without a
selected source-derived function there is no typed SSA or shared
`LinearMemoryPlan` to lower. Fabricating or reparsing one in the benchmark
would silently change the requested lane and duplicate #3497. The 16-cell
schema therefore retains each rejection and points to #3497. Arrays and strings
are still probed through both native routes; any post-#3497 legality gaps will
be allocated from those concrete follow-on diagnostics rather than guessed in
this PR.
