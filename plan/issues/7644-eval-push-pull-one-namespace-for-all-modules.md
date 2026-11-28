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

## Implementation Plan (revision 3, 2026-11-28, S7)

Branch `claude/7644-eval-push-pull-per-module`, stacked on #7572 (`claude/7632-singleton-support`, e7b1a08c98),
because this change edits the fill step #7572 rewrote. #7572 builds the push and pull bodies once per program,
after the multi-source settle point, with no source view applied. Enqueue only after #7572 lands.

Revision 1 (a72f904e15) was blocked by PRV-7644 with 10 findings, and revision 2 (e9e63bbfd6) with N1–N3 and one
minor point. The tables at the end say how each is settled.

### Measured repros

`compileMulti`, standalone, QuickJS provider, IR path on and off (identical in every row), on the stacked branch
5693efdcf0 (main 5e3c790785 plus #7572; EV5 is the same on main). node runs the sources as `.mjs`. Probe
`.tmp/7644/ev-qjs.mts`, rows `.tmp/7644/rows2.json`.

Every row except THROW1 uses the entry `import {run} from "./dep"; import {run2} from "./c"; export function
main(){return run()*10+run2()}` and dep `function f(){return 3} export function run(){ eval("f = function(){return
4}"); return f(); }`. The rows differ in c:

| row | c | node | today | after |
| --- | --- | --- | --- | --- |
| EV5 | `function f(){return 1} … run2(){ eval("f = function(){return 2}"); return f(); }` | 42 | 41 | 42 |
| READ2 | as EV5, eval `f = (function(o){ return function(){ return o()+1 } })(f)` | 42 | 41 | 42 |
| NEST | as EV5, plus `function g(){ eval("0"); return 0 }`, eval `g(); f = function(){return 2}` | 42 | 41 | 42 |
| NESTIND | as NEST, with `g` running `(0,eval)("0")` | 42 | 41 | 42 |
| NESTFN | as NEST, with `g` running `new Function("return 0")()` | 42 | 41 | 42 |
| THROWCB | c: `try { eval("f = function(){return 2}; t()") } catch {} return f()` with `t` throwing; dep's `run` then calls an eval-made `h` through `[0].map(h)`; entry runs c first | 42 | 41 | 42 |
| INDIRECT | `run2(){ return (0,eval)("typeof f") === "undefined" ? 1 : 9; }` | 41 | 49 | 41 |
| NEWFN | `run2(){ return new Function("return typeof f")() === "undefined" ? 1 : 9; }` | 41 | 49 | 41 |
| LATER | `run2(){ const h = eval("(function(){ return f() })"); return [0].map(h)[0]; }` | 41 | 44 | still wrong: a stated limit, pinned at the value measured when it is implemented |
| THROW1 (one module, #7646) | `try { eval("f = function(){return 2}; t()") } catch {} return f()` | 2 | 1 | 1, unchanged |

LATER stays wrong by design: outside any eval no arm is active, and the default arm is empty for a colliding name (see Stated limits). It no longer reads dep's `f`.

Out of scope:

- #7645: with one module, an eval write to a module `var` or `let` is lost, and `eval("f()")` throws. A
  same-name `let` in two modules (LEX2: node 42, today 31) is wrong for the same reason, so it goes there too.
  #7644 leaves the lexical-cell names exactly as they are (the minor review point).
- #7646 (THROW1): a throw through AOT code inside an eval skips the pull, also with one module.

### Cause

- The push and pull helpers (`__runtime_eval_push_globals` / `__runtime_eval_pull_globals`) mirror bindings onto the
  one shared global object, keyed by bare name, and their bodies are built once under one view.
- With two modules binding `f`, they carry one module's `__mod_f`, so c's eval publishes dep's `f` and pulls its
  write back into dep's global.
- The pair is called from direct eval sites, the global-scope entries (indirect eval, script eval, `new Function`),
  the callable trampolines (`runtime-eval-callable.ts`), and the interpreted-callback path in `object-runtime.ts`
  (~L6946-7022). The last two do not know the calling source.

### Design

The provider-active flag `__runtime_eval_provider_active` (`runtime-eval-boundary.ts`) becomes a tag. Today it is
0 or 1, and every reader only tests for non-zero (`runtime-eval-callable.ts` ~L154, ~L174, ~L433; the save/restore
in `object-runtime.ts`).

- **Tags.** 0 = inactive, 1 = shared view, 2 + i = tagged source i.
- **Which sources are tagged.** A source that contains a direct eval site (from `ctx.runtimeEvalBoundaryPlan.sites`,
  kind `"direct-eval"`, matched to the source through the plan's own id, `stableSourceId` in
  `src/ir/runtime-eval-boundary-plan.ts`, exported for this) **and** binds a mirrored name that another module also
  binds (`isCollidingModuleName`, `module-binding-table.ts`).
- **Which names have arms.** Only colliding mirrored names. Per name, the push and the pull branch on the tag:
  - one arm per tagged source that binds the name, built under `withSourceBindings(ctx, source, …)`;
  - **the default arm emits nothing** (finding 5, lead's call). Indirect eval and `new Function` run at global scope
    and see no module bindings, as the spec says. A non-colliding name keeps exactly today's single code path.
- **Program-level switch.** If no source is tagged (every single-source program), none of the changes below emit
  anything new, and the output is today's.

### Steps

All tag code lives in `src/codegen/runtime-eval-boundary.ts`, next to `ensureRuntimeEvalProviderActiveGlobal` and
the flag it owns (finding 7). It is 514 lines; this adds about 80, under the 1,500-line threshold.
`module-bindings/` only supplies `isCollidingModuleName` and `withSourceBindings`.

1. **Constants once.** `runtime-eval-boundary.ts` exports `RUNTIME_EVAL_PUSH_GLOBALS` / `RUNTIME_EVAL_PULL_GLOBALS`.
   Delete the copies at `runtime-eval-provider.ts:58-59` and `runtime-eval-callable.ts:61-62`, and the literals in
   `object-runtime.ts` (~L6946).
2. **Tag helpers** in `runtime-eval-boundary.ts`:
   - `runtimeEvalSourceTag(ctx, source)`: 1, or 2 + i;
   - `runtimeEvalTagsInUse(ctx)`: is any source tagged;
   - `emitPerSourceArms(ctx, fctx, name, emitOne)`: the `if` chain on the tag, each arm under `withSourceBindings`,
     no default arm.
3. **Push body** (`emitRuntimeEvalGlobalBindingPushBody`). Extract the per-name load (~L349-416) into
   `emitMirroredBindingValue(ctx, fctx, name)`, with the wrap write-back. A colliding name goes through
   `emitPerSourceArms`; any other name calls it directly, as today.
4. **Pull body** (`emitRuntimeEvalGlobalBindingPullBody`). For a colliding name, each arm reads the global object's
   value, coerces it to **that arm's own target global's type** (`emitRuntimeEvalPullCoerceCall` per arm, finding
   9), and does the `global.set` there. The lexical-cell loop is not changed (see #7645).
5. **Direct eval sites**, only when `runtimeEvalTagsInUse(ctx)`:
   - **Tag before push** (finding 1). The site saves the current tag in a local, sets its own source's tag, then
     calls the push. Untagged sites in such a program set tag 1 the same way. With no tags in use, the order stays
     push then `i32.const 1`, byte-identical.
   - **Restore instead of reset** (finding 2). `emitRuntimeEvalResultUnwrap` restores the saved tag instead of
     writing 0, so a nested eval does not drop the outer site to the default arm. The unwrap's restore is shared
     by both kinds of caller: direct sites and the global-scope support functions below.
   - **Global-scope entries too** (N1). The support function `ensureRuntimeEvalGlobalCall`
     (`runtime-eval-provider.ts` ~L679-701, used by indirect eval, script eval and `new Function`) saves the current
     tag in a local, sets 1, and restores the saved tag through the same unwrap. NESTIND and NESTFN are pinned.
   - **Throw path** (finding 3, N3). The provider call at direct sites and in the global support functions is
     wrapped by a generalised **`buildRestoreOnUnwind(blockType, body, tagIdx, unwindExnLocal, restore)`** in
     `src/wasm/physical/exception-control.ts`, beside `buildStandardTryTable`. It catches the module's own exception
     tag (`ensureExnTag`; the provider preserves the caller's tag, `runtime-eval-callable.ts` ~L128), runs `restore`
     (here: the pull call, then restoring the saved tag) and rethrows. It is the house pattern, not a `catch_all`:
     `buildTargetTaggedTry` drops `catchAll`, and a rethrowing `catch_all` would need exnref, which
     `StandardEhHandler` does not model. `restoreThisOnUnwind` (`named-this-call.ts` ~L365) becomes a call to the same
     helper, so the pattern exists once. That fixes THROWCB, and THROW1's shape inside tagged programs; #7646 tracks
     THROW1 for single-source programs, whose bytes this change must not touch.
   - `emitRuntimeEvalProviderActive(ctx, fctx, tag)` takes a tag (a number) instead of a boolean. The global-scope
     entries keep tag 1.
6. **Interpreted-callback path** (`object-runtime.ts` ~L7011). When tags are in use, it keeps a non-zero active tag
   (`select(active, active, 1)`) instead of forcing 1, so a callback inside c's eval keeps c's arms.
7. **One declaration lookup** (finding 8, lead's call). Fold
   `sourceFunctionDeclarationForHandle(ctx, funcIdx) ?? ctx.funcMapOwnerDecl.get(name) ??
   ctx.topLevelFunctionDeclarations.get(name)`, now copied at `method-trampolines.ts` ~L1097, ~L1395 and ~L1438,
   into one helper, `topLevelFunctionDeclarationFor(ctx, name, funcIdx)`, beside `sourceFunctionDeclarationForHandle`
   (`program-abi-source-callable-planning.ts`). Use it at those three sites and in the push (~L359, which reads
   `topLevelFunctionDeclarations` alone today). The chain's order is unchanged, so its existing users keep their
   bytes.
8. **Trampolines unchanged.** They test for non-zero only.

### Stated limits (pinned)

- **LATER.** An interpreted function made by c's eval and called later by c's own AOT code, outside any eval, runs
  under tag 1. For a colliding name the default arm is empty, so it cannot see c's `f`. Fixing that needs per-module
  eval scope, not a mirror onto one global object.
- **Single-source programs** keep today's behaviour everywhere, including THROW1 (#7646) and the deviation that
  indirect eval and `new Function` see a module's own functions on the global object.

### Byte identity

- **When no source is tagged**, steps 2–6 emit nothing (the tag save/restore, the global-entry save/restore and
  the unwind wrap are all gated on `runtimeEvalTagsInUse`), and steps 1 and 7, and the `restoreThisOnUnwind` fold,
  move code without changing what is emitted. That covers every single-source program and every multi-source program without a colliding eval-mirrored
  name.
- **Step 7** keeps the existing chain's order. In the push it adds the first two lookups before
  `topLevelFunctionDeclarations`. In a single source those return the same declaration or none: the gate checks it,
  with a byte sample whose push reaches a top-level generator and an async function (finding 8).
- **Gate:**
  - the 389-file sample, the eval/Annex B sample (113) and the reassign sample (553), × gc/standalone × IR on/off;
  - the `mhash` clash-free graphs;
  - #7530's EV2 graph (no clash). EV1, EV3 and EV4 are **not** in the byte gate (N2): dep contains a direct eval and
    binds `f`, which another module also binds, so dep is tagged and their bytes change. They are gated on
    behaviour (their QuickJS rows in the #7530 test file);
  - the new generator/async sample.

  All must be identical to the base.

### Tests

New file `tests/issue-7644-eval-per-module-scope.test.ts`, standalone, IR path on and off:

- **Structural, every run:** in EV5, the push and the pull carry both modules' `__mod_f` behind tag arms, and
  untagged single-source output has no tag compare.
- **Under QuickJS (skipped where it is not built), against node:** EV5, READ2, NEST, NESTIND, NESTFN, THROWCB, INDIRECT
  and NEWFN at node's answers; LATER pinned at its limit value; a control where only dep declares `f`.

### Acceptance

- The rows above give their "after" values.
- The #7530 (EV1–EV4 included), #7632 and #7470 test files still pass.
- The byte gate is identical, the equivalence gate passes, and lodash-es size and compile time are reported.
- **Code quality:**
  - the push/pull names are defined once;
  - the declaration chain is one helper with four callers;
  - restore-on-unwind is one helper (`buildRestoreOnUnwind`) shared with `restoreThisOnUnwind`;
  - the tag lives with its owner, `runtime-eval-boundary.ts`;
  - the arms reuse `withSourceBindings` without a copy, and non-colliding names keep one path;
  - no grant in `index.ts` or `declarations.ts`.

### PRV-7644 findings (revision 1, a72f904e15)

| # | finding | settled by |
| --- | --- | --- |
| 1 | the push runs before the tag is set | fixed: step 5, tag before push; READ2 pinned |
| 2 | a nested eval resets the tag to 0 | fixed: step 5, save and restore; NEST pinned |
| 3 | the throw path skips the pull and the reset | fixed: step 5, `try`/`catch_all` that pulls, restores and rethrows; THROWCB pinned; THROW1 filed as #7646 |
| 4 | a same-module late callback sees dep's `f` | stated limit, pinned (LATER); with fix 5 it no longer sees another module's `f` |
| 5 | the default arm pushes an arbitrary module's `f` | fixed (lead's call): the default arm emits nothing for colliding names; INDIRECT and NEWFN pinned |
| 6 | `identifierIndex(…).has("eval")` over-matches | fixed: direct sites from `runtimeEvalBoundaryPlan.sites` |
| 7 | the new module is misplaced | fixed (lead's call): the tag lives in `runtime-eval-boundary.ts` |
| 8 | the declaration lookup diverges from its three copies | fixed (lead's call): one helper, four callers; generator/async byte sample |
| 9 | the pull must coerce per arm | fixed: step 4 |
| 10 | acceptance misses rows | fixed: every row above, with node's answers |

### PRV-7644 delta review (revision 2, e9e63bbfd6)

| # | finding | settled by |
| --- | --- | --- |
| N1 | a nested global-scope entry still drops the outer tag | fixed: step 5, global support functions save and restore through the shared unwrap; NESTIND and NESTFN pinned (today 41, node 42) |
| N2 | EV1/EV3/EV4 are tagged, so not byte-identical | fixed: out of the byte gate, gated on behaviour; EV2 stays |
| N3 | the throw wrap does not fit the EH form | fixed: `buildRestoreOnUnwind` in `exception-control.ts`, catching the module's own tag, shared with `restoreThisOnUnwind`; gated on tags in use |
| minor | lexical cells reachable but untested | lexical names untouched; LEX1 (one module, 30 vs 40) and LEX2 (two modules, 31 vs 42) go to #7645 |
