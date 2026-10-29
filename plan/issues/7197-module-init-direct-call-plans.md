---
id: 7197
title: "IR: `<module-init>` direct calls to same-source functions withdraw after the claim — plan them in the lowering projection"
status: done
completed: 2026-10-29
sprint: current
created: 2026-10-29
updated: 2026-10-29
priority: high
horizon: s
feasibility: medium
task_type: bugfix
area: ir
goal: ir-full-coverage
parent: 7106
related: [7195, 7113]
assignee: "ttraenkler/js2-17"
---

# IR: `<module-init>` direct calls withdraw after the claim

## Problem

On origin/main, the IR claims a `<module-init>` that makes a direct call to a
same-source function, then the build withdraws it ("direct call to `f` has no
exact AST-site plan in `<module-init>`"). Two shapes hit this:

- a top-level `function f() { return 1; } f();`, on every lane (standalone,
  WASI, gc);
- a call from inside a planned member closure, as soon as `<module-init>`
  holds any statement other than `F.x = function …`. For example,
  `subject.f = function (m, k) { …; subject(); … };` followed by
  `subject.f(1, 9);`.

Member-only `<module-init>`s worked. #7113's tests cover them: there the
callee's unit joins the module-init component on the `preparedMemberInit`
route.

Found while measuring #7195's follow-ups. The 1/60 census currently shows 0
rows with this withdrawal, because those rows are refused earlier for other
reasons. It is a latent claim-then-withdraw on a common shape.

## Root cause

`projectIrIntegrationLoweringPlans` (`src/codegen/ir-overlay-identity.ts`)
builds the AST-site direct-call plans for each owner it projects. It walks
`declarationByUnitId.get(unitId)`, and `<module-init>` has no declaration, so
it was skipped (`if (!declaration) continue`).

The integration pass that then lowers `<module-init>` gets only the remaining
units' targets: `completePreparedIrIntegration` projects the remaining
selection, and the already-prepared functions are not in it. The full
projection it merges in (`mergePreparedIrDirectCallLoweringPlans`, which
exists for exactly this deferred-caller case) carried no plans for
`<module-init>` call sites either.

## Implementation Plan

- **Module.** `src/codegen/ir-overlay-identity.ts`,
  `projectIrIntegrationLoweringPlans`: the one place that builds AST-site
  direct-call plans for projected owners.
- **Change.** For each projected owner, collect over its source roots: the
  declaration for a function, or the owned top-level statements
  (`moduleInitPopulationBySourceFile`) for `<module-init>`.
  `collectIrDirectCallLoweringPlansByIdentity` keeps checking each call's
  terminal owner, so a call inside a planned closure is attributed to
  `<module-init>`, exactly as the from-ast lowering expects.
- **Reuse.** The full-selection projection already carries these plans into
  the remaining pass through `mergePreparedIrDirectCallLoweringPlans`, so
  nothing is rebuilt. The target map stays the projection's
  `directCallTargets`, its one source of truth.
- **Rejected alternatives.** A selector-side refusal would re-derive the
  module-init route, which is decided after selection, and the copy could
  drift. Refusing every direct call in `<module-init>` would regress the
  member-only claims.

**Acceptance.**

- Both repros claim and lower with empty `irPostClaimErrors`, and IR =
  legacy = node on standalone, WASI and gc. The test fails without the fix.
- #7113's member-only claims are unchanged.
- **Code quality.** One function changes. There is no new map, predicate or
  route re-derivation, and no selector change.

## Test Results (base origin/main 413c2ede)

- **Issue test.** `tests/issue-7197-module-init-direct-calls.test.ts`
  passes 4/4. On base (fix reverted) it fails 4/4. Each case is checked on
  standalone, WASI and gc for IR = legacy = node.
- **Output changes, disclosed.** A module that previously withdrew after the
  claim now ships the IR `<module-init>` body on standalone, WASI and gc, so
  its binary changes. Modules without such a direct call are byte-identical:
  - the playground examples (26 compiles, gc + standalone);
  - the gc/WASI/standalone probe without a top-level direct call.
- See the PR body for the regression suite, census and gates.
