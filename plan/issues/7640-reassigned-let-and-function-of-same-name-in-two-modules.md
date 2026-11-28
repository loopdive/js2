---
id: 7640
title: "A reassigned let f in one module and a function f in another share one binding"
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
related: [7470, 7530]
---

# #7640 — a reassigned `let f` in one module and a `function f` in another share one binding

## Problem

Found in the review of [#7530](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7530-same-named-reassigned-functions-share-global) (RV-PR7569, row VAR2). One
module declares `let f` and reassigns it; another declares its own `function f`. The entry's call to its own
`f` reads the other module's `let f`. This is the
[#7470](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7470-same-named-module-bindings-share-global) family (same-named module bindings sharing storage),
for a variable against a function. #7470 covers variable against variable and #7530 function against function.

## Repro

```ts
// entry.ts
import { swap, get } from "./dep";
function f(): number { return 1; }
export function main(): number { swap(); return f() * 100 + get() * 10 + 1; }
// dep.ts
let f = (): number => 3;
export function swap(): void { f = () => 4; }
export function get(): number { return f(); }
```

| | node | gc IR on | gc IR off | standalone IR on | standalone IR off |
| --- | --- | --- | --- | --- | --- |
| VAR2 | 141 | 441 | 441 | 441 | 441 |

The reviewer measured all four lanes on main dae2db2cca and on #7530's head 35db004b05: 441 everywhere. The
standalone lanes were re-run here on 2026-11-28 with `compileMulti` after #7530's eval fix: 441. node runs the
`ts.transpileModule` output.

## Acceptance criteria

- VAR2 answers 141 on gc and standalone with the IR path on and off, pinned by a `compileMulti` test that fails on
  main.
- Single-file output stays byte-identical.
