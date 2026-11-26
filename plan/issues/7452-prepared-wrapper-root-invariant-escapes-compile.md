---
id: 7452
title: "Prepared path: an invariant error escapes `compile()` for a function value stored in a property"
status: done
completed: 2026-11-26
created: 2026-11-22
updated: 2026-11-26
priority: high
horizon: s
goal: ir-full-coverage
sprint: Backlog
related: [7354]
---

# #7452 — Prepared path: an invariant error escapes `compile()` for a function value stored in a property

## Problem

```js
function g(k){ var x = function(){ return 7; }; var h = {}; h.v = x; return typeof h.v + (h.v === x); }
var out = g(1);
```
throws `PreparedIrProgramInvariantError … wrapper root` out of `compile()` on `main`. No input may make `compile()` throw; the function must lower, or refuse by name (an abort body under the test262 policy).

Found on 2026-11-22 during the #7354 slices (Prepared whole-program IR path).

## Acceptance criteria

- The program compiles and returns `"functiontrue"`, or refuses with a named diagnostic.
- No exception leaves `compile()`.

## Resolution (2026-11-26): does not reproduce on main `6694a8b83`; acceptance holds via the named refusal

Measured by S10 through the strict Prepared entry (`src/test262/test262-prepared-entry.ts`, standalone).

- **The issue's exact program,** under both `unlowerableBodies` policies and as `test.js` and `test.ts`: no
  exception leaves `compile()`.
  - Under `abort` (the test262 default) the program compiles, and `g` is an abort body (#7354 U) with the named
    reason `operand-coercion-unsupported: ir/from-ast: Phase 1 requires matching operand types for '===' in g`.
    Calling it traps, the designed run-time abort.
  - Under `refuse` the compile fails with that same named diagnostic.
- **At the filing commit `0caf9b56b`:** the same result.
- **Seven variants, no escape:** a property-stored function value compared, `typeof`'d or called, at script level
  and inside a function, a declaration as well as an expression. Each compiles and runs, or refuses by name
  (`method-call-unsupported` for `h.v()` on the externref, `typeof of non-static IrType … is deferred`).

The acceptance criterion, "returns `"functiontrue"`, or refuses with a named diagnostic; no exception leaves
`compile()`", holds through its second branch. Making the program return `"functiontrue"` would mean lowering `===`
between a dynamic home's value and a closure value. That is a different task, not started; the C lead's decision of
2026-11-26.
