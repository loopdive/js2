---
id: 3521b
title: "R2: carry exact source-global storage ownership"
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
related: [3518, 3520, 3521, 3521a]
files:
  - src/codegen/program-abi-planning.ts
  - src/codegen/program-abi-session.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/program-abi.ts
  - tests/issue-3521-scoped-prepared-abi-seal.test.ts
  - tests/issue-3521-prepared-component-dependencies.test.ts
  - tests/issue-3520-module-binding-class-identity.test.ts
loc-budget-allow:
  - src/codegen/program-abi-planning.ts
  - src/codegen/program-abi-session.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/ir/prepared-component-dependencies.ts
---

# R2 source-global storage ownership

## Objective

Attach each source-owned Program ABI global to the exact terminal responsible
for its storage lifetime. Prepared-component discovery can then distinguish an
owned global from a module-init dependency outside the candidate population.

## Acceptance

- [x] Module-binding identities expose declaration-storage ownership separately
      from use-site ownership.
- [x] Source Program ABI global intents retain exact source and storage-terminal
      provenance.
- [x] Prepared scopes close globals owned by their terminal and reject foreign
      storage.
- [x] Dependency evidence reports the exact non-candidate storage terminal.
- [x] Focused tests, typecheck, formatting, fallback, LOC, and function budgets
      pass.

## Boundary

This adapter records ownership evidence only. It does not widen the bounded R2
router to module-init components.
