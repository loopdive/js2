---
id: 7647
title: "The runtime-eval global mirror never retracts or isolates a module binding"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
goal: runtime-eval
related: [7644, 7646]
---

# #7647 — the runtime-eval global mirror never retracts or isolates a module binding

## Problem

Found while implementing [#7644](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7644-eval-push-pull-one-namespace-for-all-modules).
Before each provider entry, the push (`__runtime_eval_push_globals`, `emitRuntimeEvalGlobalBindingPushBody` in
`src/codegen/expressions/runtime-eval-provider.ts`) defines every eval-mirrored binding as a property of the one
shared global object. It defines top-level function and `var` bindings as non-configurable properties. Nothing
ever removes them, so once a module's direct eval has published its `f`, that property stays on the global object
for every later entry.

#7644 tags each source that has a direct eval and binds a name another source also binds. For such a name, the push
publishes only the entering source's binding, and a global-scope entry (tag 1: indirect eval, `new Function`)
publishes none. But the property an earlier entry left stays, so a global-scope entry, and an eval-made function
called later from AOT code outside any eval, still read a module's `f` that the spec does not let them see. The
property is non-configurable, so it cannot be deleted. Defining it as `undefined` under tag 1 would fix `typeof f`,
but `"f" in globalThis` would stay true. It was deliberately left out of #7644.

The fix needs real per-module eval scope: each module's bindings reach the provider as that module's environment
(as direct-eval locals already do through binding cells), not as properties of the shared global object.

## Repros

Measured on 2026-11-28 with #7644 (stacked on #7572, base 3711c8ff35), `compileMulti`, standalone, QuickJS
provider, IR path on and off (identical). Every row uses the entry
`import {run} from "./dep"; import {run2} from "./c"; export function main(){return run()*10+run2()}` and the dep
`function f(){return 3} export function run(){ eval("f = function(){return 4}"); return f(); }`. They differ in c:

| row | c | node | measured |
| --- | --- | --- | --- |
| INDIRECT | `function f(){return 1} export function run2(){ return (0,eval)("typeof f") === "undefined" ? 1 : 9; }` | 41 | 49 |
| NEWFN | `function f(){return 1} export function run2(){ return new Function("return typeof f")() === "undefined" ? 1 : 9; }` | 41 | 49 |
| LATER | `function f(){return 1} export function run2(){ const h = eval("(function(){ return f() })"); return [0].map(h)[0]; }` | 41 | 41, by accident |

- INDIRECT and NEWFN: dep's eval left dep's `f` on the global object, so `typeof f` is "function".
- LATER matches node only by accident. `h` runs under tag 1 outside any eval, where the push publishes nothing
  for `f`. It reads c's `f` only because c's own eval left that stale property behind.

All three are pinned as stated limits in `tests/issue-7644-eval-per-module-scope.test.ts`, with their measured
values. Flip them with this fix.

## Acceptance criteria

- INDIRECT and NEWFN answer 41, and LATER answers 41 because `h` resolves c's own `f`. Each is checked on
  standalone, with the IR path on and off, under QuickJS.
- Single-source output stays byte-identical. The ES5 test262 IR gate shows no pass → not-pass.
