---
id: 7463
title: "Realm-backed callable row for the native getter resource-join fixture"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: test
area: ir, backend
goal: ir-full-coverage
depends_on: [7354]
related: [7354, 3518]
origin: "2026-11-26 #7415 merge: the callable row of tests/issue-3518-native-getter-resource-join.test.ts became an expected-limit pin"
---

# #7463: the getter resource-join fixture's callable row needs the realm's native call bindings

## Problem

`tests/issue-3518-native-getter-resource-join.test.ts` runs four getter programs (number, boolean, false, callable)
through a fixture that reserves and fills only the native invocation and string-value packs. It has no realm.

Since F1 (function values), a callable getter result is a function value, and creating one calls the realm's
`js.object.init-function`. The fixture's getter resolver serves no realm call, so filling the callable row's getter
body stops with `unowned callable in actual getter control: js.object.init-function`.

This failed on main (313281866f) before #7415 touched the file, first at the getter's `name` string (no string
runtime in the fixture). #7415 passes the reserved string pack to the fill, as the program consumer does, and pins
the remaining limit by name. The pin is not a skip: the behaviour runs end to end, against node, in
`tests/issue-7354-o2-accessors.test.ts` (getters that return functions).

## Implementation Plan

- Give the fixture the realm's native call bindings through the path the program consumer already uses: the source
  object setup from `planNativeSourceObjectSetup` (src/backend/wasmgc/program/native-invocation-abi.ts) and the
  reconciliation in src/ir/program-consumer.ts.
  - `reconcileNativeCallBindings` is module-private and needs the physical setup plan plus a reserved realm.
  - Either expose a narrow, reusable entry point for it, or build the fixture on the consumer's own reservation of
    the realm. Do NOT add a second wiring path in the test.
- Then flip the callable row's pin back to the run assertion: `runtime.invoke(runtime.get(closure))` equals node's
  answer.

Acceptance:

- The callable row runs and matches node for decoded false and true.
- No test-only copy of the consumer's realm wiring.
- The number, boolean and false rows are unchanged.
