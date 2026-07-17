---
id: 3296
title: "Porffor backend P1: make generic lowering results genuinely non-Wasm"
status: done
sprint: porffor-backend
pr: 3166
completed: 2026-07-17
created: 2026-07-16
updated: 2026-07-17
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: gpt-5.6-sol
task_type: refactor
area: ir, backend
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3288
depends_on: [3295, 2953]
related: [3288, 2953, 2956, 1852]
origin: "#3288 P1 split: independently dispatchable generic lowering contract work"
---

# #3296 - Porffor backend P1: make generic lowering results genuinely non-Wasm

## Objective

Remove the remaining Wasm-shaped assumptions from the generic typed-SSA
lowering result so a fourth backend can participate through the existing
five-part backend contract without fabricating Wasm locals, indices, or types.

## Scope

1. Add `porffor` to `IrBackendKind` and define a narrow fail-loud legality
   profile for the families enabled in this slice.
2. Promote `TypeConverter` into the generic lowering path. Replace or adapt the
   Wasm-shaped `LocalDef[]` and `typeIdx` result with backend slots, named
   locals, parameters, and return types.
3. Close or explicitly reject every `pushRaw`/`Instr[]`-only family reachable
   by the Porffor legality profile.
4. Add contract-conformance coverage for the fourth backend.

## Acceptance criteria

- [ ] Generic lowering returns no mandatory Wasm `ValType`, local index,
      function index, block depth, or `Instr[]` value.
- [ ] The existing WasmGC, bytecode, and linear integrations continue to use
      the same generic contract without behavior regressions.
- [ ] Porffor legality rejects unsupported families before emission with a
      localized `porffor backend does not support ...` diagnostic.
- [ ] No Porffor path uses `RawC` or a raw Wasm instruction escape hatch.
- [ ] Backend contract tests cover all four registered backend kinds.
- [ ] The issue changes are committed, pushed to `origin`, and published as a
      ready, non-draft PR before completion is reported.

## Validation

- Run backend contract and legality tests.
- Run focused generic lowering tests for locals, parameters, and returns.
- Run the existing IR and emit-identity suites affected by result-shape changes.

## Non-goals

- Rendering C or executing Porffor output.
- Heap/object lowering.
- Extracting `LinearMemoryPlan`.

## Handoff

After this PR merges, #3297 owns the first executable scalar/control-flow
Porffor sink and module proof.
