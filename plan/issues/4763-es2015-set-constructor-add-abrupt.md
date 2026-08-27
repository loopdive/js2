---
id: 4763
title: "ES2015 Set constructor adder lookup/call abrupt completion"
status: ready
created: 2026-08-26
updated: 2026-08-27
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
model: gpt-5.6-luna
task_type: conformance
area: codegen, runtime
es_edition: es2015
goal: test262-conformance
parent: 4762
assignee: ttraenkler/codex-es6-closeout
files:
  - src
  - tests
  - plan/issues/4763-es2015-set-constructor-add-abrupt.md
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/proto-index-store.ts
func-budget-allow:
  - src/codegen/expressions/new-super.ts::compileNewExpression
---

# #4763 — ES2015 Set constructor adder abrupt completion

## Problem

`test/built-ins/Set/set-get-add-method-failure.js` is no longer hidden behind
a realm-cleanup timeout after #4762. The maintained host run
`20260826-232826` fails with an uncaught non-stringifiable Wasm-GC exception;
the authoritative standalone run `20260826-194014` fails because the expected
`MyError` is not thrown. Both lanes must propagate the abrupt completion from
the Set constructor's `Get(set, "add")`/adder call path as the original error.

## Implementation plan

1. Reduce getter-throws and callable-adder-throws cases independently in host
   and standalone, with a normal custom-adder control.
2. Trace the Set constructor lowering through property lookup, callable bridge,
   and exception transport; preserve the original thrown identity/type.
3. Implement the shared abrupt-completion path without a host oracle, skip,
   fixture rewrite, or lane-specific expected result.
4. Add focused regressions for getter throw, call throw, single lookup/call,
   and normal insertion, then rerun the exact Test262 row in both lanes.

## Evidence

Permanent focused coverage is in `tests/issue-4763.test.ts` (8 cases: getter
throw, callable-adder throw, per-element custom adder dispatch, and ordinary
construction in both host and standalone lanes).

The exact Test262 row is
`test/built-ins/Set/set-get-add-method-failure.js`, with a denominator of one
row in each run:

- Before this work, host run `20260827-015117`: 0/1 (opaque uncaught Wasm-GC
  exception); standalone run `20260827-015450`: 0/1 (`MyError` was not thrown).
- After the standalone constructor dispatch/classification change, standalone
  run `20260827-021212`: 1/1; host run `20260827-021129` remained 0/1 because
  runtime bookkeeping called the user-replaced `Set.prototype.add`.
- After the primordial runtime bookkeeping fix, host run `20260827-023303`:
  1/1 (100%); standalone run `20260827-023349`: 1/1 (100%).

The maintained runner creates 16 shard files for this path filter; the other
15 are empty and report `No test suite found`. They do not contribute rows to
the one-row result denominator.

## Acceptance

- The exact Test262 row passes in host and standalone.
- Getter and adder are each observed exactly once and the original exception is
  catchable by compiled code.
- The normal Set construction control remains passing with zero new host import.
