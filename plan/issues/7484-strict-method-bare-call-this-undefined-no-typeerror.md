---
id: 7484
title: "Ordinary pipeline: a method called through a bare binding reads this.v without a TypeError"
status: ready
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
sprint: Backlog
related: [7456]
---

# #7484 — Ordinary pipeline: a method called through a bare binding reads this.v without a TypeError

## Problem

In a module (strict code), a function extracted from an object and called through a bare binding gets
`this === undefined`, so `this.v` must throw a TypeError. js2wasm returns NaN instead, on the default target and
`--target standalone`. Reported as a pre-existing item in review RV7430 of PR #7430
([#7456](7456-ordinary-shorthand-destructuring-script-var-wrong-value.md)), there phrased as "calling a sloppy method
through a bare binding throws"; that phrasing came from comparing against a sloppy `new Function` oracle, while the
compiled file is a module. The sloppy-script form (no `export`, `this` is the global object) answers correctly.

## Reproduction (2026-11-26, this branch `claude/7456-shorthand-destructuring-var` (bba4406bd9 + the RV7430 fix); every row answers the same on `origin/main` `41f0654e8c` except where noted)

Each program is `<declarations>\nexport function g() { <body> }` in a `.js` file; `g` compiles through legacy.

| declarations | body | node (module) | js2wasm (both targets) |
| --- | --- | --- | --- |
| `var obj = { v: 3, m: function () { return this.v; } };` | `var f = obj.m; return f();` | TypeError | NaN |
| same + `function h() { return 1; }` | `h = obj.m; return h();` | TypeError | NaN (main: 1, the stale direct call that #7456 fixes) |
| `var obj = { m: function () { return 7; } };` | `var f = obj.m; return f();` | 7 | 7 |

Script form, checked with top-level `if (f() !== 9) throw …`: `var v = 9; var obj = { v: 3, m: function () { return
this.v; } }; var f = obj.m;` runs without throwing on both targets, like node's script.

## Acceptance criteria

- In strict code, a property read on `this` when `this` is `undefined` throws a TypeError on both targets; both
  module rows throw like node.
- The script form keeps its answer and its bytes.
