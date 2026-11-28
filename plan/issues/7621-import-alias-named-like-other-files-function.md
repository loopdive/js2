---
id: 7621
title: "Import alias named like another file's own function calls that function (IR path off)"
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

# #7621 — an import alias named like another file's own function calls that function

## Problem

Found while planning #7530 (row I0). In a `compileMulti` program, file A imports `f` under the alias `k`
(`import { f as k } from "./dep"`), and a third file declares its own top-level `function k`. With the IR path off,
A's `k()` calls the third file's `k` instead of dep's `f`. Nothing is reassigned. With the IR path on, the answer is
right.

This is the [#4133](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4133-cross-module-function-name-collision-wrong-answer)
family: two files' functions sharing one bare-name `funcMap` entry. Here the entry is the import alias's local name.

## Repro

```ts
// entry.ts
import { f as k, swap } from "./dep";
import { h } from "./c";
export function main(): number { swap(); return k() * 10 + h(); }
// dep.ts
export function f(): number { return 1; } export function swap(): void {}
// c.ts
function k(): number { return 5; } export function h(): number { return k(); }
```

Measured on ada18e6bb6 (#7558 head) on 2026-11-28 with `compileMulti` (probe `.tmp/7530/probe.mts` in the #7530
worktree); node 22 runs the transpiled sources.

| | node | gc IR on | gc IR off | standalone IR on | standalone IR off |
| --- | --- | --- | --- | --- | --- |
| I0 | 15 | 15 | 55 | 15 | 55 |

## Acceptance criteria

- I0 answers 15 on gc and standalone with the IR path on and off, pinned with a `compileMulti` test that fails on
  main.
- #7530's row I (the same shape with `f` reassigned) then also runs with the IR path off.
- Single-file output stays byte-identical.
