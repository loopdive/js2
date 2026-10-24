---
id: 7124
title: "IR: unmasked module-init census — where `call-resolution-unsupported` actually blocks test262 bodies"
status: done
sprint: current
created: 2026-10-22
updated: 2026-10-22
completed: 2026-10-22
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/lead-c-remote"
# 2026-10-22: the opt-in census hook reads and resets select.ts's private
# first-wins reject recorder (`typedShapeRejectReason`/`shapeRejectDetail`),
# so it has to sit beside `assessModuleInit`; +43 lines, env-gated, no codegen.
loc-budget-allow:
  - src/ir/select.ts
---

# #7124 — unmasked module-init census for `call-resolution-unsupported`

## Problem

The brief (rc-2) put `call-resolution-unsupported` in ~21/200 test262 bodies
on the IR stack and asked for the largest exact callee cluster to become
IR-claimable. On `main` (b64438ca) the census reported it in **1/200**. The
difference is masking: the module-init assessment stops at the first rejected
top-level statement, and in a test262 file that statement is always harness
code (`assert` out of scope on `main`; `message.toString()` in the `assert`
closures on #6839's stack). Each test's own blockers never get reported.

## Change

`JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1` (only together with
`JS2WASM_IR_SHAPE_DIAG=1`) makes `assessModuleInit` record every rejected
top-level statement as `<reason>@<arm>:<NodeKind> «text»`, joined with `" | "`
into the unit's `detail`. The first reason still decides the unit, so the claim
outcome is unchanged, and with the variable unset the code path does not run.
A rejected `var` still enters scope, so later reads of it are not
double-counted. Test: `tests/issue-7124-module-init-all-rejects.test.ts`.

## Measured (N=200, SEED=7, standalone, census script from the rc-2 brief)

On #6839's head (bb84d4dc, which carries #6829/#6831/#6833/#6830/#6832/#6834),
with the unmasked census:

| Arm (all `call-resolution-unsupported`) | tests | rows | Callee shape |
| --- | --- | --- | --- |
| `expr-object-define-property-target` | 19 | 26 | ambient `Object.defineProperty(o, k, d)` |
| `expr-local-call-target` | 5 | 6 | function value in a `var`/`const` called later |

Plus one test-local unit (`argumentsAndDefineOwnProperty`), which is the same
defineProperty arm on `arguments`. Total: 24/200 tests.

**No test has `call-resolution-unsupported` as its only test-body blocker
(0/24).** Every one also has `var` declarations (#6835/#7114) and, for the
defineProperty cluster, non-inert `{}` / getter-literal descriptors in front of
it. Admitting either arm alone moves `ir_only_pass` by 0 today.

## Why no arm was admitted in this PR

- **`Object.defineProperty` (largest cluster).** The IR arm exists but only
  for the host lane (`objectDefinePropertyTarget` returns `null` on
  standalone/WASI/strict-no-host). On standalone, legacy goes through
  `emitDefinePropertyDescRuntime` → `__obj_define_from_desc`. That path
  reifies a closed-struct descriptor into a `$Object` (#2372/#4180), routes
  proxies (#1355/#6651), throws for null accessors, and marks the
  `(target, key)` pair runtime-defined so later reads go dynamic
  (`markRuntimeDefinedProperty`). The test targets are `var obj = {}` and
  array literals. IR lowers `{}` to a zero-field closed struct and claims it
  only when inert (#4471), so the define has nowhere to land that the IR's
  later `obj.prop` reads would see. Matching legacy needs an open-object
  (`$Object`) carrier for IR object literals first. That is architectural, not
  an exact slice, and claiming it now would produce wrong code.
- **`expr-local-call-target`.** `var func = function…; func(…)`,
  `ref = function(a = 23) {…}`, `var g = function*(){}; g()`,
  `const testExtendedCharacterClass = testPropertyOfStrings` (harness alias).
  These are function values as call targets, which belong to #6831/#6833.
  Left to them.

## What's left

1. Open-object IR carrier for non-inert object literals on standalone. This
   blocks the defineProperty cluster and the descriptor/getter literals in front
   of it. Then a standalone `objectDefinePropertyTarget` → `__obj_define_from_desc`
   with legacy's descriptor reification and rejection throw.
2. Re-run this census after #6835 and #6845 land. Both change which statement
   is first, so the arm counts above will shift.
