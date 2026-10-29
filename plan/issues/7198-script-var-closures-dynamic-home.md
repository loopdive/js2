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

On the 126 rows, after the change, 34 still carry `vardecl-let-closure`. Each
is a shape the member-closure planner does not prove, and it stays refused:

- empty bodies (`function() {}`, 7);
- numeric, `arguments` or capturing returns;
- arrows, including defaults and rest parameters;
- async and generators.

A binding with any reference that is not a value use stays refused too. The
boxed carrier is not legacy's function object, so `f.name`, `f.p = 1`,
`f.length` or `f()` would see a different object. The allowed value uses are
a call argument, a `typeof` operand and a plain `=` target. Calls to the
binding also stay refused at select: a direct call `f()`, at the top
level or from a nested closure, and a reassigned binding.

## Implementation Plan

- **Module.** `src/codegen/function-member-closure-planning.ts`: one more site,
  `scriptVarSite`, next to `memberAssignmentSite` and `callArgumentSite`, in the
  same shape. The planner (`planMemberClosure`, #6977) proves the body, the
  raw-versus-logical adapter and the open-body key exactly as for the other
  sites. The site requires every reference to the binding (found through
  `ctx.oracle.declarationsOf`) to be a value use. Calls inside the body get
  #7197's module-init direct-call plans. Standalone only, like the
  call-argument site.
- **Select.** `src/ir/select.ts`, `isPhase1VarDecl`: a planned script-var
  closure into a dynamic slot skips the Slice 3 `const`-closure arm and takes
  the ordinary module-binding write.
- **Lower.** `src/ir/from-ast.ts`, `lowerVariableDeclaration`: the same
  predicate lifts the "module-level closure binding" demote. The widened
  dynamic store converts a closure value through
  `functionObjects.functionObjectDynamicValue`, the existing producer for a
  closure → carrier (callable pack + `IR_DYN_CALL_BOX_FN`). No new boxing arm.
- **Reuse / no duplicate.** One predicate, `isPlannedScriptVarClosure`
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

- **Issue test.** `tests/issue-7198-script-var-closures.test.ts` passes 8/8 on
  head. On base, the 3 claimed cases fail; the 5 refused cases (including
  `f.name` and `f.p`) already refuse.
- **Output changes.** gc and WASI are byte-identical on the 13 playground
  examples and the 3 probe modules (prelude + `print`). Standalone changes only
  on the probe modules, which now claim `<module-init>`.
- **Census (126 affected rows).** `vardecl-let-closure` drops from 126 rows to
  34. Post-claim errors (23) and compile failures (10) are the same rows as on
  base, so no new ones. Zero-legacy stays 0 → 0, because other refusals now
  block these rows:
  - `expr-ident-not-in-scope`, 148;
  - `expr-module-scalar-method`, 77;
  - `vardecl-module-storage-unrepresentable`, 59, which belongs to the
    script-var lane.
- **Standalone test262 (`runTest262File`, the 126 files).** 89 pass, 22 fail
  and 15 compile errors on both base and head, with 0 status flips.

## Review (adversarial, fresh context, 2026-10-29)

Verdict on the first push: FINDINGS. Both blockers were fixed in the second
commit.

- **B1, fixed.** `f.name` on a claimed binding miscompiled: the boxed carrier
  is not legacy's function object. The planner now refuses unless every
  reference is a value use.
- **B2, fixed.** `f.p = 1` was claimed and then withdrawn
  (`property assignment on dynamic`). It is refused at plan time by the same
  rule.
- **N1, fixed.** The closure store branch is now tied to the planned
  script-var predicate, not to any closure value in a widened slot.
- **N2, fixed.** The predicate dropped its pass-through flag, and callers AND
  the slot kind.
- **N3, fixed.** The predicate checks syntax before it resolves the plan.
- **N4, fixed.** Stale comments updated.
- **N5.**
  - Fixed: the defensive `?.` is dropped.
  - Rebutted: `isCurrent` keeps the parent-link check. The site has no
    resolver target to re-check, unlike the siblings.
- **N6.**
  - Fixed: `f.name` and `f.p` added as refused cases.
  - Kept: `observe` stays a throw / no-throw oracle. A standalone Wasm
    exception payload is not readable from the test without a host, and every
    failing assertion in these programs throws.
- **Verified OK by the review:** gc and WASI byte-identity; selector and
  lowering predicate agreement; hoisting; redeclaration; writes elsewhere.

## Revalidation after merging main (post-#6972, base `736bafd5fe`)

- **Standalone test262 (`runTest262File`).** The 126 files plus the 9 ES5
  rows that #6972's merge group tripped on: 98 pass, 22 fail and 15 compile
  errors on both base and head, with 0 flips.
  - All 9 named ES5 rows pass.
  - All 17 ES5 rows among the 126 pass.
- **Census (126 rows).**
  - `vardecl-let-closure`: 126 → 34.
  - Zero-legacy: 0 → 0.
  - Post-claim errors (23) and compile failures (10) are the same rows as on
    base.
- **Regression suite.** `tests/issue-{7106,7195,7197,7193,7198,7113,7132,7130,3783,1169}*`
  (66 files, 646 tests): 12 failures, the same 12 as on base.
- **Gates.** Green with `LOC_GATE_BASE` set to the new main tip.
