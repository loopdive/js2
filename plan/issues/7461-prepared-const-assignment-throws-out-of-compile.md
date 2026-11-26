---
id: 7461
title: "Prepared path: `const c = 1; c = 2;` throws an exception out of `compile()`"
status: done
created: 2026-11-23
updated: 2026-11-26
completed: 2026-11-26
duplicate_of: 7434
priority: medium
horizon: s
goal: ir-full-coverage
sprint: Backlog
related: [7354, 7434]
---

# #7461 — Prepared path: `const c = 1; c = 2;` throws an exception out of `compile()`

## Problem

On main, the Prepared path throws out of `compile()` for an assignment to a `const` binding. No input may make `compile()` throw. JS throws a catchable TypeError at run time when the assignment executes.

## Acceptance criteria

- The program compiles and throws a catchable TypeError at the assignment, or refuses by name.
- No exception leaves `compile()`.

## Resolution (2026-11-26)

Duplicate of [#7434](./7434-prepared-const-reassignment-invariant.md), fixed by the PR that closes #7434. That issue
file is the record; this one stays only so the id resolves. The repro is pinned in
`tests/issue-7434-prepared-const-write.test.ts` ("assignment at top level: the program refuses").
