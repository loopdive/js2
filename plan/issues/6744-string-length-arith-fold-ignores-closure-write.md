---
id: 6744
title: "`s.length` inside arithmetic folds to the initializer's length when `s` is written only by a closure (wrong value, both targets)"
status: ready
sprint: current
created: 2026-09-29
updated: 2026-09-29
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: core-semantics
---

## Problem

A `let` string whose only writes happen inside a closure has its `.length`
constant-folded from the INITIALIZER when the read sits inside an arithmetic
expression. A bare `return s.length` is correct; `s.length * 10` and
`s.length + 0` are not. Found while writing the #6730 regression test.

Measured 2026-09-29 on upstream main `c8b4f0ef36` and on the #6730 branch
(identical), JS-host and standalone give the same wrong answers:

| source (`export function t()`)                                              | node | js2wasm |
| --------------------------------------------------------------------------- | ---- | ------- |
| `let s = "ab"; const y = () => { s = "xyz"; }; y(); return s.length;`       | 3    | 3       |
| `let s = "ab"; const y = () => { s = "xyz"; }; y(); return s.length * 10;`  | 30   | **20**  |
| `let s = "ab"; const y = () => { s = "xyz"; }; y(); return s.length + 0;`   | 3    | **2**   |
| `let s = "ab"; const y = () => { s = "xyz"; }; y(); const n = s.length; return n;` | 3 | 3 |

Nested function declarations show the same thing
(`function print(doc){ let s=""; s+=doc; y(); return s.length*10; function y(){ s=s+"!"; } }`
→ `0`, node `20`).

Likely a static string-length fold in the numeric-context lowering that checks
direct writes in the function body but not writes through a captured (boxed)
binding.

## Acceptance

- The four rows above match node in both targets.
- A regression test failing on the parent and passing with the fix.
