---
id: 4591
title: "Cut the exact Fibonacci call component over to Prepared IR"
status: in_progress
created: 2026-08-21
updated: 2026-08-21
priority: critical
feasibility: medium
reasoning_effort: high
task_type: refactor
area: compiler, codegen, ir
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
parent: 3525
depends_on: [2138, 3520, 4590]
related: [3090, 3214, 3518, 3520, 3525, 3792, 4589, 4590]
assignee: ttraenkler/codex
files:
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

- [ ] Dual direct-body poison is red on the old route and green only when both
      `fib` and `bench_fib` are skipped atomically.
- [ ] The real audit moves from 18 to 14 total physical rows and from 16 to 12
      non-`compileDeclarations` rows; only the two body/statement pairs vanish.
- [ ] Both terminals are `terminal-ir`, share one nonempty Prepared component
      ID, and report IR emitted with no legacy body.
- [ ] Raw and optimized `fib`, `bench_fib`, and outer trampoline bodies retain
      exact old-control behavior; DTS/import/export/string-pool surfaces agree.
- [ ] Raw and optimized runtime returns `832040`, and the optimized artifact
      does not grow.
- [ ] Program ABI proves the exact source callable objects for both terminals
      and exactly one outer trampoline/cache support pair in both lanes.
- [ ] The public kill switch reproduces the measured pre-#4591 artifact.
- [ ] Shape, edge, value-flow, collision, reassignment, module-init, mode, seal,
      and post-certification tamper negatives all fail closed before skip.

## Measured checkpoint

The pre-#4591 control is 114,844 raw bytes with SHA-256
`1d9d913d021eded3d9f9e9349bd3dbe095836e9daec4f8fa53e7c27ae3c6a4e3`;
its WAT SHA-256 is
`2575b086c93e14277b2cf43c837f7d944cb61e093d11c17034175d07afa23825`
and DTS SHA-256 is
`874ff64e8642ca4d5d1060091ab7d78a9ab0eda374e483e5c028115ad71c2022`.
With optimization and preserved names, the old control is 48,521 bytes with
SHA-256
`4e8f66606a18497ad7c11d4a65e14dd120b69caa825bf7a3c6e1738fbc4d2837`.
It returns `832040`. Program ABI resolves `fib`/`bench_fib` to function slots
76/77, the late `bench_fib` trampoline to function slot 253, and its mutable
externref cache to global slot 129. Candidate allocator slots and artifact
measurements will be recorded after the implementation is testable.
