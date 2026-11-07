---
id: 7325
title: "issue-3519 tests pin the removed host-assisted regime: move the imported-call planning hook to the native-first route"
status: in-progress
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [3519, 6979, 7108, 7313]
assignee: "ttraenkler/c-r11"
---

# #7325 — imported-call planning hook on the native-first route

## Problem

Two tests in `tests/issue-3519-ir-outcomes.test.ts` pass
`semanticProviders: "host-assisted"`. #6979 S7-a made that option a compile
error, so both are red on `main`. They stayed unnoticed because CI's
`changed-root-tests` lane runs a root test file only when a PR touches it.
#7313 (PR #7170) touched it.

- **"records the compiler-injected timer wrapper as an exact IR terminal".**
  Under the native profile the fixture's arrow callback `() => {}` has no
  closure plan (`closure-return-type`). `delayed` then stays legacy, and the
  timer shim follows it.
- **"does not demote unexpected imported-call planning throws".** The
  injection hook `JS2WASM_TEST_INJECT_IR_IMPORTED_PLAN_THROW`
  (`src/codegen/ir-imported-call-planning.ts`) sits only in the certified
  module-import arm. Native-first plans the cross-module call through the
  program callable graph (`planProgramCallableCall`), so the injection is
  never reached.

## Fix

- **One module-level hook.** `injectImportedPlanningFailure(ownerName)` is
  called first inside both planning `try` blocks: the program callable graph
  and the certified module import. Both are classified by the same
  `classifyIrFailure(error, "resolve")`. Without the env variable it is a
  no-op, so compiled output is unchanged.
- **The tests drop the removed option.**
  - The imported-call test runs under the default profile.
  - The timer test uses a function-expression callback, which the native
    profile plans. Its ledger contract does not depend on the profile.

No test is skipped. `tests/issue-3519-ir-outcomes.test.ts`: 30/30.
