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
Revision 2 (same day) follows the plan review's blocker: allocation keyed by declaration, one projection.

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
| TDZ, both files: a hoisted function reads its own `g` before `let g` runs (`.tmp/tdz.mts`) | -89 | 201 |
| TDZ in dep only, entry's `g` initialised | 17 | 16 |

The `reg.mts` row passes on HEAD only because the shared global happens to hold the right value; it is the row the
3-step prototype broke, and it goes into the pin test.


### Review points, checked against the code

| # | review point | verdict |
| --- | --- | --- |
| 1 | Allocation keyed by declaration; `registerModuleGlobal` (`module-global-registration.ts:237-245`) is the name-keyed culprit; `ProgramAbiGlobalRegistry.moduleBindings` already maps declaration → `{value, tdz}` | Agree. The registry exists whenever `experimentalIR` or `trackIrOutcomes` is set (`index.ts:9876-9888`), and `compileMulti` defaults `experimentalIR` on (`compiler.ts:933`), so today its map is the declaration table in the default lane only. Legacy readers already ask it (`identifier-module-storage.ts:217/238`, `identifiers.ts:903`, `property-access.ts:3547`). |
| 1 | Delete the #1282 `hasModuleValue` workaround (`program-abi-global-planning.ts:62-77`, `module-global-registration.ts:296/312`) | Agree. It exists only because a TDZ flag found by name could belong to another file's value global; a per-declaration TDZ cannot. |
| 1 | Keying: a declaration is not a binding | Refinement, not disagreement. `var g; var g;` in one file, and a script `var` merged with a lib `declare var`, are several declarations of ONE binding. The table key is the binding's canonical declaration: the first non-ambient entry of `ctx.oracle.declarationsOf(decl.name)` (oracle, not raw checker). |
| 2 | One projection with `ownFuncIdxBySource` / `funcBindingsBySource` / `rebindPerSourceGeneratorState` (`index.ts:10214-10345`) | Agree, and it fixes a latent #4133 gap: `__module_init` statements of every file compile in one pass (`ModuleInitMode`), under whichever file's `funcMap` state was last applied. One exception, with reason: `withRuntimeModuleCallableBindings` (`runtime-module-callable-metadata.ts:110`) stays. It swaps 12 callable-metadata maps and 4 sets per TS `namespace` function, a different scope (a nested namespace block, not a file), and the per-file projection re-points only colliding names. |
| 3 | TDZ per declaration; a colliding `let g` hits the `IrInvariantError` at `integration.ts:6317` on the Prepared path | Partly disagree. The design point holds, but I could not reproduce the throw: on 50bce1ba04 every multi-source `<module-init>` unit stops earlier as `late-preparation-unsupported` at `resolve`, with or without a collision (`.tmp/tdz3.mts`), and the test262 Prepared front door (`prepared-program-required`) is single-file. The check `ctx.tdzLetConstNames.has(name) && !tdzGlobal` is name-keyed, so it would throw once multi-source module-init prepares and one file elides a flag its namesake keeps. The measured TDZ defect is a wrong answer: −89 in node, 201 today (table above). |
| 4 | Drop the overlay-loop wrap | Agree. Under `experimentalIR` the registry exists, and the 6 lookups in `integration.ts` take the `programAbiGlobals` branch by declaration; the `moduleGlobals.get` arms are the registry-less fallback. Exception: the name check above (step 6). The pin test runs every row with `experimentalIR` on and off; if a row fails only with IR on, its site gets named then. |
| 5 | Fold all three absolute-index helpers | Agree: `exactRuntimeModuleGlobalIndex` (`declarations.ts:1686`), `absoluteGlobalIndex` (`module-namespace-value.ts:750`), `globalIndex` (`object-model/global-var-binding-exotic.ts:107`) become `absoluteGlobalIdx` beside `localGlobalIdx` (`registry/imports.ts:385`). |
| 6 | Scoped test262 verdict diffs | Agree; the runner filters with `TEST262_PATH_FILTER` (`scripts/run-test262-vitest.sh:62`). |
| 7 | `registerVarDeclListGlobals` passes the declaration | Agree (`declarations.ts:3538`). Today a module's hoisted `var` registers with no declaration at all (`isHoistedScriptVar` is false in modules), which is why the old plan needed a `sourceFile` argument. |

### Mechanism

**The table.** One always-on table in `module-global-registration.ts` (a per-context `WeakMap`, like the seed and
pattern tables already there) owns module-binding allocation:

```
canonical declaration → { name, source, value: GlobalDef, tdz?: GlobalDef, tdzDecided: boolean }
any declaration       → its canonical declaration
```

- `registerModuleGlobal(ctx, name, wasmType, declaration)` looks up the canonical record. It reuses the record's
  global when one exists, and mints `__mod_<name>` when none does. Every global keeps that name, because the ABI
  checks it (`program-abi-global-planning.ts:237`, `multi-prepared-module-init-batch.ts:167`).
- The bare `ctx.moduleGlobals` entry is written only when the name has no entry yet. So the first declarer of a
  name owns it, as today, and a graph without collisions writes the same entries in the same order: same bytes.
- Calls without a declaration keep the name-keyed reuse: `__namespace_<pos>_<name>`, reassigned functions
  (`index.ts:9254`), Annex B, the runtime-eval carriers.
- `ProgramAbiGlobalRegistry` drops its own `moduleBindings` map and `observeModuleValue`/`observeModuleTdz`/
  `hasModuleValue`; `moduleBinding(declaration)` reads the table and keeps its liveness filter. The invariants
  that stay — the `__mod_`/`__tdz_` name check, no contradictory allocator objects, no registration after
  `planRetained` — move to the table's write, asked of the registry only when it exists.

**The per-file view, derived.** For a file, the names to re-point are:

- its own top-level declarations whose name has more than one record;
- its import bindings: `ctx.oracle.aliasedValueDeclarationOf` on the import specifier gives the target
  declaration, which covers named, renamed, default (`export { g as default }`) and re-export chains.

Only names whose bare entry is not the record's global go in, so a graph without collisions projects nothing.
Nothing is recorded per import; `bindImportedModuleGlobal` from revision 1 is gone.

**One projection.** New module `src/codegen/source-binding-projection.ts` owns `withSourceBindings(ctx, source,
action)`. It applies, for that file:

- the `funcMap` entries of its own colliding functions and of its function imports (today's `ownFuncIdxBySource` /
  `importFuncIdxBySource` loop);
- its native-generator state and the one-way `inlinableFunctions` eviction (today's
  `rebindPerSourceGeneratorState`);
- its derived `moduleGlobals` / `tdzGlobals` view.

All of it is restored afterwards. Saved state is held as allocator objects (`GlobalDef`, defined `Func`), never
as indices, because a late import shifts both index spaces during a body pass (`shiftLateImportIndices`). Today's
`ownFuncIdxBySource` keeps raw indices across passes, a latent hazard this removes. The restore replaces
`snapshotNativeGeneratorEndState` / `restoreNativeGeneratorEndState`: restoring after each file gives the same
end state as today's last-wins order. The globals half is `withProjectedModuleGlobals`, which
`withDirectRuntimeModuleBindings` (`declarations.ts:1759`) also uses in place of its own save/restore loop.

**TDZ per declaration.**

- `registerModuleTdzGlobal(ctx, sourceFile, name)` finds the declaration in that file
  (`findRuntimeTopLevelDeclaration`, keeping #4018's ambient skip). It mints the flag on that declaration's
  record. It is a no-op for a name the file does not declare whose name has more than one record.
- Elision is decided per record, from its own file's `computeElidableTopLevelTdzNames`, instead of by deleting
  from the graph-global `ctx.tdzLetConstNames`. Non-colliding names keep today's path, so their bytes do not
  change.
- `integration.ts:6317` asks the record (`tdzDecided` and no flag means elided) instead of
  `tdzLetConstNames.has(name)`.

### Ordered steps

1. **Index helper.** Add `absoluteGlobalIdx`; fold the three copies.
2. **Table.** Add the table to `module-global-registration.ts` and move the registry's binding map onto it.
   Delete `hasModuleValue` and its two callers. `registerVarDeclListGlobals` passes the declaration.
3. **Per-declaration TDZ** (registration, elision, `integration.ts:6317`).
4. **Projection.** Add `source-binding-projection.ts` (classified in `scripts/compiler-boundaries.json` like
   `module-global-registration.ts`: `mixed-needs-split`, `backend-wasmgc`, owner `3518-coordinator`). Move the
   four `#3505`/`#4133` helpers out of `index.ts`, wrap each file's body pass with it, and rewrite
   `withDirectRuntimeModuleBindings` onto its globals half.
5. **Module initialiser.** `compileOrderedModuleInitEntry` (`declarations.ts:5673`) wraps each statement in
   `withSourceBindings(statement's file)`.
6. **Imports, namespaces, default export by declaration.**
   - `registerImportBindingAliases` (`index.ts:9609-9610`): the flat copy takes the target record's global.
   - `module-namespace-value.ts`: entries carry the record's `GlobalDef`s, not `globalName`. This covers
     lines 250, 437, 743, 807-809 and 1250; `rebaseNamespaceGlobalReads` re-resolves through
     `absoluteGlobalIdx`.
   - The multi-source deferred `export default <var>` (`index.ts:10393`) resolves the entry's declaration.
7. **Seeds.**
   - `moduleF64UndefinedSeedGlobals` and `emitModuleVarUndefinedSeeds` iterate the table's `var`/`let` records of
     every file, in source order, instead of a bare-name lookup over one file's names.
   - `moduleVarSlotIsUndefinedSeeded` records seeded `GlobalDef`s and compares the projected global.
8. **Pin test** `tests/issue-7470-same-named-module-bindings.test.ts`: every row above × gc/standalone ×
   `experimentalIR` on/off, compared with node.

### #7530 and #7531

- **#7531** (only the last file's `var`s are seeded) falls out of step 7. Iterating table records is the change
  this plan makes anyway, and the alternative leaves a name walk beside the table. Plan: close it with this PR,
  with its own pin row.
- **#7530** (same-named reassigned functions share one live-binding global, `index.ts:9254`) does not fall out.
  It needs four more steps:
  1. the table key admits `FunctionDeclaration`;
  2. `registerReassignedFunctionGlobals` registers per entry of the `reassignedDeclarations` set it already
     computes;
  3. `ctx.liveFuncBindingGlobals` (a name set) becomes part of the projected view;
  4. the prologue's live-binding seed loop (`module-init-prologue.ts`) iterates records under each file's
     `funcMap` projection.

  The table and the projection are its foundation. Kept separate so the key widens when it has a user.

### Size

**12 files** (revision 1: 10):

- 1 new: `source-binding-projection.ts`.
- 8 edited sources:
  - `module-global-registration.ts`
  - `program-abi-global-planning.ts` (shrinks)
  - `declarations.ts`
  - `index.ts` (shrinks: the four helpers move)
  - `module-namespace-value.ts`
  - `declarations/module-var-undefined-seed.ts`
  - `registry/imports.ts`
  - `object-model/global-var-binding-exotic.ts`
- 1 IR seam: `src/ir/integration.ts`, one check.
- `scripts/compiler-boundaries.json`, the pin test, this issue.

No context-type change. Estimate: +350 / −250 lines in `src/`.

### Risks

- **More declarations in the table.** Passing the declaration for a module's hoisted and nested `var` puts more
  declarations in the table, and IR readers may treat a recorded declaration as a module binding. Checked by the
  byte comparison and by the scoped `TEST262_COMPILER_PATH=ir` diff.
- **Bodies emitted outside their file's pass** see the collect end state. Known: method trampolines (no binding
  reads) and namespace getters (step 6 makes them declaration-exact). Any other one the pin test finds is wrapped
  in `withSourceBindings(declaration's file)`.
- **Writes to a projected name during a pass are undone by the restore.** Registration happens before any
  projection. `closures.ts:1192` promotes a function-local TDZ flag into `tdzGlobals` under the local's name: a
  pin row covers a closure over a function-local `let g` in a colliding file.
- **Restore semantics for `funcMap`.** A file's pass now starts from the collect end state, not from the
  previous file's projection. That can change bytes of multi-file graphs, which is acceptable: single-file bytes
  stay gated, and the `compileMulti` tests are the check.

### Validation

- **Pin test.** Fails on 50bce1ba04 (except the `reg.mts` row) and passes after.
- **Single-file bytes.** 240 test262 files × gc/standalone (`.tmp/hash.mts`, `.tmp/sample2.txt`), base vs new,
  identical.
- **Scoped test262 verdict diffs, base vs new, per test.** `TEST262_PATH_FILTER` over `language/module-code`,
  `language/import` and `language/export`. Run on standalone (`TEST262_TARGET=standalone`), then again with
  `TEST262_COMPILER_PATH=ir`. No pass becomes non-pass.
- **`compileMulti` tests.** 283 test files call it; run the related subset locally (#4133, #3505, #2930, #6669,
  #6684, namespace, lodash). CI runs the rest.
- **lodash-es.** `scripts/generate-npm-compat-report.mjs --only lodash-es` (no write),
  `tests/lodash-es-e2e.test.ts` and `tests/issue-6985-lodash-es-o4.test.ts`, before and after.
- **Gates, unpiped.**
  - loc and func budget, also with `LOC_GATE_BASE` = `origin/main` and = the #7490 tip;
  - coercion sites, oracle ratchet, dead exports, import cycles;
  - compiler boundaries with `--base HEAD^1` and `--base origin/main`;
  - prettier on the changed files;
  - `node scripts/equivalence-gate.mjs` once at the end.

### Code-quality acceptance criterion

- **One allocation authority.** The declaration table in `module-global-registration.ts` decides module-binding
  storage. `ctx.moduleGlobals` / `ctx.tdzGlobals` are a per-file view derived from it. The registry reads the
  table and owns no second map.
- **One per-file projection** (`withSourceBindings`) for `funcMap`, generator state, `moduleGlobals` and
  `tdzGlobals`, sharing its globals primitive with the namespace projection. The only other mechanism left is
  `withRuntimeModuleCallableBindings`, kept for the reason given above.
- **One `absoluteGlobalIdx`.** No index-holding saved state.
- No budget grants, no dead parameters, no branches for states the table cannot reach.

## Acceptance criteria

- Every row above, plus the imported-binding shapes (named, renamed, namespace, a third same-named file), answers
  like node on gc and standalone, pinned with `compileMulti` tests that fail on main.
- Single-file output byte-identical (test262 is single-file; check a sample on gc and standalone).
- The test files that call `compileMulti` stay green.
- lodash-es (97 top-level names declared in more than one file, e.g. `objectProto` ×30) compiles and validates
  before and after; its npm-compat test results do not regress.
- No pass becomes non-pass in a scoped test262 run of `language/module-code`, `language/import` and
  `language/export`, on standalone and on `TEST262_COMPILER_PATH=ir`.
- Code quality: one declaration-keyed table owns module-binding storage and the bare-name maps are a per-file view
  of it; one per-file projection; no budget grants.
