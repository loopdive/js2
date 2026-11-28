---
id: 7644
title: "Runtime-eval push and pull use one program-wide namespace, so a second module's eval write is lost"
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
related: [7530, 7639]
---

# #7644 — runtime-eval push and pull use one program-wide namespace

## Problem

Found in the review of [#7530](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7530-same-named-reassigned-functions-share-global) (RV-PR7569, row EV5). Two
modules of one `compileMulti` program each declare a top-level `function f`, and each rebinds its own `f` with a
direct `eval`. After #7530, each module has its own live global for `f`. But the functions that copy live
bindings to the eval provider and back ("push" and "pull") build one namespace for the whole program, keyed by bare
name. It reads `ctx.moduleGlobals.get(name)` and `ctx.liveFuncBindingGlobals`
(`src/codegen/expressions/runtime-eval-provider.ts` ~L353), so they carry only one module's `f`: dep's. The second
module's eval write never reaches its own global.

**This regresses against main for this shape.** Main answers right only by accident: before #7530 both modules shared
one `__mod_f`, so whichever eval ran last set the value both modules read. This is not a test262 shape: test262 runs
one source at a time, so no ES5 row is affected.

The fix needs a per-module eval scope (each module's direct eval sees that module's own bindings), which #7530 does
not build.

## Repro (EV5)

```ts
// entry.ts
import { run } from "./dep";
import { run2 } from "./c";
export function main() { return run() * 10 + run2(); }
// dep.ts
function f() { return 3; }
export function run() { eval("f = function(){return 4}"); return f(); }
// c.ts
function f() { return 1; }
export function run2() { eval("f = function(){return 2}"); return f(); }
```

Measured on 2026-11-28 with `compileMulti`, standalone, the QuickJS runtime-eval provider, IR on and off (probe
`.tmp/7530/ev-qjs.mts` in the #7530 worktree):

| | node | main ef07617385 | #7530 head 211278b392 |
| --- | --- | --- | --- |
| EV5 | 42 | 42 (by accident: one shared global) | 41 (c's eval write lost) |

## Known-wrong pin

Pin EV5 as a known-wrong row when this issue is taken: by structure, c's `__mod_f` global is absent from the
push and pull functions (`__runtime_eval_push_globals` / `__runtime_eval_pull_globals`), and with QuickJS
`main()` returns 41. Flip it to 42 with the fix.

## Acceptance criteria

- EV5 answers 42 on standalone with the IR path on and off, under QuickJS, pinned with a test that fails on #7530's
  head.
- #7530's EV1–EV4 rows still pass.
- Single-file output stays byte-identical; the ES5 test262 IR gate shows no pass → not-pass.
