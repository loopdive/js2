---
id: 7391
title: "Legacy: a var initialised with a number and then assigned a function throws `g is not a function` when called"
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
related: [7287, 7392]
---

# #7391: `var g = 3; g = function…; g(1)` throws a false TypeError

## Problem

Checked through the test262 runner (`runTest262File`) on main `89e47482`:

```js
var g = 3; g = function (a) { return a + 1; };
var r; (function(){ r = g(1); })();
assert.sameValue(r, 2);
```

- **standalone and gc:** fail with `TypeError: g is not a function`.
- **node:** `r === 2`.
- **The call site does not matter.** A direct top-level call
  (`var r = g(1);`) and a call from a named function fail the same way.
  `var g; g = function…` (no number initialiser) passes on both lanes.
- **It is legacy-only.** With `experimentalIR: false` the module still
  throws when run on gc. With the IR on, every unit is legacy
  (`<module-init>`: `body-shape-rejected`).
- **A bare compile does not reach this.** It stops earlier with the TS
  diagnostics `Type '(a: any) => any' is not assignable to type 'number'`
  and `This expression is not callable`. The runner passes
  `skipSemanticDiagnostics: true`, so the program compiles.

**Likely cause:** the slot is typed from the initialiser `3` (number). The
function assignment is coerced into that slot, so the call sees a number.

## Direction

- **Option 1: a dynamic slot.** When a script `var` is assigned values from
  more than one type family, give it a dynamic (externref) slot instead of
  the initialiser's type.
- **Option 2: a dynamic call.** At the call, when the checker says "not
  callable", read the slot as a dynamic value and call through the dynamic
  call path (`__apply_closure`), not a static throw.
- **Test:** pin the repro on standalone and gc.
