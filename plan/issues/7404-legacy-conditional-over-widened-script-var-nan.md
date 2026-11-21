---
id: 7404
title: "Legacy: `c ? n : 0` over a script var later set to a string gives NaN instead of the string"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7331, 7392]
---

# #7404: a conditional over a widened script var ToNumbers the string

## Problem

This is a wrong answer. Checked through the test262 runner
(`runTest262File`) on main `89e47482`:

```js
var n = 1; function set(){ n = 'x'; }
function h(c) { return c ? n : 0; }
assert.sameValue(h(1), 1);
set();
assert.sameValue(h(1), 'x');
```

- **standalone and gc:** the first assert passes. The second fails with
  `Expected SameValue(«NaN», «"x"»)`.
- **node:** `1`, then `'x'`.
- **It is legacy-only.** A bare gc compile (`skipSemanticDiagnostics`) gives
  `NaN` for `h(1)` after `set()`, with or without `experimentalIR: false`.
  With the IR on, every unit is legacy on main (`h`: `body-shape-rejected`).
  After PR #7313's mixed-conditional rule, `h` is refused at select, so
  legacy runs it there too.
- **The conditional is the trigger, not the return.**
  - `var r = c ? n : 0; return r;` gives `NaN` the same way.
  - The same conditional in another function (`var v = c ? n : 0` inside
    an exported `test()`) gives `NaN`.
  - A plain `return n;` gives `'x'` (passes).
- **A bare compile without `skipSemanticDiagnostics` stops on the TS
  diagnostic** for `n = 'x'`, because the checker types `n` as `number`.

**Hypothesis (unverified):** legacy types the conditional from the checker's
`number`, and `0` is an f64 arm. It then ToNumbers the read of `n`, whose
slot was widened to hold `'x'`. So the string becomes `NaN` before the
result is returned.

## Direction

- **Option 1: type the conditional from the slot.** When an arm reads a
  script var whose slot is widened (dynamic or externref) because it is
  written with another type family, give the conditional a dynamic result.
  Do not coerce the arm to f64.
- **Option 2: make the read follow the slot.** Have the widened var's read
  report its real slot type, so the conditional's arms join to dynamic
  instead of f64.
- **Test:** pin the repro on gc, standalone and wasi, plus the
  `var r = c ? n : 0` form.
