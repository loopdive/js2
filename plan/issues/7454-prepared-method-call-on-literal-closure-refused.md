---
id: 7454
title: "Prepared path: `o.m()` on an object literal holding a function expression is refused"
status: ready
created: 2026-11-22
updated: 2026-11-22
priority: high
horizon: s
goal: ir-full-coverage
sprint: Backlog
related: [7354]
---

# #7454 — Prepared path: `o.m()` on an object literal holding a function expression is refused

## Problem

`function f(){ var o = {m: function(){ return 1 }}; return o.m(); }` refuses with `physical setup cannot be materialized (js.closure.call:0)`. This is the most common method-call shape in the test262 harness and in ES5 tests.

Found on 2026-11-22 during the #7354 slices (Prepared whole-program IR path).

## Acceptance criteria

- The program returns 1 on the Prepared path.
- `this` inside `m` is `o`.
- Mutated twin (returning 2, asserting 1) fails through the real runner.
