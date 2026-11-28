---
id: 7626
title: "A read of a cyclic import before its binding is initialized does not throw"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
parent: 7620
depends_on: [7558]
related: [7620, 7470, 7558]
---

# #7626 — cyclic-import TDZ

Child C of #7620 (gap 3). The PRV-7620 review confirmed that this reuses `prepareCollidingModuleTdz`'s first-call
rule. This file applies the review's simpler rule (finding 10), says how the import graph is found (finding 9), adds
rows, defines the interaction with the per-file `tdzLetConstNames` deletion, and gives the expected byte diffs.

## Problem

In an import cycle, a module that evaluates first can read a `let`/`const`/`class` binding of a module that has not
run yet. That read must throw a ReferenceError. Ours returns the zero-initialized cell.

### Measured

Measured on 2026-11-28 with node v22.23.5, on `ada18e6bb6` (head of PR #7558) and on origin/main `01c9284f78`.

- `compileMulti`; entry is `import { y } from "./dep"; export let g = 1;` with `main` returning `y`, unless noted.
- Probes: `.tmp/p7620/{c-cases.mjs,rows.mts}` in the c8-7620 worktree.
- Both bases, standalone and gc, and IR on and off all agree.

| row | dep (evaluates first) or shape | node | ours |
| --- | --- | --- | --- |
| `direct_plus13` | `import { g } from "./entry"; try { y = g + 13 } catch { y = 4 }` | 4 | 13 |
| `const_export` | entry has `export const g = 1` | 4 | 13 |
| `fn_plus10` | `function r() { return g }`, `y = r() + 10`; main returns `y * 10 + g` | 41 | 101 |
| `fn_plus13` | the same with `r() + 13` | 41 | 131 |
| `arrow_cross` | `const f = () => g`, `y = f() + 13` | 4 | 13 |
| `three_cycle` | entry → b → c → entry, with `b` re-exporting `c`'s `y` | 4 | 13 |
| `three_cycle_true` | entry → b → c → entry, `b` computes `y = z` from `c` | 4 | 13 |
| `reexport_in_cycle` | dep imports `g` from mid, mid is `export { g } from "./entry"` | 4 | 13 |
| `typeof_tdz` | `y = typeof g === "number" ? 13 : 12` (`typeof` of an uninitialized binding throws) | 4 | 13 |
| `ns_cycle_read` (guard) | `import * as e from "./entry"; y = e.g + 13` | 4 | 4 |
| `acyclic_guard` (guard) | dep → leaf, no cycle; `y = g + 13` | 14 | 14 |
| `after_init_ok` (guard) | dep's `get()` reads `g` after both modules ran | 14 | 14 |

**101 vs 131.** Both numbers are correct, for different programs. The #7620 draft's probe used `r() + 10` (101). Its
text described the row next to a `g + 13` row, and the reviewer built `r() + 13` (131). Node gives 41 for both. Both
rows are now pinned.

**`ns_cycle_read` already passes.** The namespace getter's TDZ check (`module-namespace-value.ts:443`) fires because
the self-import rule keeps the flag. It stays as a guard row; the #7620 draft's claim that C fixes it is withdrawn.

### Cause

Three parts. A throwaway experiment at `ada18e6bb6` needed all three: part 2 alone changed nothing, parts 1 + 2 fixed
the direct read, and the function-read row also needed part 3.

1. **The exporter drops its flag.**
   - `elidableTopLevelTdzNames` (`module-global-registration.ts:411`) calls `computeElidableTopLevelTdzNames`
     (`identifiers.ts:645`), which walks only the declaring file.
   - entry's own reads of `g` all follow its initializer, so `g` is elided.
2. **The importer never checks a flag.** `moduleTdzGlobalIndexForIdentifier` (`identifier-module-storage.ts:156`)
   refuses every import binding (`rejectsModuleTdzOwnership`, `:144`).
3. **The flag is decided too late.**
   - dep compiles first: its `r()` is compiled and inlined (`registerInlinableFunction`, `function-body.ts:172`) before
     entry's `prepareModuleTdzGlobals` (`:432`) decides `g`'s flag.
   - So `r()` baked an unchecked read.

## Implementation Plan

### Rule (review finding 10): keep every top-level lexical TDZ flag of every cycle member

A module in a non-trivial strongly connected component of the static import graph keeps the TDZ flag of every one of
its top-level lexical bindings. A component is non-trivial if it has two or more modules, or one module with a
self-edge. Elision stays as it is for every other module.

- This replaces "keep the flag of a binding another member imports", which would need the importer list. Re-export
  chains and namespace reads would make that list incomplete.
- `importsOwnNamespace` (`module-global-registration.ts:390`) is exactly the self-edge case. It is deleted and becomes
  that case of the same test.

### How the import graph is found (review finding 9)

- `ctx.importBindingTargets` is a `WeakMap` and cannot be enumerated, so C does not use it to find importers.
- The edges come from each source's `ImportDeclaration` and `ExportDeclaration … from` statements, with the module
  specifier resolved by `ctx.oracle.declarationsOf(moduleSpecifier).find(ts.isSourceFile)`.
- That resolution is already written once, in `registerImportBindingAliases` (`index.ts:9428`). It is extracted into
  one helper, `importedSourceOf(ctx, moduleSpecifier)`, in a small new module next to `module-binding-table.ts`
  (for example `src/codegen/module-import-graph.ts`). `registerImportBindingAliases` calls the helper: one copy,
  not two.
- The new `moduleImportComponentOf(ctx, sourceFile)` in that module walks the edges from `sourceFile` with
  `condenseDirectedGraph` (`analysis/strongly-connected-components.ts:25`). It is memoized per `CodegenContext` and
  answers the member set of `sourceFile`'s component.
- The edge set is the same one `resolveAllImports` (`src/resolve.ts:738`) walks, so the component matches evaluation
  order.
- `index.ts` shrinks: the extracted lines leave `registerImportBindingAliases`.

### Changes

1. **Exporter** (`elidableTopLevelTdzNames`, `module-global-registration.ts:411`). When `sourceFile` is in a
   non-trivial component, return the empty set.
2. **Importer** (`moduleTdzGlobalIndexForIdentifier`, `identifier-module-storage.ts:156`).
   - For an `ImportSpecifier`/`ImportClause`, resolve the exporter's declaration with
     `ctx.importBindingTargets.get(binding)`. That is a lookup, not an enumeration, and the alias chain covers
     re-exports.
   - Answer `absoluteGlobalIdx(ctx, moduleBindingOf(ctx, declaration).tdz)`.
   - `analyzeTdzAccess` (`identifiers.ts:371`) must answer "check" when access and declaration are in different files.
     Its closure arm (`:398-402`) compares positions across files, which made `arrow_cross` "skip". This is a condition
     on the existing line; `identifiers.ts` must not grow.
   - **Waits for #7558:** `moduleBindingOf(…).tdz` exists only there.
3. **Ordering** (`prepareModuleTdzGlobals`, `:432`). At the first call for any member of a non-trivial component,
   decide and allocate the flags of every member, through `registerModuleTdzGlobal(ctx, member, name, declaration)`,
   memoized per component.
   - This extends the rule `prepareCollidingModuleTdz` (`:447`) already states ("every binding is decided at the
     first call"). It is not a second mechanism.
   - Because the decision happens inside `prepareModuleTdzGlobals`, `generateMultiModule` is not edited.

### Interaction with the per-file `ctx.tdzLetConstNames` deletion

- `prepareModuleTdzGlobals(ctx, sourceFile)` deletes, from the graph-wide name set `ctx.tdzLetConstNames`, each name
  that `elidableTopLevelTdzNames` reports for `sourceFile` and that is not colliding (`:433-435`).
- For a cycle member that set is now empty, so a member never deletes a name.
- A non-member can delete only names that are not colliding, which means names with exactly one binding, which is its
  own. So a non-member's elision can never remove a member's name.
- A colliding name goes through `prepareCollidingModuleTdz`, which calls `elidableTopLevelTdzNames(ctx, binding.source,
  …)` per binding. A member's binding gets the empty set there too, and so keeps its flag.
- The component-wide allocation in step 3 runs before the first member's loop over `ctx.tdzLetConstNames`. Its
  registration is idempotent: `registerModuleTdzGlobal` reuses an existing flag.
- Net: the deletion and the cycle rule cannot disagree, and the result does not depend on module order.

### Pipeline

Both. The Prepared path's `materializePreparedStorageTdz` (`multi-prepared-module-init-batch.ts:223`) calls
`prepareModuleTdzGlobals`, so it gets the same decision. Its `missing-or-unproven-tdz` observation (`:175-188`) then
finds the retained flags. Only the legacy reader gets part 2: the IR does not claim these units yet.

## Expected byte diffs

Only programs with a non-trivial import component change. In those, each member's previously elided top-level
lexical bindings gain:

- one `__tdz_<name>` `i32` global;
- the `i32.const 1; global.set` write at the binding's initialization in `__module_init`;
- a flag check at each read that is not proven safe.

| corpus | expected |
| --- | --- |
| #7470 single-file sample (389 files) | identical. One source has no edges; self-importing modules already keep every flag |
| `tests/issue-7470-same-named-module-bindings.test.ts` graphs (31) | identical: none has a cycle |
| `tests/equivalence/` | identical unless a test compiles a cyclic graph. The PR lists any |
| test262 `language/module-code` cycles | changed: `instn-iee-iee-cycle.js`, `instn-iee-star-cycle.js`, `instn-named-iee-cycle.js`, `instn-named-star-cycle.js`, `instn-star-iee-cycle.js`, `instn-star-iee-multi-cycle-same-name.js`, `instn-star-iee-single-cycle-same-name.js`, `instn-star-star-cycle.js`, `instn-star-props-circular.js`, `instn-iee-err-circular*.js` (if they compile) |
| lodash-es (`tests/dogfood/lodash-upstream-suite.mjs`) | changed only if its graph has a cycle. Not measured; the PR reports it |

Compile time: one SCC walk per `compileMulti`, O(modules + edges), memoized. Single-file compiles do one trivial walk.

## Acceptance criteria

- **Pin test (red → green).** A new `tests/issue-7626-cyclic-import-tdz.test.ts` holds every row of the table, ×
  standalone/gc × `experimentalIR` on/off, compared with node.
  - It is red on `ada18e6bb6` for the non-guard rows, and green after.
  - The guard rows stay green throughout.
- **Code quality.**
  - One cycle rule, inside `elidableTopLevelTdzNames`/`prepareModuleTdzGlobals`, extending `prepareCollidingModuleTdz`'s
    first-call rule.
  - `importsOwnNamespace` is folded into it.
  - One module-specifier resolver, shared with `registerImportBindingAliases`, not a copy.
  - No edits to `source-binding-projection.ts` or `module-binding-table.ts`; `moduleBindingOf` is read-only.
  - `identifiers.ts` and `index.ts` do not grow.
  - The budget gates pass with `LOC_GATE_BASE` set to the upstream main tip.
  - An adversarial review verdict goes in the PR body.
- **Bytes.** The expected-diff table above holds on gc and standalone. Any other changed program is a finding.
- **No test262 regression.** Scoped per-test diff over `language/module-code|language/import|language/export`, on
  standalone and with `TEST262_COMPILER_PATH=ir` where available: no pass → fail. The cycle files above are reported
  before and after.
