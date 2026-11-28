---
id: 7646
title: "An exception thrown through AOT code inside a direct eval skips the eval's pull, so its writes are lost"
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
related: [7644, 7645]
---

# #7646 — a throw through AOT code inside an eval skips the pull

## Problem

Found in the review of the [#7644](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7644-eval-push-pull-one-namespace-for-all-modules) plan (PRV-7644, finding 3).
A direct eval publishes the caller's bindings to the global object (push), runs the source in the provider, then
copies them back (pull, in `emitRuntimeEvalResultUnwrap`, `src/codegen/expressions/runtime-eval-provider.ts`).

When the eval'd source calls an AOT function that throws, the Wasm exception unwinds through the provider call
itself. No result envelope comes back, so the pull and the provider-active reset never run. Every write the eval
made before the throw is lost, and the provider-active flag stays set.

## Repro (THROW1, one module)

```ts
function f() { return 1; }
function t() { throw 1; }
export function main() { try { eval("f = function(){return 2}; t()"); } catch (e) {} return f(); }
```

Measured on 2026-11-28 (main 5e3c790785 plus #7572), standalone, QuickJS provider, IR path on and off: **1**. node
gives **2**.

#7644 fixes this shape only in programs where it tags sources (two modules each binding an eval-mirrored name), by
wrapping the provider call in `try` / `catch_all` that pulls, restores the flag and rethrows. This issue is the same
fix for every program. It changes single-source output, which #7644 must not.

## Acceptance criteria

- THROW1 answers 2 on standalone with the IR path on and off under QuickJS, pinned by a test that fails on main
  (skipped where QuickJS is not built), plus a structural pin that runs everywhere.
- After the throw, `__runtime_eval_provider_active` is back to its value before the eval.
- The ES5 test262 IR gate shows no pass → not-pass. Byte changes are limited to programs with a direct eval.
