---
id: 7625
title: "A named import of a module namespace (`export * as ns`) reads as null, and namespace objects have no identity"
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
