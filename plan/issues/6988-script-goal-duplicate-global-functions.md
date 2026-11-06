---
id: 6988
title: "Script goal with a synthetic `export` entry: duplicate top-level function declarations rejected as 'Duplicate identifier' (Octane mandreel, 11 compile errors)"
status: done
assignee: ttraenkler/octane-mandreel
sprint: current
created: 2026-10-14
updated: 2026-10-14
completed: 2026-10-14
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: function-declarations, script-goal
goal: standalone-gap
related: [874, 3419, 6491, 6937]
# 2026-10-14: +1 line — the `scriptTopLevel` signal is read from CompileOptions
# where the early-error pass is invoked; no subsystem module owns that call.
loc-budget-allow:
  - src/compiler.ts
---

# Duplicate global function declarations in a Script with a synthetic `export` entry

## Problem

The Octane mandreel driver (Octane `base.js` + Emscripten/Mandreel-generated
`mandreel.js` + the harness epilogue, 5 MB, sloppy Script) failed to compile in
every lane with 11 errors:

    Duplicate identifier 'assert'
    Duplicate identifier 'MandreelInterCallFunction'
    Duplicate identifier 'MandreelInterWriteString'  … (11 names)

`mandreel.js` defines each of these functions twice (a stub block near line
2430 and the real implementation further down). That is legal in a Script:
§16.1.1 checks duplicates only against `TopLevelLexicallyDeclaredNames`, which
excludes HoistableDeclarations, and §16.1.7 GlobalDeclarationInstantiation binds
the LAST declaration of each name.

The `Parameter 'reps' … implicit 'any'` line in the same output is a warning,
not an error — it was never part of the failure.

## Root cause

`checkDuplicateLexicalDeclarations` (`src/compiler/early-errors/duplicates.ts`)
decides whether top-level function declarations are lexical with
`moduleGoal || ts.isExternalModule(block)`. The harness epilogue appends
`export function octane_run(reps)` / `octane_teardown`, so TypeScript reports
the file as an external module and the rule applied Module-goal semantics
(§16.2.1.1, where duplicates ARE SyntaxErrors). The caller already declares the
file a Script via `inferModuleStrictArguments: false` (#6937: "Script-goal
switch for a single-file source whose top-level `export` is a synthetic entry
point"), but the early-error pass never received that signal — only
`moduleGoal` (`=== true`) and `scriptGoal` were threaded through.

## Fix

`validatePipelineSource` (`src/compiler.ts`) passes `scriptTopLevel: options.inferModuleStrictArguments ===
false` into `detectEarlyErrors`; the rule treats the top level as var-scoped when
it is set, even if `ts.isExternalModule` is true. Product compiles (option
absent) and test262 module tests (`=== true`) are unaffected, so a real module
still rejects duplicate top-level functions.

Codegen already implemented last-wins for duplicate function declarations; the
regression test (`tests/issue-6988-script-duplicate-global-functions.test.ts`)
checks it at run time in the standalone and JS-host lanes, including a call made
before the second declaration.

## Residue (not fixed here, pre-existing in plain Scripts)

Unblocking this rule also lets `var` + `function` pairs of one name compile in a
Script with an exported entry (mandreel itself has none). Two pre-existing
codegen gaps show up there, both also reproducible in a plain Script with
`scriptGoal: true` and no `export`:

- `function h(){}` … `var h = function(){}` fails in every lane with
  `Codegen error: ABI draft …:function-value-trampoline… would mutate sealed
  prepared scope` (same family as #4514).
- JS-host (gc) lane: `var before = typeof g === "function" ? g() : -1; var g = 5;
  function g(){}` sees `typeof g !== "function"` before the initialiser runs
  (standalone is correct).

## Compile-time fixes found on the way (quadratic whole-file walks)

With the duplicate errors gone, the 5 MB driver did not finish compiling within
25 minutes. CPU profiles (inspector sampling, `.tmp/prof.mjs`) found three
per-site walks of the whole source file; each is now indexed once per file /
body, with unchanged results:

| Site | Was | Now |
| --- | --- | --- |
| `functionNameIsStringReplacement` (param inference) | whole-file walk per uncalled implicit-any function — 99 % of the first 2 min | per-file name set, `src/codegen/declarations/string-replacement-callbacks.ts` |
| `runtimeAccessorDescriptorKey` (`src/codegen/property-access.ts`) | two whole-file walks per identifier-receiver property read (standalone) | per-file list of `Object.<method>(…)` calls |
| `planClosureCaptures` outer-write check | whole enclosing-body walk per (closure, captured name) | per-body write-target index, `src/codegen/closures/outer-write-index.ts` |
| `analyzeReceiverFlow` `calleeDeclaration` | whole-file scan per identifier call site | one first-declaration-by-name index per analysis |

## Mandreel standalone: remaining blocker (architectural, not fixed)

Measured on this branch (4-core box under load from another agent):

- The full driver compiles past the early-error pass and all four hot spots,
  then stalls in user function `global_init(stackPos)` (mandreel.js lines
  124176–277123: ~150,000 top-level `emit_8/16/32(…)` data-initialiser calls).
  After 18 min the function had 88,081 locals and was still on its first ~10k
  calls; the run was stopped (RSS 6.9 GB).
- Cause: mandreel contains a direct `eval(next)` (`Mandreel_flushTimeouts`), so
  the program is a runtime-eval consumer and `ctx.runtimeEvalGlobalFunctionBindings`
  is set. Every call to a global function then lowers to the inline live-binding
  dispatch: global-object `__extern_has/__extern_get`, the provider's
  dynamic-lexicals sidecar lookup, an `IsCallable` check, the closure dispatch
  and the bare-call receiver reset — ~375 WAT lines and ~8 fresh,
  never-reused locals (`__bare_prev_this_N`, `__bare_result_N`, `__dyn_any_N`,
  `__dyn_argI_N`, `__runtime_eval_dynamic_*_N`) per call site. Measured on a
  4-call synthetic: 35 locals, 1,517 WAT lines; the same source without `eval`
  lowers to 4 direct `call $emit_8`.
- Consequences: (1) the function would need ~1.2 M locals; V8 rejects more
  than 50,000 locals per function, so the module could not validate even if the
  compile finished; (2) compile time is quadratic, because
  `snapshotSpeculative` → `snapshotLocals` copies the whole `localMap` (66k
  entries and growing) on every speculative call compile; (3) code size grows
  ~100x per call.
- What it needs: outline the runtime-eval live-binding call into one helper per
  (callee name, arity) — or a fast path that tests whether the binding still
  holds the AOT function and calls it directly, with the dynamic path
  outlined — so a call site costs a `call` and no locals. That changes the call
  lowering for every eval-consuming standalone program (test262 standalone
  lane) and needs its own issue and plan.

Diagnostic only — the same driver with the single `eval(next);` line removed
(not a valid fix, just to see what is next): compile 829–884 s, peak RSS
6.1–6.7 GB, fails with `Codegen error: Maximum call stack size exceeded` thrown
by a post-codegen finalize pass (`generateModule`'s finalize `try`; the
recursive fixup walkers descend mandreel's deeply nested `if` chains), plus
host-import leak warnings for browser APIs mandreel references
(`XMLHttpRequest_*`, `atob`/`btoa`, `__timer_set_timeout`/`__timer_set_interval`)
and unsupported `new Image()`/`new Audio()`.
