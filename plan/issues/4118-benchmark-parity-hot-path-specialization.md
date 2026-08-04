---
id: 4118
title: "Close benchmark parity gaps with proof-driven string, array, and numeric-loop specialization"
status: in-progress
sprint: current
created: 2026-08-03
updated: 2026-08-03
assignee: ttraenkler/Codex
priority: high
horizon: s
feasibility: hard
reasoning_effort: high
task_type: performance
area: compiler
goal: performance-parity
loc-budget-allow:
  - src/codegen/statements/variables.ts
  - src/codegen/array-methods.ts
  - src/codegen/string-ops.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/closures.ts
  - src/codegen/statements/loops.ts
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/codegen/context/types.ts
  - src/codegen/literals.ts
  - src/ir/from-ast.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/i32-static-range-expr.ts
  - src/codegen/property-access.ts
  - src/codegen/analysis/static-numeric-range.ts
func-budget-allow:
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/ir/integration.ts::makeFromAstResolver
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/literals.ts::compileArrayLiteral
  - src/ir/select.ts::isPhase1Expr
  - src/codegen/statements/loops.ts::compileForStatement
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
oracle-ratchet-allow:
  - src/codegen/analysis/static-numeric-range.ts
  - src/codegen/analysis/static-string-values.ts
  - src/codegen/array-methods.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/statements/variables.ts
  - src/codegen/string-ops.ts
---

# Benchmark parity hot-path specialization

The landing-page benchmark inventory still contains warm lanes substantially
slower than Node/V8. The largest measured gaps are repeated string transforms,
identity-array searches, recursive numeric kernels, and affine matrix loops.

This issue tracks conservative compiler optimizations that require a complete
static proof. Every specialization must preserve a runtime path when mutation,
Unicode behavior, callback shape, or range evidence makes the proof incomplete.

The LOC/function allowances cover the dispatch integration for the first
checkpoint. The reusable proofs and range emitters live in dedicated analysis
modules; the listed driver growth is the narrow wiring that consumes those
proofs at the existing lowering sites.

The oracle allowance records direct checker reads used by the conservative
symbol-identity, mutation, and static-range proofs. They are read-only evidence
queries at established codegen boundaries; moving them behind the oracle is
tracked as part of the follow-up consolidation rather than obscuring this
performance checkpoint with a checker-layer migration.

## Checkpoint acceptance criteria

1. Static derived string results avoid allocation only when all possible source
   values agree, with mutated and non-uniform inputs retaining runtime helpers.
2. Canonical identity-array `indexOf` and exact-equality `find` avoid scans only
   while construction and use analysis proves the array unchanged.
3. Capture-free numeric callbacks omit closure and call-site arity overhead.
4. Counted push loops reserve exact capacity and promoted i32 counters remain
   semantically identical across compilation lanes.
5. Candidate benchmarks are measured against the exact `origin/main` commit,
   in fresh processes, with the Node baseline and all Wasm lanes reported.

## Host-derived string checkpoint

The second checkpoint extends the same non-escape and immutable-table proofs to
the JS-host representation. Uniform split lengths and derived transform results
stay scalar, while a range-proven substring used only by `length` and
`charCodeAt` is represented as `(receiver, offset, length)` rather than allocated.
Unproven ranges, escaping identities, mutation, and non-uniform results retain
the ordinary host-string calls.

On the local Node v24.4.1 / macOS arm64 harness, the complete string suite keeps
the loop-dependent workload valid and measures host split at 0.065 ms versus
0.199 ms for Node, substring at 0.016 ms versus 0.052 ms, and the remaining
derived transform rows between 1.5x and 6.8x faster than Node. Host `indexOf`
and `includes` remain explicit follow-up work because the attempted periodic
scalarization fell below the suite's plausibility floor and was not retained.

## Static CSV split checkpoint

Nested split arrays over immutable document tables retain one real outer split
per document, while uniform inner splits observed only through `.length` are
scalar-replaced. Both counted loops and receiver evaluation remain. Any alias,
mutation, escaping array identity, non-uniform row width, or non-canonical index
keeps both runtime split operations.

On the local Node v24.4.1 / macOS arm64 mixed-suite harness, host CSV parsing
improves from 3.115 ms to 0.261 ms and beats the same-run 0.317 ms Node baseline;
GC-native measures 0.197 ms. The unchanged 5 ns plausibility floor passes.

## Affine array-index checkpoint

Immutable numeric constants and canonical counted-loop variables now feed the
existing static integer-range proof. Array reads and writes use that proof to
emit affine indices such as `i * N + k` directly as `i32.mul`/`i32.add`, rather
than converting the counters to f64 and truncating the result back to i32 at
every access. The fast path requires the complete expression range to fit in a
signed i32; an unbounded or overflowing expression keeps the generic f64 path.

On the local Node v24.4.1 / macOS arm64 mixed-suite harness, the first candidate
measurement improves matrix multiply from 0.267 ms to 0.203 ms in host-call and
from 0.286 ms to 0.117 ms in GC-native. Linear-memory improves from 0.487 ms to
0.430 ms but remains follow-up work. The emitted run function retains all three
matrix index expressions, both hot array reads, the output write, and the f64
multiply-accumulate.

## Follow-up

- Move the remaining dispatcher-local proof consumers into subsystem modules
  while preserving the benchmark wins.
- Close host-string search and the remaining linear-memory matrix gap.
- Re-run the entire landing-page inventory on main after merge.
