---
id: 7195
title: "IR: test-body callback closures as call arguments (closure-return-type) — plan the call-argument site"
status: in-progress
sprint: current
created: 2026-10-29
updated: 2026-10-29
priority: high
horizon: l
feasibility: hard
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
related: [7113, 7193]
assignee: "ttraenkler/js2-17"
---

# IR: test-body callback closures as call arguments

## Problem

Step 2 of #7106's "Next steps": in the census, 59/266 sampled tests carry
`closure-return-type` on a test-body callback, e.g.
`assert.throws(TypeError, function () { … })`. On a later 1/60 standalone
sample the lead counted:

- 328/710 tests whose only legacy unit is `<module-init>`;
- 57 of those carry `closure-return-type`, and in 10 it is the only code.

The top shapes are untyped zero-parameter callbacks whose result is unused.

`closureLiteralIsBuildable` (`src/ir/select-closure-literal.ts`) refuses a
closure that has neither an annotation nor an `IrFunctionMemberClosurePlan`.
The only plan producer is `planMemberClosure`
(`src/codegen/function-member-closure-planning.ts`), and it accepts only the
`F.member = function () {}` statement site.

## ABI measurement (origin/main c5f5cf5b, standalone)

Probe: `assert.throws = function (e, func, m) { try { func(); } catch (t) { … } … }`,
then `assert.throws(0, function () { throw "y"; });` in `<module-init>`.

- **Legacy value at the boundary.** Legacy compiles the callback through
  `computeClosureWrapperSig`, giving the zero-parameter void signature `() →
  none` (`{"params":[],"returnType":null}`). The argument is boxed as the
  closure struct (`extern.convert_any`), and `func()` inside `assert.throws`
  dispatches on the funcref wrapper type that
  `peekFuncRefWrapperTypes([], [])` names.
- **The member-closure plan already proves this.** Its signature is
  `computeSignature(expression)`, and `notePreparedAllocation` checks that the
  IR `closure.new` uses exactly that wrapper struct and funcref type. A plan
  for the call-argument site therefore carries the same physical value; no new
  ABI is needed.
- **What else blocks, measured with an experimental site.**
  - Selection then passes.
  - The planned-closure operand walk (`plannedClosureOperandRefusal`) still
    refuses unsupported operands at select (`throw 1` →
    `closure-throw-operand`).
  - **Gap:** a bare identifier call in the body (`f()`, `Symbol()`) passes
    select but withdraws after the claim: "direct call to `f` has no exact
    AST-site plan".

    The cause: the `<module-init>` lowering pass builds its direct-call
    targets from `loweringPlans.ownerUnitIdByLegacyName`, which is empty for
    the module-init component. So a plain top-level `f();` withdraws after the
    claim too. That part is pre-existing and separate from this issue.

    Member closures still get these calls because the receiver's unit joins
    the component; a call-argument site brings no callee unit.
- **gc.** The native-first gc lane also sets `ctx.standalone`, so the site
  is gated on `targetProfile.target === "standalone"`.

## Implementation Plan

**Module.** `src/codegen/function-member-closure-planning.ts` stays the one
planner; no sibling copy.

1. **Factor the site out of `planMemberClosure`.**
   - The inline assignment / owner / receiver-target block becomes
     `memberAssignmentSite`, unchanged in behaviour.
   - A new sibling `callArgumentSite` covers the call-argument site.
   - Both return a `FunctionClosureSite` (`kind`, `ownerUnitId`,
     `isCurrent()`).
   - The site-specific staleness checks move out of the plan's `isCurrent`
     into `site.isCurrent()`. The ABI, parameter and body proofs stay shared.
2. **Reuse, and remove a duplicate.** The receiver → same-source top-level
   function target check (`sameSourceFunctionTarget`) and its re-check
   (`sameTargetAgain`) are shared by both sites. Before this change the
   re-check was written out twice inside `isCurrent`.
3. **`callArgumentSite`** admits a FunctionExpression that is an argument of
   `F.m(…)`, where:
   - `F` is a same-source top-level function value (the callee is a member of
     a function object, whose parameters are the dynamic carrier);
   - the call is a top-level `ExpressionStatement`;
   - the target is standalone.
4. **Narrowing, all in the shared planner.** A call-argument site must be
   void and take zero parameters. Its void body proof (`openVoidBodyKey`)
   additionally refuses bare identifier calls (`identifierCalls: false`).
5. **The plan carries `site`.** The planned-closure walk treats a
   call-argument closure as a new shape, so the #7177 carrier method-call,
   member-read and `String` refusals apply to it.
6. **Fail-closed.** Every unprovable shape yields no plan, so selection refuses
   it as `closure-return-type`, or the operand walk refuses it. No
   claim-then-demote.

**Acceptance.**

- **Correctness.**
  - `assert.throws(v, function () { … })` claims `<module-init>` with zero
    post-claim errors.
  - IR = legacy = node for throwing, wrong-value, non-throwing and repeated
    callbacks.
  - Identifier calls, parameters, value returns and arrows are refused at
    select.
- **gc.** Output is byte-identical (same binary hash on the probe; the
  playground examples are unchanged).
- **Code quality.**
  - One planner with two site functions in the same shape.
  - No duplicated receiver-target logic.
  - No new arm in the selector or in from-ast.
  - Function and LOC budgets are not exceeded.

## Follow-ups

- Module-init direct calls: `<module-init>` mints no direct-call plan for
  same-source functions (`f();` withdraws after the claim on main). Fixing it
  lets call-argument callbacks call `f()`.
- `String(x)` and other ambient identifier calls in a callback are refused by
  the identifier-call rule. Admit the ones the module-init lowering really
  plans.
- Arrow callbacks (`() => …`) need the plan's `expression` widened beyond
  `FunctionExpression`.
- `IrFunctionMemberClosurePlan` now also plans call-argument closures. Rename
  it once the arrow site lands.

## Test Results (S1, base origin/main c5f5cf5b)

- **Census.** The 1/60 standalone sample (original harness, compile-only) has
  739 rows; 349 of them have `<module-init>` as their only legacy unit.
  Re-run base vs head with every reject listed:
  - test-body callbacks still refused as `closure-return-type`: 847 → 785
    (62 are now planned);
  - zero-legacy tests: 0 → 0;
  - post-claim errors: 0 → 0.
  - The 62 newly planned callbacks expose their next arm, mostly
    `closure-member-dynamic-method` (30), then `expr-new-native-typed-array`
    (8) and `expr-ident-not-in-scope` (6).
  - Zero-legacy cannot move yet: every sampled `<module-init>` is still
    blocked by harness statements (`compareArray.format`, `message.toString()`;
    #6970 / #6972 in flight).
- **Tests.** `tests/issue-7195-*` passes 10/10. The member-closure suites
  (`issue-7106-member-closure-shapes`, `function-member-*`,
  `module-init-void-member`, `stage2-function-objects`), `issue-7193` and
  `issue-5297` pass 126/126 together with it.
- **Byte identity.**
  - Playground examples on gc and standalone: 26/26 byte-identical.
  - The gc probe binary hash is unchanged (`40f4905658`).
- **Gates**, run bare with `LOC_GATE_BASE=origin/main`; all exit 0:
  - loc and func budgets;
  - coercion-sites, oracle-ratchet, dead-exports;
  - check-standalone-arms, import-cycles;
  - `check:ir-fallbacks`;
  - typecheck.
