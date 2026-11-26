---
id: 7473
title: "Ordinary pipeline: a default in an array destructuring assignment gives NaN"
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

# #7473 — Ordinary pipeline: a default in an array destructuring assignment gives NaN

## Problem

A wrong answer on the ordinary pipeline, default target and `--target standalone` alike. Found while fixing
[#7456](7456-ordinary-shorthand-destructuring-script-var-wrong-value.md) (PR #7430).

## Reproduction (2026-11-26, `origin/main` `6694a8b839`)

Each body is `export function g() { <body> }` in a `.js` file; the function compiles through legacy.

| Body | node | js2wasm (both targets) |
| --- | ---: | ---: |
| `var n; [n = 5] = []; return n;` | 5 | NaN |
| `var n; ({ n = 5 } = {}); return n;` | 5 | 5 |
| `let n; ({ n = 5 } = {}); return n;` | 5 | 5 |
| `var { n = 5 } = {}; return n;` | 5 | 5 |

Only the array-pattern ASSIGNMENT form is wrong; the object forms and the declarations answer like node.

## Acceptance criteria

- The array form answers 5 on both targets; also with a present element (`[n = 5] = [7]` → 7), an `undefined`
  element (`[n = 5] = [undefined]` → 5), and nested defaults.
- Pin tests that fail on main.
- JS-environment output byte-identical except for programs with a default in an array destructuring assignment.
