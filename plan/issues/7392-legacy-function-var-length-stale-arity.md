---
id: 7392
title: "Legacy: `.length` of a var holding a function reads a stale arity (first assigned function, or a builtin of the same name)"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7287, 7391]
---

# #7392: `p.length` after reassigning `p` gives the old function's length

## Problem

Checked through the test262 runner (`runTest262File`) on main `89e47482`;
node passes every one:

| body | standalone and gc | node |
|---|---|---|
| `var p = function (v) {}; p = function (a, b) {}; assert.sameValue(p.length, 2);` | `1` | `2` |
| `var p = function (v) {}; var p = function (a, b) {}; assert.sameValue(p.length, 2);` | `1` | `2` |
| `var isNaN = function (a, b) {}; assert.sameValue(isNaN.length, 2);` | `1` | `2` |
| `var print = function (a, b) {}; function h(){ return print.length; } assert.sameValue(h(), 2);` | `0` | `2` |

- **Calls are correct.** `p()` runs the second function. Only `.length`
  reads a static arity: the first function bound to the name, or the
  builtin's (`isNaN` is 1).
- **`var foo = function (a, b) {}`** (one binding, no builtin) gives `2`.
- **The `print` row is a real failure under the runner.** The runner's
  assembled program (`assembleOriginalHarness`) starts with its own
  `var print = function (value) { console.log(value); }`, so the test's
  `var print` is a second declaration. Run in a node `vm` context, that
  assembled program **passes** (`print.length` is 2). The compiler gives 0,
  which is neither function's length. The runner defines no `isNaN`.
- **It is legacy-only.** With `experimentalIR: false` a bare compile (gc,
  `skipSemanticDiagnostics`) of
  `var p = function (v) {}; p = function (a, b) {}; var n = p.length;`
  gives `n === 1`. With the IR on, `<module-init>` (where `p.length` is
  read) is legacy.

## Direction

- **Option 1: read the value.** `.length` on an identifier whose binding is
  written more than once (or that shadows a builtin global) reads the
  function object's own `length` at run time. It should not fold the arity
  of a declaration it found by name.
- **Option 2: restrict the fold.** Keep the static fold only when the
  binding has exactly one write, and that write is a function expression in
  the same file.
- **Test:** pin the four rows on standalone and gc.
