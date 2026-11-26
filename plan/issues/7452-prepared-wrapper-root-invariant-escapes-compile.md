---
id: 7452
title: "Prepared path: an invariant error escapes `compile()` for a function value stored in a property"
status: ready
created: 2026-11-22
updated: 2026-11-22
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
