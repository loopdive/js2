---
id: 7452
title: "Prepared path: an invariant error escapes `compile()` for a function value stored in a property"
status: done
created: 2026-11-22
updated: 2026-11-26
completed: 2026-11-26
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

## Resolution (2026-11-26)

It does not reproduce on `main` (`c3b7be667a`). The program as written does not throw at the filing commit
`0caf9b56b` either. Measured through the strict Prepared entry (`src/test262/test262-prepared-entry.ts`, standalone),
under both `unlowerableBodies` policies, as `test.js` and `test.ts`.

- **The issue's program.** Under `abort` (the test262 default) it compiles, `g` is an abort body named
  `operand-coercion-unsupported` ("Phase 1 requires matching operand types for '===' in g"), and `g(1)` traps in `g`.
  Under `refuse` the compile fails with that same diagnostic. The declaration variant (`function x(){…}` inside `g`)
  behaves the same way, with the diagnostic `body-shape-rejected` ("nested func must have a return type annotation").
- **The throw.** `compile()` threw `PreparedIrProgramInvariantError … native dynamic value resources: the function
  test needs the source closures' wrapper root` when `g` became an abort body holding the program's only function
  value and a lowered `typeof` on a dynamic value elsewhere requested the function test. For example, `g` uncalled
  plus `var q = {}; var out = typeof q.v;`. Two #7354 G1 commits fix it, 3408858181 and the later fd529937ec. With
  them the test falls back to the realm's own wrapper root. Each is enough on its own: on `main` the pin goes red only
  when both are reverted (RV7437).
- **Pin:** `tests/issue-7452-prepared-property-function-value.test.ts`. Both shapes, both variants, both policies and
  both file names. Every row asserts `compile()` returns, plus the exact abort-table row, refusal code and message,
  and, for the second shape, node's answer. The pin is red at `120979fa6e` (the parent of 3408858181, before both
  fixes), where the expression variant of the second shape throws, and green at 3408858181 and on `main`.

Returning `"functiontrue"` would need `===` between a dynamic home's value and a closure value. That is a separate
task and has not been started.
