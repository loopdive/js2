---
id: 7461
title: "Prepared path: `const c = 1; c = 2;` throws an exception out of `compile()`"
status: ready
created: 2026-11-23
updated: 2026-11-23
priority: medium
horizon: s
goal: ir-full-coverage
sprint: Backlog
related: [7354]
---

# #7461 — Prepared path: `const c = 1; c = 2;` throws an exception out of `compile()`

## Problem

On main, the Prepared path throws out of `compile()` for an assignment to a `const` binding. No input may make `compile()` throw. JS throws a catchable TypeError at run time when the assignment executes.

## Acceptance criteria

- The program compiles and throws a catchable TypeError at the assignment, or refuses by name.
- No exception leaves `compile()`.
