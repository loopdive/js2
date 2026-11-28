---
id: 7635
title: "Direct call through a renamed import of a reassigned function calls the original"
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
related: [7470, 7530, 7621]
---

# #7635 — a direct call through a renamed import of a reassigned function calls the original

## Problem

Found while implementing [#7530](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7530-same-named-reassigned-functions-share-global) (its row G). File A imports
`f` under an alias (`import { f as k } from "./dep"`), and dep reassigns its own `f`. After the reassignment,
A's direct call `k()` still calls the original `f`. Reading the alias as a value first (`const h = k; h()`)
gives the right answer, so only the direct-call path is wrong. No two files share a name here.

Probable cause, from #7530's Results: the alias gets no closure entry, so its direct call does not route through
dep's live-binding global. This is not yet confirmed in the code.

## Repro

```ts
// entry.ts
import { f as k, swap } from "./dep";
export function main(): number { const a = k(); swap(); return a * 100 + k() * 10; }
// dep.ts
export function f(): number { return 1; }
export function swap(): void { f = () => 2; }
```

Measured on main dae2db2cca on 2026-11-28 with `compileMulti` (probe `.tmp/7530/probe-g-ab.mts` in the #7530
worktree). node runs the transpiled sources.

| shape | node | gc IR on | gc IR off | standalone IR on | standalone IR off |
| --- | --- | --- | --- | --- | --- |
| G0 (above) | 120 | 110 | 110 | 110 | 110 |
| G0v (`const h = k; … h()` for the second call) | 120 | 120 | 120 | 120 | 120 |

#7530's row G, the same graph with entry also declaring its own `function f`, gives 117 for node's 127 after
#7530, on all four lanes.

## Acceptance criteria

- G0 answers 120 on gc and standalone, with the IR path on and off, pinned by a `compileMulti` test that fails on
  main.
- #7530's row G (direct call) then answers 127 on all four lanes; add it to that pin file.
- Single-file output stays byte-identical. Clash-free multi-file graphs change only where an alias of a live
  function is called directly.
