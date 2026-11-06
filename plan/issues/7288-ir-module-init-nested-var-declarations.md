---
id: 7288
title: "IR module-init: a nested top-level `var` (block / `for` / `for-in` head) lowers to its module binding instead of withdrawing"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7276, 3523]
assignee: "ttraenkler/c-lead"
loc-budget-allow:
  # 2026-11-06 (#7288): one shared predicate, `isModuleInitVarList`, decides
  # which hoisted `var` lists are module bindings; the growth is its wiring.
  # module-bindings.ts +2: `isModuleBindingDeclaration` admits a script's
  # modelled `for (;;)` head. declarations.ts +2: the one call that observes
  # the head's `__mod_<name>` slot under its exact declaration, and its import.
  - src/ir/module-bindings.ts
  - src/codegen/declarations.ts
func-budget-allow:
  # 2026-11-06 (#7288): the one observe call in the for-head arm of
  # `walkModuleStmtForVars`, which is nested in `collectDeclarations`.
  - src/codegen/declarations.ts::collectDeclarations
import-cycles-allow:
  - codegen->ir: 303 # 2026-11-06 (#7288): module-global-registration.ts reads the IR's `isModuleInitVarList`, the one predicate for which hoisted `var` lists are module bindings, so legacy observes exactly the slots the IR resolves
---

# #7288: nested top-level `var` in `<module-init>`

## Problem

from-ast withdraws a selector-claimed `<module-init>` with
`ir/from-ast: module-init unit contains a nested var declaration`: a `var`
declared inside a block, a `for` head or a `for-in` head at script top level
is still a module binding (hoisted), but the lowering refuses it. This is a
claim-then-withdraw. #7276 measured it on the 7 `built-ins/Object/create`
for-in files.

## Measurement

In progress.
