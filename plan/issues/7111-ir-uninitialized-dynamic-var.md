---
id: 7111
title: "IR: `var x;` (no initializer) as the dynamic undefined; a planned member closure's own var proof"
status: in-review
sprint: current
created: 2026-10-21
updated: 2026-10-21
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
depends_on: [7110]
assignee: "ttraenkler/session-d"
# 2026-10-21 (#7111): the selector's uninitialized-var arm + the move-only
# scan's matching dynNames entry, and from-ast's `lowerUninitializedVar`.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::dynamicUsesAreMoveOnly
---

# IR: `var x;` as the dynamic undefined

Parent: [#7106](7106-ir-test262-harness-units.md), Stage 4 (`<module-init>`). This slice is stacked on
[#7110](7110-ir-module-init-void-member-closures.md).

## Problem

After #7110, `assert.throws`'s member closure in assert.js stopped at
`var expectedName, actualName;` (`vardecl-var-kind`). This was measured with
a probe that strips `new Test262Error(x)` to `(x)`, because Stage 3c is out of
scope here. Two separate gaps caused it:

1. The function-local `var` proof (`collectIrSafeVarDeclarationLists`) was
   computed only for the claimed subject, which here is `<module-init>`. It
   never covered a planned member closure's own body, so even
   `var x = 1;` inside one was rejected.
2. A declaration with no initializer was always rejected (`vardecl-noinit`),
   and from-ast had no lowering for it.

## Fix

- **Selector:**
  - A planned member closure computes its own safe-var proof.
  - `uninitializedVarIsDynamicUndefined` admits `var x;` (no initializer)
    only when all of these hold:
    - the declaration is untyped and is a plain `var` (not lexical, not in a
      for-head);
    - it passes the function-local var proof;
    - the dynamic runtime is buildable;
    - it is in a dynamic-carrier context: the function has a dynamic
      parameter, so the move-only scan runs and now tracks the binding as
      dynamic, or it is a planned closure with one;
    - it is NOT inside a loop. A re-executed `var x;` keeps its value, while
      the IR initializes at the declaration point.
- **from-ast** (`lowerUninitializedVar`): the binding is `dyn.undefined`.
  When the body reassigns it, it gets a dynamic slot. This matches legacy,
  which types the `any` binding `externref` and starts it undefined.
- **Prepared dynamic support** names `dyn.undefined` on the native-string
  externref lane. That is the extern-wrapped `$undefined` singleton, which
  calls nothing.

## Acceptance

- `tests/issue-7106-uninitialized-var.test.ts` checks every result against
  node:
  - a top-level JS function with `var a;` is an IR body;
  - the in-loop `var v;` stays legacy;
  - a module-init member closure declaring `var seen, other;` is a prepared
    IR body.
- `tests/issue-3783-ir-function-local-var.test.ts` passes. Its `missing()`
  case (TS, no dynamic parameter) stays rejected.
- Neighbouring var/7106 suites show no new failures against the same files
  on the base tree.
- Census (Test262Error-stripped probe): `<module-init>` moves to
  `call-resolution-unsupported`. That is `func()` in `assert.throws`: a call
  through a dynamic parameter (`expr-local-call-target`). This is not covered
  by #6821's `bodyCallsDynamicParamCallee`, which handles calls TO local
  functions that have dynamic parameters. It is the next slice.
