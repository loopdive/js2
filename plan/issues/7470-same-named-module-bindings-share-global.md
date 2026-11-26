---
id: 7470
title: "Same-named top-level bindings in different files share one module global"
status: ready
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

New helper module `src/codegen/source-module-globals.ts` owns the per-module binding table; every site below asks it.

1. **Registration.** A non-owner module's declaration of a colliding name mints its own global. The hoisted-`var`
   walk passes its `sourceFile`, because in modules it registers without a declaration.
2. **Function bodies.** `withSourceModuleGlobals` wraps each module's body pass in the `compileMulti` loop
   (index.ts).
3. **Module initialiser.** The same wrapper around each `__module_init` statement (`compileOrderedModuleInitEntry`):
   one initialiser holds every module's statements.
4. **Imports.** For every import whose target is a colliding binding, bind the local name to the target module's
   global via `ctx.oracle.aliasedValueDeclarationOf`: named, renamed, default and re-export chains.
   `registerImportBindingAliases` (index.ts ~9617) copies the owner's index today.
5. **Namespace imports.** `src/codegen/module-namespace-value.ts` resolves `ns.g` by bare export name at 4 sites
   (~250, 743, 807, 1250), the TDZ flag included.
6. **TDZ flags.** `registerModuleTdzGlobal` and `tdzGlobals` get the same per-module treatment.
7. **`undefined` seeds.** `moduleF64UndefinedSeedGlobals` looks each module's declarations up by bare name;
   `emitModuleVarUndefinedSeeds` walks one module only. Both resolve per module.
8. **IR overlays.** `compileMultiPreparedProgramOverlays` runs after the body loop, and `src/ir/integration.ts` has
   5 bare-name lookups; they take the same per-module binding.

Out of scope: `src/codegen-linear` keeps its own name-keyed `moduleGlobals` (9 references) and likely has the same
defect; file it separately once measured.

A 3-step prototype (steps 1–3) fixed every row above with single-file bytes unchanged, but broke a shape that works
today: entry imports `g` from dep while a third file also declares `g` — node 20, main 20 (by the shared-global
accident), prototype 0. Steps 4–5 are therefore part of the minimum change, not follow-ups.

## Acceptance criteria

- Every row above, plus the imported-binding shapes (named, renamed, namespace, a third same-named file), answers
  like node on gc and standalone, pinned with `compileMulti` tests that fail on main.
- Single-file output byte-identical (test262 is single-file; check a sample on gc and standalone).
- The test files that call `compileMulti` stay green.
- lodash-es (97 top-level names declared in more than one file, e.g. `objectProto` ×30) compiles and validates
  before and after; its npm-compat test results do not regress.
- Code quality: one helper owns the per-module table; no second keying scheme beside `moduleGlobals`; no budget
  grants.
