---
id: 7482
title: "Ordinary pipeline: a nested function declaration that shadows a module one calls the module one"
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

# #7482 — Ordinary pipeline: a nested function declaration that shadows a module one calls the module one

## Problem

When a function declares its own `function h` and the module also declares `h`, a call to `h` inside that function
runs the module `h`, on the default target and `--target standalone`. No write is involved. Reported as a
pre-existing item in review RV7430 of PR #7430 ([#7456](7456-ordinary-shorthand-destructuring-script-var-wrong-value.md)).
`funcMap` is keyed by the bare name, so the nested declaration's lookup can land on the module entry; the result
depends on declaration order.

## Reproduction (2026-11-26, this branch `claude/7456-shorthand-destructuring-var` (bba4406bd9 + the RV7430 fix); every row answers the same on `origin/main` `41f0654e8c`)

Each program is `<declarations>\nexport function g() { <body> }` in a `.js` file; every function compiles through
legacy.

| declarations | body | node | js2wasm (both targets) |
| --- | --- | ---: | ---: |
| `function h() { return 1; } function o() { function h() { return 5; } return h(); }` | `return o();` | 5 | 1 |
| `function o() { function h() { return 5; } return h(); } function h() { return 1; }` | `return o() * 10 + h();` | 51 | 51 |
| `function h() { return 1; } function o() { function h() { return 5; } h = function () { return 6; }; return h(); }` | `return o() * 10 + h();` | 61 | 11 |

The third row is RV7430's program; #7456's review round 1 checked that its bytes equal main's.

## Acceptance criteria

- Every row answers like node on both targets: a call resolves to the declaration in scope, by binding identity, not
  by name.
- A test pins the rows; programs without a same-named nested declaration keep their bytes.
