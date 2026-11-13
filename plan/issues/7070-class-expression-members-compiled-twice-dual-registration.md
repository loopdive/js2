---
id: 7070
title: "class EXPRESSION members are compiled twice by the direct path (`C_*` and `__anonClass_N_*`, the #1394 dual registration); the receipt audit reports `duplicate-direct-function-body-receipt`"
status: ready
sprint: Backlog
created: 2026-10-18
updated: 2026-10-18
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: refactor
area: ir, codegen, classes
language_feature: class-expression
goal: ir-full-coverage
related: [7002, 3522, 1394, 3045, 5308]
---

# Class-expression members compile twice

Split out of [#7002](./7002-ir-gate-integrity-telemetry-stride-ledger.md) step 2.
It is NOT a small fix inside shared IR code: the duplicate is the direct-AST
class-collection design, which the old-path development freeze
(`plan/method/ir-only-development-freeze.md`) covers, and the compile-once
work for classes is owned by #3522 (R3). Needs that owner's disposition.

## Evidence (main `2cc15166`, 2026-10-18)

`var C = class { get a() { return 1; } m() { return 2; } }; export function f() { return 1; }`
with `target: "standalone", trackIrOutcomes: true`:

- `compileClassBodies` runs twice for the same `ClassExpression` node:
  1. `compileClassesFromStatements` → var-statement branch
     (`src/codegen/declarations.ts` ~L5750, "Variable-bound class expressions
     are registered under both the visible binding and a canonical synthetic
     identity") → bodies `C_m`, `C_get_a`;
  2. `compileAnonymousClassBodiesInNode` → `compileAnonClassIfNeeded`
     (~L5908) → bodies `__anonClass_0_m`, `__anonClass_0_get_a`.
- Both entries resolve to the same inventory unit, so the receipt audit
  (`src/codegen/legacy-body-audit.ts` `#indexClassMemberBodyReceipt`) counts 2
  and the reconcile records `invariant / patch / body-emission-evidence`
  (`duplicate-direct-function-body-receipt`) for every member.
- Both registrations are the #1394 dual-registration bridge
  (`declarations.ts` ~L2860): the binding name and the synthetic name are
  both live keys for different access paths, so dropping one body is not a
  cache hit — callers keyed on the other name would lose their function.
- Measured in the #7002 test262 stride: this is 24 of the 25 invariants in the
  stride-120 crosstab, and the `invariant` population of the stride-40 ledger
  (`benchmarks/results/ir-claim-ledger-standalone.json`).

Since #7002 the condition no longer fails the compile under telemetry (it is a
warning plus the invariant row), so this is a compile-size/compile-time and
ledger-accuracy problem, not a correctness one.

## Direction

Collapse to one body per member: compile under the synthetic identity only and
make the binding name an alias of it (the #1394 bridge already maps the
var-name to the synthetic name for the prototype path), or have the IR claim
class-expression members so neither direct body runs. Either way it lands on
the #3522 compile-once track, not as a direct-path patch.

## Acceptance

- The repro above records zero `body-emission-evidence` invariants.
- `tests/equivalence/issue-7002-ir-gate-integrity-telemetry-stride-ledger.test.ts`
  "still records the compile-twice invariant ROW" is updated (it asserts the
  current invariant exists).
- The stride-40 ledger's `invariantCodes["patch:body-emission-evidence"]` drops.
