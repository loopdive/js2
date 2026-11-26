---
id: 7462
title: "Prepared path: a closure that writes a script var aborts; `new X` as a direct `+` operand refuses"
status: ready
created: 2026-11-23
updated: 2026-11-23
priority: medium
horizon: s
goal: ir-full-coverage
sprint: Backlog
related: [7354]
---

# #7462 — Prepared path: a closure that writes a script var aborts; `new X` as a direct `+` operand refuses

## Problem

Two shapes found during #7354 G1, both present on main: (1) a closure that writes a script-level `var` (`var n = 0; var f = function(){ n++; }; f();`) ends in the run-time abort ("nondefaultable reference widening"); (2) a `new` expression used directly as an operand of `+` (`"" + new TypeError("m")`) refuses, although the same value through a variable works.

## Acceptance criteria

- Both programs give node's answer.
- Each with a wrong twin that fails.
