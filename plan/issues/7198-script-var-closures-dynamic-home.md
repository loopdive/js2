---
id: 7198
title: "IR: store a script `var f = function () {}` into its dynamic home on standalone (vardecl-let-closure)"
status: done
completed: 2026-10-29
sprint: current
created: 2026-10-29
updated: 2026-10-29
priority: high
horizon: s
feasibility: medium
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
related: [7195, 7197, 7132]
assignee: "ttraenkler/js2-17"
# 2026-10-29: +8 / +7 lines are the seam only: the shared predicate's import
# and call at the one select arm and the one lowering demote, plus the closure
# branch of the widened dynamic store. The predicate and site live outside
# both god-files.
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
---

# IR: store a script `var f = function () {}` into its dynamic home

## Problem

The selector refuses every non-`const` closure initializer
(`vardecl-let-closure`), so a standalone `<module-init>` that declares
`var f = function () {}` falls back to legacy as a whole.

Measured on origin/main + #6972 with all `<module-init>` rejects reported (1/60
census, 739 rows): `vardecl-let-closure` appears in 126 rows. It is never the
only blocker, and none of those rows is zero-legacy. 72 of the 90 async rows
refuse on the test262 prelude `var print = function (value) { console.log(value); };`
(`scripts/test262-fyi-runtime.js`).

Its slot `__mod_print` is already the script-var dynamic home (a
`(mut externref)` global, `scriptVarSlotIsDynamicHome`). The only gaps were a
closure plan for the initializer and a store into the carrier.

## Measurement: missing plan vs. shapes to keep refusing

On the 126 rows, after the change, 30 still carry `vardecl-let-closure`. Each
is a shape the member-closure planner does not prove, and it stays refused:

- empty bodies (`function() {}`, 7);
- numeric, `arguments` or capturing returns;
- arrows, including defaults and rest parameters;
- async and generators.

Calls to the binding stay refused at select: a direct call `f()`, at the top
level or from a nested closure, and a reassigned binding.

## Implementation Plan

- **Module.** `src/codegen/function-member-closure-planning.ts`: one more site,
  `scriptVarSite`, next to `memberAssignmentSite` and `callArgumentSite`, in the
  same shape. The planner (`planMemberClosure`, #6977) proves the body, the
  raw-versus-logical adapter and the open-body key exactly as for the other
  sites. Calls inside the body get #7197's module-init direct-call plans.
  Standalone only, like the call-argument site.
- **Select.** `src/ir/select.ts`, `isPhase1VarDecl`: a planned script-var
  closure into a dynamic slot skips the Slice 3 `const`-closure arm and takes
  the ordinary module-binding write.
- **Lower.** `src/ir/from-ast.ts`, `lowerVariableDeclaration`: the same
  predicate lifts the "module-level closure binding" demote. The widened
  dynamic store converts a closure value through
  `functionObjects.functionObjectDynamicValue`, the existing producer for a
  closure → carrier (callable pack + `IR_DYN_CALL_BOX_FN`). No new boxing arm.
- **Reuse / no duplicate.** One predicate, `isDynamicHomeClosure`
  (`src/ir/function-member-closure-plan.ts`), serves both select and lowering.
  The site union gains `"script-var"`. `plannedClosureOperandRefusal` treats
  every non-member-assignment site as a new shape (`site !== "member-assignment"`),
  so the two newer sites share one rule.
- **Out of scope.** The script-var module-storage arm
  (`vardecl-module-storage-unrepresentable`) belongs to the script-var lane
  (ref-homes commit `ba959239`). This change needs only the existing dynamic
  home.

**Acceptance.**

- The claimed shapes have zero `irPostClaimErrors`, and IR = legacy = node.
- The refused shapes refuse at select.
- gc and WASI are byte-identical.
- The test fails without the fix.
- **Code quality.** One new site in the existing site chain, one shared
  predicate, and no new boxing producer.

## Test Results (base origin/main 8de8a22511)

- **Issue test.** `tests/issue-7198-script-var-closures.test.ts` passes 6/6 on
  head and fails 3/6 on base: all 3 claimed cases fail there, while the
  refused cases already refuse.
- **Output changes.** gc and WASI are byte-identical on the 13 playground
  examples and the 3 probe modules (prelude + `print`). Standalone changes only
  on the probe modules, which now claim `<module-init>`.
- **Census (126 affected rows).** `vardecl-let-closure` drops from 126 rows to
  30. Post-claim errors (23) and compile failures (10) are the same rows as on
  base, so no new ones. Zero-legacy stays 0 → 0, because other refusals now
  block these rows:
  - `expr-ident-not-in-scope`, 148;
  - `expr-module-scalar-method`, 77;
  - `vardecl-module-storage-unrepresentable`, 59, which belongs to the
    script-var lane.
- **Standalone test262 (`runTest262File`, the 126 files).** 89 pass, 22 fail
  and 15 compile errors on both base and head, with 0 status flips.
