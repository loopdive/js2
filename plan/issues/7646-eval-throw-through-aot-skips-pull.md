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
related: [7644, 7645, 7647]
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

## The pull alone does not fix it (measured with #7644, 2026-11-28)

#7644 wraps the provider call in tagged programs (two modules each binding an eval-mirrored name) with
`buildRestoreOnUnwind`: it catches the module's own exception tag, pulls, restores the provider-active tag and
rethrows. A trace of THROWCB below shows `__runtime_direct_eval` throwing with the caller's tag, so the wrap fires.
It restores the tag (dep's part answers 4), but **c's write is still lost**: QuickJS has not written `f = …` back
to the global object when the AOT `t()` throws, so the pull reads c's old `f`. The trampoline's own pull before
`t()` reads the same old value. The missing piece is the provider-side write-back on the throw path, not only a
caller-side pull. A fix needs that write-back (or the trampoline must flush the provider's binding writes before
it runs AOT code) as well as the caller-side pull, which then must also cover single-source programs (the wrap is
gated on #7644's tags, so single-source output is unchanged).

## Repro (THROWCB, two modules)

```ts
// entry.ts
import { run } from "./dep"; import { run2 } from "./c";
export function main() { const a = run2(); return run() * 10 + a; }
// dep.ts
function f() { return 3; }
export function run() { eval("f = function(){return 4}"); const h = eval("(function(){ return f() })"); return [0].map(h)[0]; }
// c.ts
function f() { return 1; } function t() { throw 1; }
export function run2() { try { eval("f = function(){return 2}; t()"); } catch (e) {} return f(); }
```

Measured on 2026-11-28 with #7644 (stacked on #7572, base 3711c8ff35), standalone, QuickJS, IR path on and off:
**41**. node gives **42**. Pinned as a stated limit in `tests/issue-7644-eval-per-module-scope.test.ts`; flip it
with this fix. A provider-side `throw` instead of the AOT `t()` (`eval("f = …; throw 1")`) answers 2 already:
the provider returns an error envelope and the normal pull runs.

## Acceptance criteria

- THROW1 answers 2 on standalone with the IR path on and off under QuickJS, pinned by a test that fails on main
  (skipped where QuickJS is not built), plus a structural pin that runs everywhere.
- After the throw, `__runtime_eval_provider_active` is back to its value before the eval.
- The ES5 test262 IR gate shows no pass → not-pass. Byte changes are limited to programs with a direct eval.
