---
id: 7530
title: "Same-named reassigned functions in different files share one live-binding global"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7470]
---

# #7530 — same-named reassigned functions share one live-binding global

## Problem

Found while planning #7470, which covers the same defect for top-level variable bindings. When two files of one
`compileMulti` program each declare `function f` and one of them reassigns it, both files read and write one
`__mod_f` live-binding global (`registerReassignedFunctionGlobals`, `src/codegen/index.ts` ~L9254). Measured on
50bce1ba04 (2026-11-26); gc and standalone give the same answers:

| shape | node | now |
| --- | --- | --- |
| dep reassigns its own `f`; entry calls its own `f` | 12 | 42 |
| entry reassigns its own `f`; dep calls its own `f` | 14 | 34 |

## Plan

Fix this after #7470 and reuse its per-module binding table (`src/codegen/module-binding-table.ts`, projected by
`src/codegen/source-binding-projection.ts`; there is no `source-module-globals.ts`). Do not add a second keying
scheme. The full plan is under "Implementation Plan" below.

## Acceptance criteria

- Both rows, plus an imported reassigned function, answer like node on gc and standalone. Pin them with
  `compileMulti` tests that fail on main.
- Single-file output stays byte-identical.

## Implementation Plan

Written against ada18e6bb6 (PR #7558 head, #7470) on 2026-11-28.

### Measurement (ada18e6bb6, 2026-11-28, `compileMulti`, probe `.tmp/7530/probe.mts`)

The node column is node 22 running the `ts.transpileModule` output of the same sources.

| shape | node | gc IR on | gc IR off | standalone IR on | standalone IR off |
| --- | --- | --- | --- | --- | --- |
| A dep reassigns its own `f`; entry calls its own `f` (issue row 1) | 12 | 42 | 42 | 42 | 42 |
| B entry reassigns its own `f`; dep calls its own `f` | 34 | 34 | 34 | 34 | 34 |
| B2 entry reads, then reassigns its own `f`; dep calls its own | 14 | 14 | 14 | 14 | 14 |
| B3 entry reassigns its own `f`, then dep calls its own | 42 | 42 | 42 | 42 | 42 |
| C both reassign their own `f` | 24 | 44 | 44 | 44 | 44 |
| D seed: dep reads its own `f` before and after its swap | 314 | 343 | 343 | 343 | 343 |
| E `import { f }` of dep's reassigned `f`, no collision | 12 | 12 | 12 | 12 | 12 |
| F E plus a third file with its own `function f` | 125 | 122 | 122 | 122 | 122 |
| G `import { f as k }` of dep's reassigned `f`, entry's own `function f` | 127 | 112 | 112 | 112 | 112 |
| H entry imports a never-reassigned `f` from `lib`; dep reassigns its own `f` | 12 | 42 | 42 | 42 | 42 |
| I G's alias `k` and a third file's own `function k` | 25 | 55 | 55 | 55 | 55 |
| I0 control for I: nothing reassigned | 15 | 15 | 55 | 15 | 55 |

- **The issue's row 2 no longer reproduces.** It read 14 in node and 34 on 50bce1ba04 ("entry reassigns, dep calls"). B, B2 and
  B3 all match node on this head.
- **What still fails.** A file whose own `f` is not reassigned reads another file's live global (A, D, F, H). Both
  files reassigning (C) and the renamed import (G) also fail.
- **I0 is a separate defect.** It fails with the IR path off even when nothing is reassigned: an import alias whose
  local name is another file's own function. It belongs to the #4133 family (two files' functions sharing one
  bare-name `funcMap` entry), not to this issue. File it on its own. Row I is in scope with the IR path on only.

### Cause

- **Registration is by name.** `registerReassignedFunctionGlobals` (`src/codegen/index.ts:9053`) collects exact
  declarations (`reassignedDeclarations`) but registers one `__mod_f` per name (`index.ts:9224-9237`). It finds the
  function through `ctx.funcMap.get(name)`, which holds the last file's `f` after collect. It also skips the name
  when `ctx.moduleGlobals.has(name)`, even when another module's binding holds that entry.
- **Liveness is graph-wide.** `ctx.liveFuncBindingGlobals` is a name set, so every file that spells `f` treats it as
  live.
- **The seed walks names.** The prologue seed (`declarations/module-init-prologue.ts:94-133`) walks that set by name,
  under whatever view the last body pass applied.

### Design

A reassigned function's live global becomes a binding in #7470's table. Whether a name is a live function becomes
part of what a bare name shows in the per-file view. No new keying and no new projection.

1. **The table admits functions** (`src/codegen/module-binding-table.ts`).
   - `ModuleBindingDeclaration` adds `ts.FunctionDeclaration`. The scope key does not change (a module's SourceFile,
     or the Script realm), so `var f` and `function f` in one scope stay one binding.
   - `ModuleBinding` gains `liveFunction?: true`.
   - The table keeps live-function bindings in registration order: `markLiveFunctionBinding(ctx, binding)` and
     `liveFunctionBindings(ctx)`. Their users are registration and the prologue seed.
   - `ProgramAbiGlobalRegistry.moduleBinding` (`program-abi-global-planning.ts:61`) keeps a parameter typed as
     `IrModuleBindingDeclaration` (a variable or binding element). So `src/ir` cannot ask about a function binding,
     and needs no change.
2. **Registration** (`src/codegen/module-global-registration.ts`).
   - Extract the tail of `registerModuleGlobal` (lines 243-258) into one private helper. The tail does the scoped
     lookup, mints a bare global, allocates or reuses one, then adds and attaches the binding.
     `registerModuleGlobal` calls the helper after its guards.
   - New `registerLiveFunctionGlobal(ctx, declaration)` calls the same helper with `{ kind: "externref" }`.
   - It registers nothing in the two cases where today's loop `continue`s: the scope already has a binding of the
     name (a same-scope `var f`), or the bare entry is a global no binding holds.
   - Otherwise it mints the global, marks the binding live and adds the name to `ctx.liveFuncBindingGlobals`.
   - A bare entry held by another module's binding now gets its own global. Today that global is silently shared.
3. **The caller** (`index.ts`, `registerReassignedFunctionGlobals`).
   - The loop at 9224-9237 iterates `reassignedDeclarations` and calls `registerLiveFunctionGlobal`. The
     defined-function check uses `ownSourceFunctionIdx(ctx, sourceFile, name) ?? ctx.funcMap.get(name)`, so a
     colliding name checks its own file's function.
   - **Duplicate removed:** the parallel `reassigned` name set. Each of its adds pairs with a declaration add.
     `evalOnlyLiveFuncBindings` asks the declaration set instead.
   - The implementer confirms that the eval branch (9204-9217) always has a declaration (`topLevelFunctionDeclarations`
     is filled together with `topLevelFunctionNames`). If it can lack one, that name keeps today's name-keyed path,
     with the reason in a comment.
   - **Duplicate removed:** the inline `__mod_` global push (9227-9233), replaced by `allocateModuleGlobal`.
4. **Projection** (`src/codegen/source-binding-projection.ts`).
   - **The state carries liveness.** `ModuleNameState` gains `liveFunction?: boolean`.
     - `moduleNameState` captures `liveFuncBindingGlobals.has(name)` for a non-colliding name.
     - `setModuleNameState` adds the name to the set or removes it, next to the two maps.
     - A `ModuleBinding` is already a `ModuleNameState`, so the view's `globals` entries carry their liveness.
   - **A view can hide a name.** `SourceBindingView.globals` becomes `Map<string, ModuleNameState>`. A frozen
     `NO_MODULE_BINDING = {}` state hides a name: no value, no flag, not live.
   - **Two new rules** in `recordSourceModuleBindingView`:
     - each of the file's own colliding functions (`view.ownFunctions`) that has no binding of its own, while the name
       has a binding elsewhere, gets `NO_MODULE_BINDING` (rows A, C, D, F, G);
     - each import whose target has no module binding, under a name some binding holds, gets `NO_MODULE_BINDING`
       (row H).
   - **Live-function imports need no new rule.** The existing import rule handles a target that is a live function
     once step 1 attaches the declaration (rows F, G). So does `registerImportBindingAliases` (`index.ts:9583`),
     which already prefers `moduleBindingOf(target)`.
   - **A namespace now hides liveness too.** `withDirectRuntimeModuleBindings` (`declarations.ts:1737`) shares
     `setModuleNameState`. While a namespace body compiles, a namespace variable projected over a live function's
     name now also hides that liveness. That is the correct scope. The single-file byte gate covers it.
5. **Seed** (`src/codegen/declarations/module-init-prologue.ts`).
   - Extract the per-name body of the loop at 96-132 into `seedLiveBinding(ctx, initFctx, name, seededGlobals)`.
   - **First pass:** for each `liveFunctionBindings(ctx)` record, run it inside
     `withSourceBindings(ctx, record.source, …)`. That is #7470's nested-view path: it lifts the last file's view and
     applies the record's file.
   - **Second pass:** the remaining names in the set (Annex B, import aliases), as today.
   - In a graph without views, `withSourceBindings` just runs the action, and the two passes visit names in today's
     order.
   - `moduleInitPrologueForcesInit` (139-145) also counts `liveFunctionBindings(ctx).length`, because the set it
     reads may be the projected one.

### Byte identity

- **Single file.** No views exist, there is one scope, and declarations register in today's name order (the
  `reassigned` and `reassignedDeclarations` adds are paired). So the same globals are minted in the same order.
  - Gate: copy `.tmp/hash.mts` and `.tmp/sample3.txt` from the `claude/7470-module-bindings` worktree.
  - Run the 389 files × gc/standalone on the base (ada18e6bb6) and on the new code. The outputs must be identical.
- **Multi-file without collisions.** Copy `.tmp/mhash.mts` and add the `E` graph (an imported reassigned function),
  so the live path is covered. Base vs new, gc/standalone × IR on/off: identical.

### Tests

New `tests/issue-7530-same-named-reassigned-functions.test.ts`, using the harness of
`tests/issue-7470-same-named-module-bindings.test.ts`.

- **Pin rows.** A, B, B2, C, D, E, F, G and H, with node's answers, × gc/standalone × `experimentalIR` on/off.
- **Row I** with the IR path on only, citing the I0 issue.
- **Rows that pass today.** B, B2 and E show that the fix keeps the reassigning file's own reads and the
  non-colliding import working.
- **Related suites.** `tests/issue-7470-*`, `tests/issue-2930*`, `tests/issue-2931*`, `tests/issue-4133*`,
  `tests/issue-4182*` (Annex B seeds) and `tests/issue-3505*`.
- **Gates.** The usual gates, unpiped, including `check:import-cycles`, because `module-init-prologue.ts` now imports
  the projection module.

### Risks

- **Set readers outside a body pass.** Three files read `ctx.liveFuncBindingGlobals` at collect-time state:
  `multi-prepared-module-init.ts:150`, `multi-prepared-module-init-census.ts:280` and
  `ir-overlay-preparation.ts:115/168`. If the IR-on pin rows show one of them running inside a view, it asks
  `liveFunctionBindings(ctx)` instead. Do not add a second set.
- **The table answers for more declarations.** `moduleBindingOf` (typed `ts.Declaration`) now answers for function
  declarations. Its codegen callers gate on a variable or binding element first:
  - `module-namespace-value.ts:255`
  - `module-var-undefined-seed.ts:135`
  - `source-binding-projection.ts:130`
  - `index.ts:9583`

  The last two are the intended new users.

### Files and functions (for the lane split with C8, #7620)

| file | functions / region |
| --- | --- |
| `src/codegen/module-binding-table.ts` | `ModuleBindingDeclaration`, `ModuleBinding`, the table record; new `markLiveFunctionBinding`, `liveFunctionBindings` |
| `src/codegen/source-binding-projection.ts` | `SourceBindingView`, `recordSourceModuleBindingView`, `ModuleNameState`, `moduleNameState`, `setModuleNameState`; new `NO_MODULE_BINDING` |
| `src/codegen/module-global-registration.ts` | `registerModuleGlobal` (203-259, tail extracted); new `registerLiveFunctionGlobal` right after it. The TDZ functions (309 onward) are untouched |
| `src/codegen/index.ts` | `registerReassignedFunctionGlobals` (9053-9240) only |
| `src/codegen/declarations/module-init-prologue.ts` | the live-binding seed loop (88-133), `moduleInitPrologueForcesInit` (139-145) |
| `src/codegen/program-abi-global-planning.ts` | the `moduleBinding` parameter type only, and only if the widened alias reaches it |
| `tests/issue-7530-same-named-reassigned-functions.test.ts` | new |

- **Not touched:** `module-namespace-value.ts`, `identifiers.ts`, `identifier-module-storage.ts`, `declarations.ts`,
  the TDZ registration functions and `src/ir/`.
- **Expected C8 overlap.** The C8 shapes (`export * as ns`, a block-local `let` shadowing an import, cyclic-import
  TDZ) most likely land in `module-namespace-value.ts`, the identifier readers and the TDZ functions of
  `module-global-registration.ts`. The only shared file is `module-global-registration.ts`, in disjoint regions.

### Code-quality acceptance criterion

- **One allocation authority.** Live-function globals are minted through the same helper as `registerModuleGlobal`.
  No second `__mod_` push remains in `index.ts`.
- **One projection.** Liveness travels in `ModuleNameState`. No second save and restore exists for
  `liveFuncBindingGlobals`.
- **No parallel name set** beside `reassignedDeclarations`.
- **No budget grants and no new module.** `index.ts` shrinks. No branch handles a state the table cannot reach.
- **Review.** The adversarial review checks each of these points.
