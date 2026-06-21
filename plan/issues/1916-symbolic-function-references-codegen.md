---
id: 1916
title: "Symbolic function references in WasmGC codegen — retire the late-import index-shift machinery"
status: blocked
blocked_by: [2167]
sprint: 65
model: fable
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
---
# #1916 — Symbolic function references in WasmGC codegen

## Problem

The WasmGC backend bakes **absolute function indices** into instruction
streams as it compiles. Any import added after bodies exist shifts every
defined-function index, so compensation machinery must find and patch every
instruction array in flight:

- `shiftLateImportIndices` (`src/codegen/late-imports.ts:139-270`) walks 13+
  roots: `mod.functions`, `fctx.body`, `savedBodies`, `currentFunc`,
  `funcStack`, `parentBodiesStack`, `liveBodies`, `pendingInitBody`,
  `funcMap`, `nativeStrHelpers`, `pendingMethodTrampolines`, exports, elem
  segments, `declaredFuncRefs`.
- A **second** shift regime (`reconcileNativeStrFinalizeShift`,
  `late-imports.ts:355+`, #1677) exists because raw `addImport` deliberately
  doesn't shift (the #618 revert).
- Context fields exist *only* to make bodies reachable for the shifter
  (`liveBodies`, `context/types.ts:940-946`, citing #1384) — the context
  schema is shaped by repair-pass reachability.
- `generateModule`'s prologue (`index.ts:954-1103`) is a 150-line ordering
  ballet of which emission must precede which import registration.

At least 7 numbered regressions trace to this one design decision: #618,
#1109, #1384, #1525b, #1666, #1677, plus the #172-era class trampoline bug.
The IR layer already proved the alternative works: symbolic refs instead of
raw indices (`src/ir/nodes.ts:22-28`), which is exactly why IR integration
doesn't need `shiftLateImportIndices` (`ir/integration.ts:20-23`).

## Proposed approach

1. Introduce `FuncHandle` — one shared mutable `{ index: number }` (or
   name-keyed) object per function/import, interned in the codegen context.
2. Emit call/ref instructions as `{ op: "call", target: FuncHandle }`;
   resolve handles to concrete indices **once**, at binary-encoding time
   (`src/emit/binary.ts`), the same place type indices are already final.
3. `addImport`/`ensureLateImport` then renumber by mutating handles — no
   instruction walking, no body registry, no ordering constraints.
4. Delete `shiftLateImportIndices`, `reconcileNativeStrFinalizeShift`,
   `liveBodies`, `pendingLateImportShift`, and the prologue ordering
   comments as they become dead.
5. Migrate incrementally: accept `number | FuncHandle` in the `Instr` union
   during transition; ratchet raw-number call sites to zero (same pattern as
   the #1095 cast budget).

## Acceptance criteria

- No instruction-walking shift pass remains; `git grep shiftLateImportIndices` is empty.
- Equivalence suite + test262 sharded CI green (net ≥ 0, no bucket regressions).
- `liveBodies` / `parentBodiesStack` bookkeeping removed from `CodegenContext`.
- A regression test that adds a late import after N bodies are compiled and
  validates the binary.

## Source

Compiler quality review 2026-06
(`docs/architecture/compiler-quality-review-2026-06.md`), WasmGC codegen
section. Related: #1677 (unified two shift regimes; this removes the regime),
#1899 (funcIdx authority contract). Needs an architect spec before dev
dispatch (`/architect-spec`).

## Amendment (2026-06-11, analysis program)

Symbolic references as specced fix index-shift fragility but keep
NAME-keyed identity: `IrFuncRef { name }` is still a string (report 05
§3), so the collision class survives the migration — `${Class}_${method}`
colliding with a user `function A_m()` (#1983), `${name}_valueOf`
last-literal-wins dispatch (#1989, now specced onto typed refs), and the
`__sget_<name>` family. Requirement added: handles must be
**collision-free FuncIds derived from the declaration site /
ts.Symbol**, with names demoted to debug metadata. The instance-side twin
($shape, #2009) covers struct identity; this issue owns function/registry
identity. Full analysis: plan/log/analysis-2026-06/05-structure-review.md
§3.
