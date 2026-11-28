---
id: 7644
title: "Runtime-eval push and pull use one program-wide namespace, so a second module's eval write is lost"
status: in-progress
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

## Implementation Plan (2026-11-28, S7)

Branch `claude/7644-eval-push-pull-per-module`, stacked on #7572 (`claude/7632-singleton-support`, e7b1a08c98),
because this change edits the fill step that #7572 rewrites. It is enqueued only after #7572 lands.

### Measured repro

`compileMulti`, standalone, QuickJS provider, IR path on and off. Probe `.tmp/7644/ev-qjs.mts`.

| row | node | main 5e3c790785 | stacked on #7572 (53aeeb60b7) |
| --- | --- | --- | --- |
| EV5 (dep and c each eval-rebind their own `f`) | 42 | 41 | 41 |
| EV5b (EV5 calling `run2()` first) | 24 | 14 | 14 |

Single-module controls on main show two defects that are **not** this issue, so they are out of scope (both are
wrong with one module too, so a follow-up issue is needed):

- an eval write to a module `var v` is lost: 30 against node's 40;
- `eval("f()")` reading a module function throws.

Only top-level function bindings are mirrored for modules today, and that is what this issue fixes.

### Cause

- The push and pull helpers (`__runtime_eval_push_globals` / `__runtime_eval_pull_globals`) mirror bindings onto
  the one shared global object, keyed by bare name.
- Their bodies are built once (`fillRuntimeEvalGlobalBindingSync`) and read `ctx.moduleGlobals.get(name)` under
  one view, so in a graph where two modules bind `f`, they carry one module's `__mod_f`.
- c's eval therefore publishes dep's `f` and pulls its write back into dep's global.
- The pair is called module-wide: by direct eval sites, by the global-scope entries (indirect eval, script eval,
  `new Function`), by the callable trampolines (`runtime-eval-callable.ts`), and by the interpreted-callback path in
  `object-runtime.ts` (~L6946-7022). Neither the trampolines nor the callback path know the calling source, so a
  per-source pair alone is not enough.

### Design: tag the active source in the existing provider-active flag

`__runtime_eval_provider_active` (`runtime-eval-boundary.ts`) is 0 or 1 today. Every reader only tests it for
non-zero: `runtime-eval-callable.ts` ~L154, ~L174, ~L433, and the save/restore in `object-runtime.ts`. It becomes
a tag:

- 0: inactive.
- 1: the shared view. Every global-scope entry and every source that needs no arms uses it.
- 2 + i: source i. Only a source that contains a direct eval and binds a mirrored name that another module also
  binds gets one.

For each such colliding name, the push and the pull branch on the tag. Each arm is built under
`withSourceBindings(ctx, source, …)`, which is #7558's per-source projection, unchanged. Names that only one
module binds keep exactly today's code.

### Steps

1. **Constants, once** (`src/codegen/runtime-eval-boundary.ts`): export `RUNTIME_EVAL_PUSH_GLOBALS` and
   `RUNTIME_EVAL_PULL_GLOBALS`. Delete the copies at `runtime-eval-provider.ts:58-59` and
   `runtime-eval-callable.ts:61-62`, and the string literals in `object-runtime.ts` (~L6946).
2. **New module `src/codegen/module-bindings/runtime-eval-source-tags.ts`** (small, one concern):
   - `runtimeEvalSourceTag(ctx, source)`: 1, or 2 + index for a tagged source.
   - `emitPerSourceArms(ctx, fctx, name, emitOne)`: the `if` chain on the tag, each arm under
     `withSourceBindings`, and the default arm under the shared view.
   - Colliding names come from the module binding table (`moduleBindingsNamed` and `isCollidingModuleName`, `module-binding-table.ts`). Whether a source contains a direct eval comes from `identifierIndex(source).has("eval")`
     (`src/shared/callee-name-index.ts`).
3. **`runtime-eval-provider.ts`:**
   - `emitRuntimeEvalGlobalBindingPushBody`: extract the per-name value load (~L349-416) into
     `emitMirroredBindingValue(ctx, fctx, name)`, including the wrap write-back. Colliding names go through
     `emitPerSourceArms`.
   - In the same loop, replace `ctx.topLevelFunctionDeclarations.get(name)` (the graph-wide name map #7530 removed
     from eval liveness) with the declaration that owns the function handle in the current view (`sourceFunctionDeclarationForHandle`,
     `program-abi-source-callable-planning.ts:156`).
   - `emitRuntimeEvalGlobalBindingPullBody`: read the value once; the arms choose the target `global.set`.
   - `emitRuntimeEvalProviderActive(ctx, fctx, tag)` replaces the boolean. `emitRuntimeEvalGlobalBindingSeed` takes
     the calling source: the direct eval site passes `call.getSourceFile()`, and the global entries pass none
     (tag 1).
4. **`object-runtime.ts`:** the interpreted-callback path sets the flag to 1 before it calls the push. When any
   source is tagged, it keeps a non-zero tag instead (`select(active, active, 1)`), so a callback inside c's eval
   does not switch to the shared view. With no tagged source it emits today's `i32.const 1`.
5. The trampolines need no change: they only test for non-zero.

### Scope limits, stated in the code and the tests

- **Global-scope entries use the shared view.** By the spec, indirect eval and `new Function` see no module
  bindings at all. They keep today's behaviour.
- **An interpreted function created by dep's eval and called later from c** resolves its free names through the
  global mirror, under the tag active at that time. That is a limit of mirroring module scopes onto one global
  object, so it gets a pin and its own follow-up issue.
- **A nested eval** resets the flag to 0, as today.

### Byte identity

- With one source, no name collides: there are no arms, the tag is always `i32.const 1`, and the
  `object-runtime` branch never fires.
- Moving the constants changes no bytes.
- The one step to prove is the declaration lookup in step 3. It must return the same declaration as
  `topLevelFunctionDeclarations` for every single-source top-level function, or `isOrdinary` flips. The proof is
  the byte gate below.

### Tests

New file `tests/issue-7644-eval-per-module-scope.test.ts`, standalone, IR path on and off:

- **Structural, every run:** in EV5, the push and the pull carry both modules' `__mod_f`. Today they carry one.
- **Under QuickJS (skipped where it is not built), against node:**
  - EV5 and EV5b;
  - a control where only dep declares `f`;
  - `(0, eval)("typeof f")` from c, pinned at the shared view;
  - an interpreted `[1].map(function () { return f(); })` inside c's eval, which checks step 4.

### Acceptance

- EV5 gives 42 and EV5b 24 on standalone, IR path on and off, under QuickJS.
- #7530's EV1-EV4 rows still pass, and so do the #7632 and #7530 test files.
- **Byte gate:** the 389-file sample, the eval/Annex B sample and the reassign sample, × gc/standalone × IR
  on/off, all identical. The clash-free `mhash` graphs are identical too.
- The equivalence gate passes, and the lodash-es size and compile time are reported.
- **Code quality:**
  - The push/pull names are defined once.
  - The push body no longer reads `ctx.topLevelFunctionDeclarations`.
  - The per-source dispatch lives in one new module of at most ~120 lines, and its arms reuse
    `withSourceBindings` without a copy.
  - No new grant in `index.ts` or `declarations.ts`.
  - Every non-colliding name keeps a single code path.
