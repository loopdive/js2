---
id: 7470
title: "Same-named top-level bindings in different files share one module global"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7464, 4133, 3364]
---

# #7470 — same-named top-level bindings in different files share one module global

## Problem

Split from #7464 (case 4). When two files of one `compileMulti` program each declare a top-level binding of the same
name, both read and write one Wasm global. Every binding kind and type is affected. Measured on 640fa82feb
(2026-11-26); gc and standalone answer the same:

| shape (entry and dep each declare `g`; dep writes it, entry reads its own) | node | main |
| --- | --- | --- |
| `let g: number \| undefined` | 46 | 66 |
| `let g = 0` | 6 | 66 |
| `var g = 0` | 6 | 66 |
| `let g = 1` / `let g = 2` | 12 | 11 |
| `const` | 12 | 11 |
| string-typed `let` | 1 | 0 |
| number in one file, string in the other | 16 | trap: `illegal cast` |
| a closure or class method reading its own module's `g` | 36 | 33 |

## Cause

`registerModuleGlobal` (`src/codegen/module-global-registration.ts`) returns early when `ctx.moduleGlobals` already
holds the bare name, so the second module's declaration reuses the first module's `__mod_g`.

#3364 / #4204 (5eedb8a986) does not carry over: it resolves one predicate's left-hand side through
`ctx.oracle.variableDeclarationOf`, it does not key storage. The precedent that fits is #4133 for `funcMap`
(index.ts ~10205): the bare-name map stays, and colliding names are re-pointed at the compiling module's own entry
while that module's bodies compile.

Size: `ctx.moduleGlobals` has 242 references in 80 files (122 `.get`, 58 `.has`, 9 `.set`), `tdzGlobals` 20.
Re-keying every reader is out of proportion; per-module re-pointing is the route.

## Implementation Plan

Verified against 50bce1ba04 (branch `claude/7470-module-bindings`, stacked on #7464 / PR #7490) on 2026-11-26.

### Re-measurement (50bce1ba04, `compileMulti`, gc and standalone answer the same)

Every row of the table above still reproduces with the same numbers. The extra shapes the acceptance criteria
name, measured with probe `.tmp/v2.mts` (`c.ts` is `let g = 3; export function h() { return g; }`, `dep.ts` is
`export let g = 1; export function bump() { g = 2; }`):

| shape | node | 50bce1ba04 |
| --- | --- | --- |
| entry reads its own `let g: number \| undefined` after writing it, dep reads its own (`dep seed`) | 75 | 77 |
| `import { g }` from dep, third file `c` declares `g` (both import orders) | 23 | 22 |
| `import { g as k }` + own `let g = 5` + third file | 253 | 222 |
| `import d` of `export { g as default }` + own `g` + third file | 253 | 222 |
| re-export chain `mid: export { g, bump } from "./dep"` + third file | 23 | 22 |
| `import * as d`, `d.g` + third file | 23 | 22 |
| `import * as d`, `d.g` + own `g` + third file | 253 | 222 |
| three files, number / string / number | 71 | trap: `illegal cast` |
| the prototype's regression shape (`reg.mts`: third file's `g` is `0`, never written) | 20 | 20 |

The last row passes on HEAD only because the shared global happens to hold the right value; it is the row the
3-step prototype broke, and it goes into the pin test.

### Mechanism

Keep the bare-name maps (`ctx.moduleGlobals`, `ctx.tdzGlobals`) as the single keying scheme. A module-local table
records, per source file, the global (and TDZ flag) each colliding name means in that file. While a file's code
is emitted, the bare names are *projected* onto that file's entries and restored afterwards — the #4133 `funcMap`
route. A program without a collision records nothing, so single-file output and collision-free graphs keep their
bytes.

The table holds two kinds of entry per source, both `name → { value: GlobalDef; tdz?: GlobalDef }` (allocator
objects, not indices, because a late import shifts indices):

- **own**: a colliding top-level binding the source declares. The first module to declare a name keeps the
  bare-name entry; each later one mints its own `__mod_<name>` (same name: `ProgramAbiGlobalRegistry` and
  `multi-prepared-module-init-batch.ts:167` require `__mod_<name>`). On the first collision the owner joins the
  table too, so projecting the owner restores its global.
- **import**: an import binding whose bare entry is not the target's own global — named, renamed, default,
  re-export chains (the checker alias already resolves the chain in `registerImportBindingAliases`), and also
  `import { k as g }` where `g` is another file's colliding name. Recorded only when the bare entry differs, so a
  collision-free graph records nothing.

### Target structure

New module **`src/codegen/source-module-globals.ts`** (~150 lines), the only owner of the table:

- `sourceModuleGlobal(ctx, source, name)` — the `{ value, tdz }` `source`'s own binding of `name` lives in: its
  table entry, else the bare entry. The query every per-declaration reader uses; works with or without a
  projection active.
- `claimSourceModuleGlobal(ctx, name, source, mint)` — registration hook: records the bare owner, or mints and
  records the per-source global for a later declarer (the prototype's `foreignOwnedSourceModuleGlobal` +
  `noteBareModuleGlobalOwner`, merged into one call).
- `claimSourceModuleTdz(ctx, name, source, mint)` — the same for TDZ flags (step 5).
- `bindImportedModuleGlobal(ctx, importingSource, localName, targetDeclaration)` — records an import entry.
- `withSourceModuleGlobals(ctx, source, action)` — projects `source`'s own and import entries.
- `withProjectedModuleGlobals(ctx, bindings, action)` — the projection primitive: sets value and TDZ (deleting the
  TDZ entry when the binding has none), runs `action`, restores both. This is the save/restore loop that
  `withDirectRuntimeModuleBindings` (`declarations.ts:1759`) carries today; that function is rewritten to call it,
  so there is one projection mechanism, not two.

Plus one shared index helper: `absoluteGlobalIdx(ctx, global)` in `src/codegen/registry/imports.ts`, next to
`localGlobalIdx`. It replaces the two identical private copies `exactRuntimeModuleGlobalIndex`
(`declarations.ts:1686`) and `absoluteGlobalIndex` (`module-namespace-value.ts:750`).

### Ordered steps

1. **Table and projection.** Add `source-module-globals.ts`; classify it in `scripts/compiler-boundaries.json` like
   its siblings (`mixed-needs-split`, destination `backend-wasmgc`, owner `3518-coordinator`) in the same commit.
   Add `absoluteGlobalIdx`, fold the two duplicates into it, and rewrite `withDirectRuntimeModuleBindings` onto
   `withProjectedModuleGlobals`.
2. **Registration.** `registerModuleGlobal` (`module-global-registration.ts:207`) takes the declaring source
   (default `declaration?.getSourceFile()`) and asks `claimSourceModuleGlobal` before the bare-name reuse at
   line 237; the zero-init global construction moves to a private `allocateModuleGlobal`. Only under
   `ctx.sourceIsModule` (scripts share one global environment, §9.1.1.4). The hoisted-`var` walk
   (`registerVarDeclListGlobals`, `declarations.ts:3538`) passes `sourceFile`, because in a module it registers
   without a declaration. The runtime-namespace registrations (`declarations.ts:3472/3480`) use unique
   `__namespace_<pos>_<name>` names and never collide; the destructuring leaf (`:3100`) and the top-level
   statement (`:3839`) pass their declarations.
3. **Bodies, initialiser, overlays.** `withSourceModuleGlobals` wraps: the per-source body pass in
   `generateMultiModule` (`index.ts:10343`, both the Prepared `compileBodySource` and legacy
   `compileDeclarations` arms); each `__module_init` statement in `compileOrderedModuleInitEntry`
   (`declarations.ts:5679`), because one initialiser holds every module's statements; and each source of the IR
   overlay loop in `compileMultiPreparedProgramOverlays` (`index.ts:9849`), which runs after the body loop and
   reaches the bare-name lookups in `src/ir/integration.ts` (6147, 6325, 6761, 6817, 6902, 6983). Those lookups
   need no edit: they run under the projection, and where `ctx.programAbiGlobals` exists they already resolve by
   declaration through `moduleBinding(declaration)`, which step 2 observes with the per-source global.
4. **Imports.** In `registerImportBindingAliases.aliasOneBinding` (`index.ts:9415`), when the target declaration
   is a top-level `VariableDeclaration`/`BindingElement`, call `bindImportedModuleGlobal`; the flat copy at
   `index.ts:9610` copies `sourceModuleGlobal(target source, targetName)` instead of the bare target entry.
5. **TDZ flags.** `registerModuleTdzGlobal` (`module-global-registration.ts:282`): for a colliding name, only a
   source that declares it (`findRuntimeTopLevelDeclaration`) claims a flag, through `claimSourceModuleTdz`, and
   observes it on its own declaration; a non-declaring source's call is a no-op for that name. Today the first
   source to run `prepareModuleTdzGlobals` allocates every graph name's flag; that stays for non-colliding names.
   Because the table is consulted directly, this works outside a projection too — the Prepared path calls
   `prepareModuleTdzGlobals` from `multi-prepared-module-init.ts:272` and
   `multi-prepared-module-init-batch.ts:229`.
6. **Namespace objects.** `module-namespace-value.ts` builds `ns` while the *importer* compiles, so it must not
   read the importer's projection. `NamespaceGlobalExport` / `NamespaceLiveExport` carry the declaring source
   beside `globalName`; the four lookups (`topLevelVariableBinding` 250, `rebaseNamespaceGlobalReads` 743,
   `ensureLiveBindingGetters` 807–809, the `global` arm 1250) and the TDZ test at 437 resolve through
   `sourceModuleGlobal(source, name)`.
7. **Seeds and default export.** `moduleF64UndefinedSeedGlobals` (`module-var-undefined-seed.ts:173`) walks every
   source's declarations: each looks itself up with `sourceModuleGlobal(source, name)`.
   `emitModuleVarUndefinedSeeds` records seeded globals (allocator objects) instead of names, and
   `moduleVarSlotIsUndefinedSeeded` (read by `statements/variables.ts:1618` under the projection) compares the
   projected global. The multi-source deferred `export default <var>` (`index.ts:10393`, finds the first
   `__mod_<name>`) resolves through `sourceModuleGlobal(entryFile, name)`; the single-source twin (6168) is
   untouched.
8. **Pin test** `tests/issue-7470-same-named-module-bindings.test.ts`: every row of both tables, gc and
   standalone, each compared with node's answer.

### Sites checked and left alone

- Exports: `compileMulti` exports only the entry's functions; the only global export is step 7's default.
  `export =` does not export a global.
- `globalThis` / var-as-global-property: script goal only; the table is off when `!ctx.sourceIsModule`.
- Closures and class bodies: compiled inside their module's body pass, so they see its projection (the
  prototype's `closure` and `class` rows pass).
- `annexb-global-live-binding.ts:189`: Annex B B.3.3 is sloppy-script only.
- `runtime-eval-provider.ts:178`, `runtime-eval-callable.ts:585`: internal carrier names.

### Risks

- **A body emitted outside its module's pass** sees the end-state (bare-owner) view. Known late emitters: method
  trampolines (`finalizeMethodTrampolines`, no module-binding reads), namespace getters (step 6). Any other one
  found by the pin test is wrapped in `withSourceModuleGlobals(declaration.getSourceFile())`.
- **A writer that sets a projected name during the action** is undone by the restore. Registration happens at
  collect time, before any projection; `closures.ts:1192` promotes a *function-local* TDZ flag to a global under
  the local's name — if that name is a projected module name the promotion is lost. The pin test adds a closure
  over a same-named function-local `let` to rule it out, or the promotion is routed through the table.
- **Graph-global TDZ elision.** `prepareModuleTdzGlobals` deletes from the graph-global `ctx.tdzLetConstNames`.
  For a colliding name one module's elision must not remove another module's flag; step 5 decides colliding
  names per declaring module and leaves the deletion path for the rest.

### Out of scope (file separately once measured)

- `src/codegen-linear` keeps its own name-keyed `moduleGlobals` (9 references).
- Same-named *reassigned functions* share one `__mod_<fn>` live-binding global (`registerReassignedFunctionGlobals`,
  `index.ts:9254`); same family, function side.
- `emitModuleVarUndefinedSeeds` walks only the source passed to the prologue (the last one in `compileMulti`), so
  other modules' externref `var`s are not seeded; pre-existing, independent of collisions.

### Size

10 files: 1 new (`source-module-globals.ts`), 6 edited sources (`module-global-registration.ts`,
`declarations.ts`, `index.ts`, `module-namespace-value.ts`, `declarations/module-var-undefined-seed.ts`,
`registry/imports.ts`), `scripts/compiler-boundaries.json`, the pin test, this issue. No redesign of
`moduleGlobals`. `declarations.ts` and `index.ts` should shrink or stay flat (the projection loop and an index
helper leave them).

### Validation

- The pin test fails on 50bce1ba04 for every row except the `reg.mts` regression row, and passes after.
- Single-file bytes: 240 test262 files × gc/standalone (`.tmp/hash.mts`, `.tmp/sample2.txt`), base vs new,
  identical.
- The 283 test files that call `compileMulti` stay green (run the related subset; CI runs the rest).
- lodash-es: `runLodashUpstreamSuite` in `scripts/generate-npm-compat-report.mjs` (`--only lodash-es`, no write),
  plus `tests/lodash-es-e2e.test.ts` and `tests/issue-6985-lodash-es-o4.test.ts`, before and after.
- Gates unpiped: loc/func budget (also with `LOC_GATE_BASE` = `origin/main` and = the #7490 tip), coercion sites,
  oracle ratchet, dead exports, import cycles, compiler boundaries (`--base HEAD^1` and `--base origin/main`),
  prettier on changed files; `node scripts/equivalence-gate.mjs` once at the end.

### Code-quality acceptance criterion

- `source-module-globals.ts` is the only code that knows the per-source table; every other site asks
  `sourceModuleGlobal` or runs inside `withSourceModuleGlobals`. No second keying scheme beside the bare maps.
- One projection primitive: `withDirectRuntimeModuleBindings` and the per-source projection share
  `withProjectedModuleGlobals`; one `absoluteGlobalIdx` replaces the two private copies.
- No budget grants, no new functions over the func budget, no defensive branches for states the table cannot
  reach.

## Acceptance criteria

- Every row above, plus the imported-binding shapes (named, renamed, namespace, a third same-named file), answers
  like node on gc and standalone, pinned with `compileMulti` tests that fail on main.
- Single-file output byte-identical (test262 is single-file; check a sample on gc and standalone).
- The test files that call `compileMulti` stay green.
- lodash-es (97 top-level names declared in more than one file, e.g. `objectProto` ×30) compiles and validates
  before and after; its npm-compat test results do not regress.
- Code quality: one helper owns the per-module table; no second keying scheme beside `moduleGlobals`; no budget
  grants.
