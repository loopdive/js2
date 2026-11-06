---
id: 7265
title: "IR move-only scan: local boolean call result into a dynamic var; dynamic computed element key (#7250 rule b)"
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
parent: 7250
depends_on: [7258, 7260]
related: [2949, 7106, 7261]
assignee: "ttraenkler/c-r7"
loc-budget-allow:
  # 2026-11-06: one `calleeReturnKind` helper (the existing
  # `calleeReturnIsDynamic` now reads it) and two scan admissions. The scan's
  # closure state lives in select.ts.
  - src/ir/select.ts
func-budget-allow:
  # 2026-11-06: +6 in scanExprInner, for the bool-call operand in the
  # dynamic-local assignment arm and the dynamic-key read arm. Each sits next
  # to its sibling key and operand checks. Restates #7258/#7260's #7261-guard
  # grant.
  - src/ir/select.ts::scanExprInner
  - src/ir/select.ts::dynamicUsesAreMoveOnly
---

# IR move-only scan: boolean call result into a dynamic var; dynamic computed element key

## Problem

Rule (b) of [#7250](7250-ir-property-helper-dynamic-carrier-locals.md):
propertyHelper.js's `isWritable` does
`writeSucceeded = isSameValue(obj[verifyProp || name], newValue);`, where
`var writeSucceeded;` is the dynamic carrier's undefined (#7106 Stage 4).
Stacked on #7258 (rule c) and #7260 (rule a).

## Measurements (step 1, before code; base = #7260 head `73ea42c2`)

All on a copy of `isWritable` with #7250 step 1 stubbed
(`var unlikelyValue = "unlikelyValue"`, the `new Test262Error` throw reduced
to `throw e`), standalone, `JS2WASM_IR_SHAPE_DIAG=1`:

| variant | base refusal |
| --- | --- |
| as written | `move-only[concrete]` on `writeSucceeded = isSameValue(obj[verifyProp \|\| name], newValue)` |
| key aliased (`var k = verifyProp \|\| name`) | the same row (b1) |
| `isSameValue(obj[name], …)` | the same row (b1) |
| `var r = obj[verifyProp \|\| name]; writeSucceeded = r === newValue` | `move-only[dyn]` on `obj[verifyProp \|\| name]` (b2) |

So (b) is two admissions:
- **(b1)** the plain-assignment arm boxes only syntactic concretes
  (`concreteDynamicAssignmentOperandIsBuildable`), never a call. Here the
  call is a direct call to a local function whose return resolves `bool`.
- **(b2)** the dynamic element-read arm takes only a literal, a dynamic
  identifier or a proven-number key, never a dynamic expression such as
  `verifyProp || name` (#7106 S3b, `dyn.truthy` select).

Both producers already exist. from-ast boxes a concrete assignment value
with `boxConcreteToDynamic`, a bool → tag-boolean box, and its dynamic
element-read arm uses any dynamic key as-is (`lowerElementAccess`,
`emitDynMemberGet`). So this is an admission under the existing contract.

## Implementation Plan

- `src/ir/select.ts`:
  - `calleeReturnKind(name, typeMap)`: the resolved return of a local
    function. `calleeReturnIsDynamic` now reads it (one source).
  - The plain assignment to a dynamic local also admits a direct local call
    whose return is `bool`.
  - The dynamic element read also admits a dynamic-shaped key. A key other
    than a plain dynamic identifier sets the scan's #7261 flag
    (`needsNoDynamicMethodCall`), so a body that also calls through a member
    access stays refused (a dynamic key could itself be such a call).
- No from-ast change, no new instruction, no new import.

Code-quality acceptance: the callee-return lookup has one source, and each
admission sits next to its sibling checks in the same arm.

## Acceptance criteria

- `tests/issue-7265-ir-move-only-bool-call-into-dynamic.test.ts`: the
  stubbed isWritable is IR-emitted and passes through the test262 runner in
  sloppy and strict mode.
- Typed corpus byte-identical on gc/standalone/wasi.
- Wrapped ledger: 0 invariants, compileOk not lower.
- Standalone test262 A/B on propertyHelper includers plus 300 random: no
  pass→fail, no new trap.
