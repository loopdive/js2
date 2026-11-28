---
id: 7625
title: "A named import of a module namespace (`export * as ns`) reads as null, and namespace objects have no identity"
status: done
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
completed: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
parent: 7620
depends_on: [7558]
related: [7620, 7622, 7627]
---

# #7625 — named imports of a module namespace, and namespace identity

Child A of #7620 (gap 1). The PRV-7620 review confirmed the cause and the reuse. This file adds the rows the review
asked for, the cache-key disjointness argument, and non-null identity pins.

## Problem

A binding that names a module namespace through an import (`import { ns } from "./mid"`, where mid has
`export * as ns from "./dep"` or `import * as ns …; export { ns }`) compiles to `ref.null extern`. Every use throws,
or reads as empty. Separately, two routes to the same module's namespace give two different objects.

### Measured

Measured on 2026-11-28 with node v22.23.5, on `ada18e6bb6` (head of PR #7558) and on origin/main `01c9284f78`.

- `compileMulti`; mid is `export * as ns from "./dep"`, dep is `export let g = 7` unless noted.
- Probes: `.tmp/p7620/{a-cases.mjs,cases6.mjs,rows.mts}` in the c8-7620 worktree.
- Both bases, standalone and gc, and IR on and off all agree.

| row | entry (and extra modules) | node | ours |
| --- | --- | --- | --- |
| `a_read` | `import { ns } from "./mid"; ns.g * 10 + 3` | 73 | throws |
| `a_renamed_import` | `import { ns as q } from "./mid"; q.g * 10 + 3` | 73 | throws |
| `a_renamed_reexport` | `import { m2 } from "./mid2"`, mid2 is `export { ns as m2 } from "./mid"` | 73 | throws |
| `a_export_star_carries` | `import { ns } from "./mid2"`, mid2 is `export * from "./mid"` | 73 | throws |
| `a_as_value` | `function take(o) { return o.g } take(ns) * 10 + 3` | 73 | throws |
| `a_keys` | `Object.keys(ns)`: length × 10 + (first key is `"g"` ? 3 : 0) | 13 | 0 |
| `n2` | mid is `import * as ns from "./dep"; export { ns }` | 73 | throws |
| `n3` / `n4` | dep exports only `const g` / only `function f` (`ns.f()`) | 73 | throws |
| `n1` (guard) | `import * as m from "./mid"; m.ns.g` (#6651 N3 nested arm) | 73 | 73 |
| `n5` (guard) | `typeof ns === "object"` | 1 | 1 |
| `a_id_nonnull_vs_nested` | `import * as d; import * as m from "./mid"`: (`d` non-null ? 10 : 0) + (`d === m.ns` ? 1 : 0) | 11 | 10 |
| `a_id_nonnull_two_files` | `d` and another file's `import * as d2` of dep, same shape | 11 | 10 |
| `a_id_named_vs_star` | `ns` (named) vs `d` (`import * as`): same shape | 11 | 0 (`ns` null) |

The identity rows assert non-null first (the review's finding 2). A null `ns` cannot pass by being `===` to another
null.

### Cause

`tryEmitCompiledModuleNamespaceObject` (`src/codegen/module-namespace-value.ts:1359`) admits only a
`ts.NamespaceImport` declaration (`:1366`). For a named import the declaration is an `ImportSpecifier`, whose aliased
value declaration is dep's `SourceFile`. So it declines, and `compileIdentifierCore` (`identifiers.ts:1393`) falls
through to the null fallback.

- **Identity.** A `NamespaceImport` is keyed by its own declaration (`emitNamespaceObject(…, declaration, …)`, `:1367`).
  The N3 nested arm (`:420-430`) and `tryEmitModuleNamespaceObjectForSource` (`:1376`) key by the module symbol. So
  every `import * as` site of a module, and the nested `m.ns`, each build their own object.
- **Experiment.** A throwaway patch on main made `a_read`, `n2`, `n3` and `ns.bump()` (IR on) answer like node. It
  routed an import binding whose `ctx.oracle.aliasedValueDeclarationOf` is a `SourceFile` through
  `tryEmitModuleNamespaceObjectForSource`. `ns.f()` with IR off still throws: that is #7622, not this issue.

## Implementation Plan

**Change (all in `module-namespace-value.ts`).**

1. New exported `moduleNamespaceSourceOf(ctx, identifier): ts.SourceFile | undefined`, next to `moduleSourceFile`
   (`:331`). It returns the module `SourceFile` when the identifier is a `NamespaceImport`, or an
   `ImportSpecifier`/`ImportClause` whose `ctx.oracle.aliasedValueDeclarationOf` is a `SourceFile`. The import-side
   pattern already exists in `importsOwnNamespace` (`module-global-registration.ts:390`).
   - The renamed and `export *` rows need no extra code: the checker's alias chain already resolves `m2` and the
     `export *`-carried `ns` to dep's module symbol. The pin proves it.
2. `tryEmitCompiledModuleNamespaceObject` becomes "resolve `moduleNamespaceSourceOf`, then
   `tryEmitModuleNamespaceObjectForSource`". The #5330 Node-builtin decline moves into the shared entry, and
   `namespaceFunctionExports` (`:335`) becomes dead and is deleted. All module namespace objects are now keyed by the
   module symbol, which fixes the identity rows.
3. `isRuntimeNamespaceReceiver` (`calls.ts:2750`) and `runtimeNamespaceFunctionValueReceiver` (`property-access.ts:3424`)
   ask `moduleNamespaceSourceOf` for their module half, so `ns.f()` behind `export * as` takes the static member-call
   path like an `import * as` receiver.
   - This removes the four-times-copied alias check (`namespaceFunctionExports`, `canonicalRuntimeNamespaceSymbol`
     `:565`, and those two).
   - Both files are over the 1,500 threshold, so each edit must be net-zero or negative: a call replaces an inline
     check.
4. `identifiers.ts` is not edited; its call at `:1393` is unchanged.

**Cache keys are disjoint from `tryEmitCompiledRuntimeNamespaceFunctionObject`'s.** This is an analysis; the
module-augmentation case below is not measured.

- One `WeakMap<object, NamespaceObjectCache>` (`cacheMap`, `:306`) holds both.
- After step 2, module namespace keys are module `ts.Symbol`s whose declarations include a `SourceFile`.
- The runtime-namespace surface keys (`:1430`, `surface.symbol`) come from `canonicalRuntimeNamespaceSymbol` (`:565`):
  a `ts.Symbol` with a non-declaration-file `ModuleDeclaration` whose body is a `ModuleBlock` (a TypeScript
  `namespace N {}`). The two sets are disjoint unless one symbol has both declarations.
- That can happen through a **module augmentation**: `declare module "./dep" { … }` in a `.ts` file merges into dep's
  module symbol. `canonicalRuntimeNamespaceSymbol` checks `isDeclarationFile` but not the `declare` modifier.
- So the plan adds one condition there: return `undefined` for a symbol that has a `SourceFile` declaration. Module
  symbols belong to the module-namespace path. A pin row covers it: a module augmentation plus `import * as d` plus
  `d.f()`.

**Pipeline.** Legacy only. The IR refuses these units (`body-shape-rejected`).

**#7558 dependency.** None semantically. But #7558 rewrites the export-kind hunks of the same file (`:233-480`), so
this child is based on #7558's head, or lands after #7558.

**Size.** `module-namespace-value.ts` is 1,431 lines, 69 under the threshold. Step 2 deletes `namespaceFunctionExports`
(about 40 lines); steps 1 and 3 add about 15. If the net goes above about +60, move the import-binding entry points into
a sibling module. No grant.

## Acceptance criteria

- **Pin test (red → green).** A new `tests/issue-7625-module-namespace-import-binding.test.ts` holds every row of the
  table, × standalone/gc × `experimentalIR` on/off, compared with node.
  - It is red on `ada18e6bb6`, except the guard rows.
  - Identity rows assert non-null and equality separately.
  - Rows whose IR-off cell needs #7622 (a namespace function call with IR off) carry a comment naming #7622, and turn
    green when #7622 lands. #7622 is ordered before these IR-off pins.
  - Extra row: the module-augmentation disjointness case.
- **Code quality.**
  - One `moduleNamespaceSourceOf` replaces the duplicated alias checks, and `namespaceFunctionExports` is deleted.
  - There is no new cache-key kind; the disjointness guard is one condition.
  - `identifiers.ts` does not grow, `calls.ts` and `property-access.ts` do not grow, and `module-namespace-value.ts`
    stays under 1,500 with no grant.
  - The budget gates pass with `LOC_GATE_BASE` set to the upstream main tip.
  - An adversarial review verdict goes in the PR body.
- **Bytes.** gc output is byte-identical on the #7470 389-file single-file corpus and on the multi-file graphs without
  an `import * as` of a module that is reached by two routes. The expected diffs are listed in the PR: graphs where
  one module's namespace is now built once instead of per import site.
- **No test262 regression** in the scoped `language/module-code|language/import|language/export` per-test diff on
  standalone. The 8 `export * as` files are reported before and after (verdicts in #7620).

## Results (2026-11-28)

Measured on branch `claude/7625-named-import-namespace`, base origin/main `5e3c790785`, fix commit `0b8d799bb4`,
node v22.23.5. Base runs swap the three changed files back to `5e3c790785` (file-copy A/B).

### Pin test (`tests/issue-7625-module-namespace-import-binding.test.ts`)

15 rows × gc/standalone × IR on/off = 60 cases. Node's answers were re-checked by running the transpiled sources in
node.

| lane | red on `5e3c790785` | after |
| --- | --- | --- |
| gc, IR on | 12 of 15 (guards `n1`, `n5` and the augmentation row green) | 15/15 |
| gc, IR off | 11 of 13 non-#7622 rows (guards green) | 13/13, plus 2 expected failures |
| standalone, IR on | 12 of 15 | 15/15 |
| standalone, IR off | 11 of 13 | 13/13, plus 2 expected failures |

- The 2 expected failures per IR-off lane are `n4` (`ns.f()`) and the augmentation row (`d.f()`): a namespace
  function call with the IR path off throws until #7622 lands. They run as `it.fails` with a comment naming #7622, so
  they turn red when #7622 lands and must then become plain `it`.
- The augmentation row already passed before (IR on). It guards the disjointness condition.

### Bytes

- **Single-file corpus: identical.** 390 files × gc/standalone = 780 compiles, base vs fix, 0 differences. The
  #7470 file lists were not available, so the corpus is rebuilt: the first 240 files of the ES5 sample
  (`es5-sample.txt`) plus all 150 module-goal files (`flags: [module]`, with `import`/`export`, no `_FIXTURE`, not
  negative) of `language/module-code`, `language/export` and `language/import`.
- **Multi-file graphs.** The 31 #7470 pin graphs × gc/standalone × IR on/off (124 compiles) are identical. Of the
  #7625 pin graphs, exactly the expected ones differ:
  - every named-import row (`a_read`, `a_renamed_*`, `a_export_star_carries`, `a_as_value`, `a_keys`, `n2`, `n3`, and
    `n4` with IR on): the namespace object is now built instead of `ref.null`;
  - the three identity rows: one module's namespace is now built once instead of once per route.
  - Unchanged: the guards `n1` and `n5`, the augmentation row, and `n4` with IR off (still #7622).

### Other checks

- **Scoped test262, standalone, CI lane** (`TEST262_TARGET=standalone`, `TEST262_PATH_FILTER_FILE` over the 731
  `language/module-code|language/import|language/export` files, workspace runs): 437 pass on base, 439 after, 0
  pass → non-pass. Fail → pass: `module-code/export-star-as-dflt.js` and `module-code/instn-star-equality.js`.
  - The 8 `export * as` files of #7620: `export-star-as-dflt.js` fail → pass; the other 7 pass before and after.
  - Against the CI standalone baseline (27.11.2026 03:47, 437 pass in scope), one baseline pass is non-pass in both
    local runs (`export-expname-import-string-binding.js`), so this change does not cause it.
- **Namespace and module tests** (the 26 `namespace`/`5330`/`7470` test files): the same 20 failures on base and
  fix, all pre-existing (the #7623 "non-exact graph edge" error, missing FYI fixtures, host-lane environment).
- **Equivalence gate:** exits 0; 4,856 pass, 20 fail, no new regressions (2 baseline failures now pass).
- **Gates:** loc, func, coercion sites, oracle ratchet (`ctx.checker` −6) and dead exports pass; loc and func also
  pass with `LOC_GATE_BASE=5e3c790785`; compiler boundaries pass against `HEAD^1` and origin/main.
  - origin/main advanced to `4aa8ea4c46` during the work. With that tip as `LOC_GATE_BASE`, loc and func report
    `src/codegen/index.ts` growth that main itself made (#7572). This branch does not touch `index.ts`, main does not
    touch the changed files, and the merge is clean.
- **Sizes:** `module-namespace-value.ts` 1,431 → 1,418, `calls.ts` 9,829 → 9,814, `property-access.ts`
  6,209 → 6,200; `identifiers.ts` unchanged.

### Deviations from the plan

- **The #5330 builtin decline stays on the object path** (`tryEmitCompiledModuleNamespaceObject`, helper
  `importsNodeBuiltin`) instead of moving into `moduleNamespaceSourceOf`. In `moduleNamespaceSourceOf` it would also
  stop the member-call and function-value receivers from taking the static path for a builtin specifier that resolves
  to a source file, which they do today.
- **`aliasedSymbolAt`** (new, in `module-namespace-value.ts`) carries the getSymbolAtLocation + getAliasedSymbol
  lookup that `canonicalRuntimeNamespaceSymbol`, `isRuntimeNamespaceReceiver` and
  `runtimeNamespaceFunctionValueReceiver` each copied. `moduleNamespaceSourceOf` alone answers only their module half,
  so this helper is what removes those copies.
- The adversarial review is not run yet; it belongs to the PR.
