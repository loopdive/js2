---
id: 3521a
title: "R2: expose structural dependency identities during Program ABI planning"
status: done
sprint: 77
created: 2026-07-30
updated: 2026-07-30
priority: critical
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, codegen, compiler
goal: ir-full-coverage
lane: ir-retirement-r2
parent: 3521
related: [3518, 3520, 3521]
files:
  - src/codegen/program-abi-session.ts
  - src/codegen/index.ts
  - src/ir/builder.ts
  - src/ir/nodes.ts
  - src/ir/prepared-component-dependencies.ts
  - tests/issue-3521-scoped-prepared-abi-seal.test.ts
  - tests/issue-3521-prepared-component-dependencies.test.ts
loc-budget-allow:
  - src/codegen/program-abi-session.ts
  - src/codegen/index.ts
  - src/ir/builder.ts
  - src/ir/nodes.ts
---

# R2 structural-reference reverse lookup

## Objective

Let prepared-component dependency discovery resolve import, runtime, and
intrinsic callable references to their exact planned Program ABI identities
before numeric Wasm slots exist.

## Completed behavior

- `ProgramAbiSession.bindingIdsForStructuralReference(key)` reads canonical
  structural keys from planned drafts without inspecting final numeric slots.
- Results use deterministic structural plan order.
- Missing keys return an empty immutable result.
- Duplicate structural keys remain visible as multiple identities so component
  discovery can fail closed on ambiguity.
- Production class shapes carry exact constructor, constructor-init, instance
  member, accessor, super-call, and static-call targets into their IR
  instructions.
- Prepared-component discovery closes class calls through those symbolic
  targets and keeps compatibility nodes without targets blocked.

## Acceptance evidence

- [x] Reverse lookup works before whole-program ABI publication.
- [x] Lookup does not mutate planning or structural-reference observation.
- [x] Ambiguous identities are not collapsed.
- [x] Class call instructions expose callable identity without member-name
      inference.
- [x] Scoped Program ABI and prepared-component dependency tests pass.
- [x] Typecheck, formatting, LOC, and function budgets pass.

## Remaining parent work

R2 still needs terminal ownership provenance for source globals before the
symbolic component closure can widen production routing.
