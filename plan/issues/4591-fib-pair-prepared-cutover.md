---
id: 4591
title: "Cut the exact Fibonacci call component over to Prepared IR"
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
depends_on: [2138, 3520, 4590]
related: [3090, 3214, 3518, 3520, 3525, 3792, 4589, 4590]
assignee: ttraenkler/codex
files:
  - src/codegen/index.ts
  - src/codegen/multi-prepared-fibonacci-pair.ts
  - src/codegen/multi-prepared-function-value-import-target.ts
  - src/codegen/multi-prepared-scalar-leaf.ts
  - tests/issue-4591-fib-pair-prepared-cutover.test.ts
  - plan/issues/4591-fib-pair-prepared-cutover.md
---

# #4591 — cut the exact Fibonacci call component over to Prepared IR

## Problem

The real `website/playground/examples/benchmarks/fib.ts` graph already lowers
`fib` and `bench_fib` through IR, but both direct AST bodies are emitted first.
The pair is one recursive direct-call component: `fib` self-recurses and
`bench_fib` calls it. In addition, legacy `main` passes `bench_fib` as a
function value to imported `addBenchCard`, so an atomic Prepared cutover must
certify both source callables and the outer target's trampoline/cache support
before either direct body is skipped.

## Scope

- Recognize only the exact two-member Fibonacci component in the standalone
  entry source, using checker and Program ABI identity rather than names.
- Prepare both terminals as one component and skip both only after the exact
  source callables plus `bench_fib` function-value support are certified.
- Re-prove the component, call/value edges, allocator objects, bindings, and
  locators after every remaining legacy owner has run.
- Keep the route default-on with
  `JS2WASM_MULTI_PREPARED_FIB_PAIR_CUTOVER=0` as the exact pre-#4591 rollback.

## Non-goals

- Generic recursive-component routing, arbitrary Fibonacci-like syntax, or
  name-based authorization.
- Cross-source components, stored/repeated function values, module-init
  ownership, classes, derived units, CommonJS, fast, WASI, or default host/GC.
- Widening #4590's singleton reduction route or removing late-provider
  exclusions without an exact replacement proof.

## Acceptance criteria

- [x] Dual direct-body poison is red on the old route and green only when both
      `fib` and `bench_fib` are skipped atomically.
- [x] The real audit moves from 18 to 14 total physical rows and from 16 to 12
      non-`compileDeclarations` rows; only the two body/statement pairs vanish.
- [x] Both terminals are `terminal-ir`, share one nonempty Prepared component
      ID, and report IR emitted with no legacy body.
- [x] Raw and optimized `fib`, `bench_fib`, and outer trampoline bodies retain
      exact old-control behavior; DTS/import/export/string-pool surfaces agree.
- [x] Raw and optimized runtime returns `832040`, and the optimized artifact
      does not grow.
- [x] Program ABI proves the exact source callable objects for both terminals
      and exactly one outer trampoline/cache support pair in both lanes.
- [x] The public kill switch reproduces the measured pre-#4591 artifact.
- [x] Shape, edge, value-flow, collision, reassignment, module-init, mode, seal,
      and post-certification tamper negatives all fail closed before skip.

## Measured checkpoint

The kill-switch control is the exact pre-#4591 artifact: 114,844 raw bytes
with SHA-256
`1d9d913d021eded3d9f9e9349bd3dbe095836e9daec4f8fa53e7c27ae3c6a4e3`;
its WAT SHA-256 is
`2575b086c93e14277b2cf43c837f7d944cb61e093d11c17034175d07afa23825`
and DTS SHA-256 is
`874ff64e8642ca4d5d1060091ab7d78a9ab0eda374e483e5c028115ad71c2022`.
The Prepared raw artifact is 114,795 bytes with binary SHA-256
`f8fd3ebf0c9eb748d12e64780932b65b859077f2a13cd62ea984c23f90698189`,
WAT SHA-256
`b5c9798b6dbecadb2d89433b7686ea4302e841720e4c41bdc3cac7b1e348a7be`,
and the same DTS hash. Early support allocation accounts for the 49-byte
reduction and the deliberate whole-module hash difference. The `fib` and
`bench_fib` raw bodies are text-exact. The outer trampoline is text-exact after
normalizing only its allocator-chosen type number and inliner prefix; its
instructions are unchanged.

With default name-stripped optimization, both lanes are 48,521 bytes. The old
control SHA-256 is
`4e8f66606a18497ad7c11d4a65e14dd120b69caa825bf7a3c6e1738fbc4d2837`.
The Prepared SHA-256 is
`69e58bd6a56438e857d02707f3dce704b7650a5d0bc3cf34f9df511609444f88`.
With debug names preserved, both lanes are 50,123 bytes. The Prepared SHA-256
is `3a3b4e233a1354467aea227eb75c2a6271239cca8007c6e6fed744de9e481ab4`;
the control SHA-256 is
`6493d10768439d3826384a4bf2b20e298bdbaea61b876b8ec1aba14083d3131f`.
Binaryen prints text-exact `fib`, `bench_fib`, and outer-trampoline bodies.
Both raw and optimized lanes return `832040`; `fib(10)` independently returns
`55`.

Program ABI resolves `fib`/`bench_fib` to function slots 76/77 in both lanes.
The Prepared lane resolves the preallocated `bench_fib` trampoline/cache to
function/global slots 79/10; the exact old control resolves the same binding
roles to 253/129. Each final slot points to the one expected allocator object,
and only `bench_fib` owns a trampoline/cache pair. The source and support
callable signatures agree with their published intents; the cache is one
mutable `externref` global.

## Completion evidence

- `tests/issue-4591-fib-pair-prepared-cutover.test.ts`: 27/27 passed with a
  512 MiB V8 heap cap and one Vitest worker.
- The added recursive-member non-call reference leaves both exact function
  bodies intact, withdraws the entire component before skip, and reproduces
  both direct-body poisons.
- `tests/issue-4590-bench-loop-prepared-cutover.test.ts`: 21/21 passed.
- `tests/issue-4589-multi-prepared-scalar-leaf.test.ts`: 15/15 passed.
