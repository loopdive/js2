---
id: 7636
title: "Block-scoped function declaration calls another file's same-named top-level function"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [4133, 7470, 7530]
---

# #7636 — a block-scoped function declaration calls another file's same-named top-level function

## Problem

Found while implementing [#7530](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7530-same-named-reassigned-functions-share-global) (its row AB1). In a
`compileMulti` program, one file declares a top-level `function f`, and a function in another file declares its
own `function f` inside a block and calls it there. That call reaches the first file's top-level `f` instead of
the block's own. Nothing is reassigned.

The same body as a direct nested declaration (no block) is right, and so is the block form alone in one file.

Probable cause, from #7530's Results: `funcMap` is keyed by bare name, and
[#4133](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4133-cross-module-function-name-collision-wrong-answer)'s per-source projection covers top-level
functions only. This is not yet confirmed in the code.

## Repro

```ts
// entry.ts
import { d } from "./dep";
function f(): number { return 1; }
export function main(): number { return f() * 10 + d(); }
// dep.ts
export function d(): number { let r = 0; { function f(): number { return 3; } r = f(); } return r; }
```

Measured on main dae2db2cca on 2026-11-28 with `compileMulti` (probe `.tmp/7530/probe-g-ab.mts` in the #7530
worktree). node runs the transpiled sources.

| shape | node | gc IR on | gc IR off | standalone IR on | standalone IR off |
| --- | --- | --- | --- | --- | --- |
| AB0 (above) | 13 | 11 | 11 | 11 | 11 |
| AB0n (dep: `function f` nested directly in `d`, no block) | 13 | 13 | 13 | 13 | 13 |
| AB0s (the block form alone, one file) | 3 | 3 | 3 | 3 | 3 |

#7530's row AB1, the same graph with entry also reassigning its own `f`, gives 21 for node's 23 after #7530, on
all four lanes.

## Acceptance criteria

- AB0 answers 13 on gc and standalone, with the IR path on and off, pinned by a `compileMulti` test that fails on
  main.
- #7530's row AB1 then answers 23 on all four lanes; add it to that pin file.
- Single-file output stays byte-identical.
