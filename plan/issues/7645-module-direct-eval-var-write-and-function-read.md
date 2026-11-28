---
id: 7645
title: "Direct eval in a module loses a write to a module var, and throws reading a module function"
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
goal: runtime-eval
related: [7644]
---

# #7645 — direct eval in a module loses a `var` write, and throws reading a module function

## Problem

Found while planning [#7644](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7644-eval-push-pull-one-namespace-for-all-modules). Both defects show up with a
single module, so they are separate from #7644, which is about two modules binding the same name.

A direct `eval` inside an ES module sees module-level bindings only through the global-object mirror (the
`__runtime_eval_push_globals` / `__runtime_eval_pull_globals` helpers in
`src/codegen/expressions/runtime-eval-provider.ts`). For a module:

1. **A write to a module `var` is lost.** Module `var`s are not script-global bindings (`globalObjectVarBindings`),
   so the mirror carries none of them. That cause is probable, not yet confirmed in the code.
2. **`eval("f()")`, calling a module's own top-level function, throws.** The cause is not yet known. A write to the
   same function (`eval("f = …")`, #7530's EV2) works.

## Repro

Measured on main 5e3c790785 on 2026-11-28: `compile`/`compileMulti`, standalone, the QuickJS runtime-eval provider,
IR path on and off (probe `.tmp/7644/ev-qjs.mts` in the #7644 worktree). node runs the transpiled sources.

| row | sources | node | standalone, IR on and off |
| --- | --- | --- | --- |
| C-var1 | `var v = 3; export function main(){ eval("v = 4"); return v * 10; }` | 40 | 30 |
| C-var | entry: `import {run} from "./dep"; export function main(){return run()*10}`; dep: `var v = 3; export function run(){ eval("v = 4"); return v; }` | 40 | 30 |
| C-read1 | `function f(){return 3} export function main(){ return eval("f()") * 10; }` | 30 | throws (a `WebAssembly.Exception`) |
| C-read | entry as C-var; dep: `function f(){return 3} export function run(){ return eval("f()"); }` | 30 | throws |

## Acceptance criteria

- The four rows answer like node on standalone with the IR path on and off under QuickJS, pinned by a test that fails
  on main (skipped where QuickJS is not built), plus a structural pin that runs everywhere.
- Script sources (no module syntax) and single-file test262 output stay byte-identical; the ES5 test262 IR gate
  shows no pass → not-pass.
