---
id: 5204
title: Builtin-derived methods with arguments, rest params, and getters never bridge to the host — supportsHostClassBridgeParam rejects f64
status: done
assignee: ttraenkler/opus-dev-5203
completed: 2026-08-29
sprint: current
# (#5204, 2026-08-29) The externref-backed class bridge gained three shapes —
# f64 parameter coercion, a class-qualified vararg bridge, and a
# class-qualified getter bridge — plus the accessor receiver-type fix that made
# a getter bridgeable at all. Restated here (not only in the #5193/#5202 issue
# files this branch stacks on) so the grant is not stranded when CI diffs the
# merge preview.
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/index.ts
  - src/runtime.ts
# The +1 is ONE `ctx.funcMap.get("__unbox_number")` lookup in
# `hostClassBridgeParamCoercion`, passed straight into `callArgCoercionInstrs`
# — the single coercion engine (#1917/#2108). No new ToNumber matrix is
# hand-rolled; the helper index is what the engine needs as an argument, and
# the two sibling bridge sites in the same file already do exactly this.
coercion-sites-allow:
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/index.ts::generateModule
  - src/runtime.ts::resolveImport
priority: high
horizon: m
goal: standalone-gap
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
---

# #5204 — host class bridge rejects f64 parameters (NOT a timing issue)

## Problem

On a builtin-derived class (`class D extends Array`), instance members
beyond zero-arg methods never work through the host dispatch path — at init
time AND after init (measured by dev-5202 with after-init-only controls on
base, so this is pre-existing and NOT the #5193/#5202/#5203 timing window):

- a method taking arguments (`add(x: number, y: number)`) →
  `add is not a function`;
- a rest-param method (`sum(...xs: number[])`) → `sum is not a function`;
- a getter (`get g()`) → reads `NaN`.

## Mechanism (located by dev-5202)

`emitExternrefClassMethodDispatch` publishes the class-qualified bridge only
when every parameter passes `supportsHostClassBridgeParam`, and an `f64`
parameter does not pass. jsbi's `__clzmsd()` is zero-arg, which is why the
Temporal harness got past it — but the next jsbi instance method with
arguments will hit this, so it sits directly on the #4628 critical path
behind #5203.

## Direction

Teach the host class bridge to marshal `f64` (and the rest-param vec)
parameters — the generic host-call marshalling for free functions already
handles numbers, so the gap is likely the bridge's parameter-type allowlist
plus the call-site coercion, not new marshalling machinery. Getters need
the `__call_get_*` surface to accept the same widening. Decide with
evidence; measure the allowlist's other rejections while there and record
which remain (don't widen speculatively beyond f64/rest/getter).

## Acceptance criteria

1. New tests/issue-5204-*.test.ts: `add(x,y)`, `sum(...xs)`, `get g()` on
   `class D extends Array`, host lane, at-init AND after-init, failing on
   base, passing with fix.
2. Temporal harness measured before/after on the full stack
   (#5252+#5256+#5258+#5203-fix+this) — record where init stops.
3. No regressions in the issue-5191/5201/5202 test files + scoped class
   method runs (name them). Gates green.

## Notes

- Blocker chain context: #5191 → #5193 → #5201 → #5202 → #5203 (timing) →
  this (capability). Both #5203 and this are expected to be needed before
  `moduleInitRuns` flips true.
- Id #5204 reserved with a degraded PR scan (gh offline); manually verified
  against open PR head branches 2026-08-29. Note: PR #5204 (the selfhost
  PR) shares the number — unrelated; ids and PR numbers share one sequence.
  `check:issue-ids:against-main` arbitrates.
