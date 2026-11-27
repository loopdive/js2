---
id: 7536
title: "Move the dynamic-operator lowering helpers out of from-ast.ts into their own module"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
goal: ir-full-coverage
depends_on: [7354]
related: [7354]
origin: "2026-11-26 RV7491 review of #7354 O7 (finding F6, rule 3 'leave it better')"
---

# #7536: a module for the dynamic-operator lowering

## Problem

#7354 O7 gathered the dynamic-operator lowering into a few self-contained helpers in `src/ir/from-ast.ts`, which is
over 17,000 lines and grows only under grants:

- `lowerDynamicBinaryValues`: the dynamic `+` and the ToNumber operators;
- `dynamicBinaryOnCarrier`: boxes the numeric result;
- `dynamicIncrement`: `++` / `--`;
- `dynamicCompoundStep`: a dynamic compound's step after its read.

They are called by `lowerBinary`, the identifier compound / increment arms and the member compound arm.

## Implementation Plan (sketch, to be measured before it is taken)

- Target: a sibling lowering module (e.g. `src/ir/lower-dynamic-operators.ts`), next to the other from-ast satellites,
  classified in `scripts/compiler-boundaries.json` like its siblings.
- Their dependency on from-ast's private context is small: the builder, `lowerExpr` for the RHS (only
  `dynamicCompoundStep`), `boxConcreteToDynamic` and `emitDynamicAdd`. Pass it in as a narrow host, in the pattern of
  `function-object-lowering.ts`.
- Acceptance:
  - from-ast.ts shrinks by the moved lines, so the O7 grant is released;
  - `check:import-cycles` and `check:ir-layering` keep their counts;
  - Prepared bytes (804) and the playground bytes are identical;
  - no behaviour change.
