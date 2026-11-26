---
id: 7483
title: "Ordinary pipeline: two function declarations of one name in a .js file are a compile error"
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

# #7483 — Ordinary pipeline: two function declarations of one name in a .js file are a compile error

## Problem

JavaScript allows a function declaration to be redeclared; the last one wins. js2wasm rejects a `.js` file with two
`function h` declarations with the TypeScript diagnostic "Duplicate identifier 'h'", on the default target and
`--target standalone`. Reported as a pre-existing item in review RV7430 of PR #7430
([#7456](7456-ordinary-shorthand-destructuring-script-var-wrong-value.md)).

## Reproduction (2026-11-26, this branch `claude/7456-shorthand-destructuring-var` (bba4406bd9 + the RV7430 fix); every row answers the same on `origin/main` `41f0654e8c`)

```js
function h() { return 1; } function h() { return 2; }
export function g() { return h(); }
```

| | node | js2wasm (both targets) |
| --- | ---: | --- |
| `g()` | 2 | CE `Duplicate identifier 'h'` |

## Acceptance criteria

- The program compiles on both targets and `g()` answers 2 (the last declaration wins); a `.ts` file keeps its
  diagnostic.
- A test pins it, including a redeclaration inside a function body.
