---
id: 7424
title: "Array destructuring of a class iterator does not call return() on early exit"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7413]
---

# #7424: destructuring a class iterator skips `return()`

## Problem

Found by RV7342's review of PR #7342 (#7413), measured on main `89e47482`; details in https://github.com/loopdive/js2/pull/7342#issuecomment-7019348242. The probe encodes the argument as undefined→1, null→2, other→3, plus `10 * arguments.length`.

`const [a] = new It()` stops before the iterator is done, so §8.6.2
IteratorClose must call `return()`.

- **Node:** `return()` runs (`r = 1`, `rl = 0`).
- **Ours (gc, standalone, wasi):** `return()` never runs. The probe reads
  1199 (after #7413: 1099) against node's 110.
- **Object-literal iterators are correct;** only class iterators are
  affected.

## Acceptance

`return()` runs exactly once on early exit from array destructuring of a
class iterator, on all three targets. A test pins node's answer.
