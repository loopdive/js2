---
id: 7481
title: "Ordinary pipeline: calling a recursive function declaration through a value throws TypeError"
status: ready
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
sprint: Backlog
related: [7456]
---

# #7481 — Ordinary pipeline: calling a recursive function declaration through a value throws TypeError

## Problem

A function declaration that calls itself throws a TypeError when it is called through a value (`var o = h; o(3)`),
on the default target and `--target standalone`. A direct call `h(3)` is right. Reported as a pre-existing item in
review RV7430 of PR #7430 ([#7456](7456-ordinary-shorthand-destructuring-script-var-wrong-value.md)), where it was
described as "a recursive declaration that is ever written"; the measurement below shows the write is not needed.

## Reproduction (2026-11-26, this branch `claude/7456-shorthand-destructuring-var` (bba4406bd9 + the RV7430 fix); every row answers the same on `origin/main` `41f0654e8c`)

Each program is `<declarations>\nexport function g() { <body> }` in a `.js` file; `g` compiles through legacy.

| declarations | body | node | js2wasm (both targets) |
| --- | --- | ---: | --- |
| `function h(n) { return n <= 0 ? 0 : 1 + h(n - 1); }` | `var o = h; return o(3);` | 3 | throws |
| same | `var o = h; return o(0);` (no recursion runs) | 0 | throws |
| same | `try { var o = h; return o(3); } catch (e) { return e instanceof TypeError ? -1 : -2; }` | 3 | -1 (TypeError) |
| same | `return h(3);` | 3 | 3 |
| same + `function k() { return 100; } function w() { h = k; }` | `var o = h; return o(3);` | 3 | throws |
| same + `function k() { return 100; }` | `var o = h; h = k; return o(3);` | 101 | throws |
| `function h(n) { return n + 1; }` (not recursive) | `var o = h; return o(3);` | 4 | 4 |

The throw happens even for `o(0)`, where the body never reaches its self-call, so the value form of a
self-referencing declaration is broken at entry, not in the recursion.

## Acceptance criteria

- Every row answers like node on both targets, including the reassigned rows (101: the inner call reads the live
  binding).
- A test pins the rows; the non-recursive and direct-call rows keep their bytes.
