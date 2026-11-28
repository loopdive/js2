---
id: 7620
title: "Module semantics gaps: `export * as ns`, a block `let` shadowing an outer binding, cyclic-import TDZ"
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
related: [7470, 7558]
---

# #7620 — module semantics gaps: `export * as ns`, block shadowing, cyclic-import TDZ

## Problem

RV-PR7558, the review of PR #7558 (#7470), found three wrong answers in multi-file `compileMulti` graphs. None of
them is caused by #7558: every one reproduces identically on main. The lead later added three namespace cases (N0,
N(a), N(b)) next to gap 1.

**Measured on 2026-11-28 with node v22.23.5.** Bases: `ada18e6bb6` (head of PR #7558, branch
`claude/7470-module-bindings`) and `01c9284f78` (origin/main). The probes are `.tmp/p7620/{cases*.mjs,ours.mts,node.mjs}`
in the c8-7620 worktree; they run `compileMulti(files, "entry.ts", { target, experimentalIR })` and call `main()`.
Unless a row says otherwise, the four configurations agree: standalone and gc, each with IR on and with IR off. The
two bases also agree on every row.

### Gap 1: a named import of a module namespace reads as `null`

```ts
// entry.ts
import { ns } from "./mid"; export function main(): number { return ns.g * 10 + 3; }
// mid.ts
export * as ns from "./dep";
// dep.ts
export let g = 7;
```

| row | node | ours, both bases |
| --- | --- | --- |
| `export * as ns`, read `ns.g` | 73 | throws `WebAssembly.Exception` (TypeError on a null receiver) |
| the same, `ns.bump()` then `ns.g` (`bump` sets `g = 2`) | 23 | throws |
| the same, dep exports `const g` only | 73 | throws |
| the same, dep exports `function f` only, `ns.f()` | 73 | throws |
| `import * as ns from "./dep"; export { ns }` in mid | 73 | throws |
| `import * as m from "./mid"; m.ns.g` (nested, #6651 N3) | 73 | 73 |
| `typeof ns === "object"` | 1 | 1 |
| identity: `import * as d` and `m.ns` of the same module | 1 | 0 |
| identity: two files each `import * as` the same module | 1 | 0 |

In the WAT, `main` loads `ref.null extern` for `ns` (`.tmp/p7620/gap1.wat`).

### Namespace members N0, N(a), N(b)

dep is `export function f(): number { return 3; } export function swap(): void { f = function () { return 4; }; }`.

| row | entry | node | IR on | IR off |
| --- | --- | --- | --- | --- |
| N0: no collision | `import * as d; d.swap(); return d.f();` | 4 | 3 | throws |
| N(b): entry declares its own `f` (returns 1) | `d.swap(); return f() * 10 + d.f();` | 14 | 43 | throws |
| N(a): a third file `c` declares its own `f`, entry calls `c.h()` (returns c's `f()`) | `d.swap(); return h() * 10 + d.f();` | 14 | 43 | throws |
| N0 through a value: `const k = d.f; k()` | | 4 | throws | throws |
| N0 by name: `import { f, swap }` | | 4 | 4 | 4 |
| no reassignment: `swap` writes a `let k` that `f` returns | | 4 | 4 | throws |

The coordinator's reports name these rows differently: one calls the third-file row N(a), the other calls the
entry-declares-`f` row N(b). Both give 14 in node and 43 with IR on, so both are measured above. Their "4" digit (the
other module's own `f` returns 4) is #7530's shared `__mod_f` live global. Their "3" digit (`d.f()` stale) belongs
to this issue.

### Gap 2: a read before a block that declares the same name gets the block's slot

Gap 2 is not specific to modules or imports: a single-file `compile` fails too.

```ts
// entry.ts
import { g } from "./dep";
export function main(): number { const o = g; let r = 0; { let g = 5; r = g; } return o * 10 + r; }
// dep.ts
export let g = 2;
```

| row | node | ours, both bases |
| --- | --- | --- |
| imported `let g`, read before the block | 25 | 5 |
| imported `const g` | 25 | 5 |
| single file, module `let g` / `var g` | 25 | 5 |
| single file, module `const g` (inlined) | 25 | 25 |
| outer binding is a function-level `let` or a parameter | 25 | 25 |
| outer read only after the block (#6994 fixed that half) | 25 | 25 |
| the same pattern in a class method | 25 | 5 |
| arrow function, closure over the block's `g`, two sibling blocks, a loop body | 25 | throws / 5 / 21 |
| a function declaration in the block captures its `g` | 25 | throws |
| `try { r = g } catch { r = 5 }` before the block's `let g` | 25 | throws |
| a write `g = 3` before the block | 35 | 25 |

The rows that throw are TDZ throws: the early read hits the block slot's TDZ flag.

### Gap 3: a read of a cyclic import before its `let` runs does not throw

```ts
// entry.ts
import { y } from "./dep"; export let g = 1; export function main(): number { return y; }
// dep.ts (evaluates first)
import { g } from "./entry"; export let y = 0; try { y = g + 13; } catch (e) { y = 4; }
```

| row | node | ours, both bases |
| --- | --- | --- |
| direct read `g + 13` | 4 | 13 |
| `export const g` | 4 | 13 |
| read through a hoisted `function r() { return g; }`, `y * 10 + g` | 41 | 101 |
| read through an arrow `const f = () => g` | 4 | 13 |
| `export class C { static v }`, `C.v + 13` | 4 | 13 |
| module evaluation order (dep before entry) | 1, 2 | 1, 2 (correct) |

The modules run in the right order. The read is just never checked.

### Related findings, out of scope (to be filed; no ids allocated here)

- **R1, IR-off namespace calls throw** (S7's report). The rows "IR off throws" above all have the same cause.
  - `generateMultiModule` (`src/codegen/index.ts:9767`, condition at 9769-9777) builds the IR planning identity
    context only when `experimentalIR || trackIrOutcomes`. `generateModule` does the same at 5435.
  - Four exact callable lookups need that context: `exactImportedTopLevelFunction` (`identifiers.ts:858`),
    `moduleSymbolNamespaceExports`' function arm (`module-namespace-value.ts:498-509`),
    `currentNamespaceFunctionHandle` (`module-namespace-value.ts:756`) and `tryRuntimeNamespaceMemberCall`
    (`calls.ts:2800`).
  - Measured: `nsImport_bump` with IR off throws, but returns 23 once `trackIrOutcomes: true` is added. A
    diagnostic flag changes the program's answer.
  - Not gap 1's cause: the gap-1 experiment below fixes `ns.g` with IR off, and leaves `ns.f()` throwing with IR
    off until R1 is fixed.
- **R2, IR-on compile error.** `import * as d; return d.f() + 1;`, where dep exports only `f`, fails with
  `callable preflight found a non-exact graph edge` (`multi-prepared-callable-orchestration.ts:580`). It compiles
  once dep also exports a `let`, or once the call's value is unused.
- **R3, a block `class g {}` shadowing a module `let g`.** Single file. IR on gives the compile error `module-init:
  supported binding 'g' has no exact allocator-owned module global`; IR off gives NaN; node gives 25. This may be
  gap 2's family through the class path. The gap-2 PR checks it and either fixes it or files it.

## Implementation Plan

All three gaps are in the **legacy codegen**. In every graph above the IR refuses the units at select
(`body-shape-rejected`), and multi-source `<module-init>` stops at `late-preparation-unsupported` (#7470 notes). An
IR-on row shows only the experimentalIR setup's effect on legacy (R1). The gap-3 elision decision is consumed by the
Prepared path as well (`materializePreparedStorageTdz`, `multi-prepared-module-init-batch.ts:223`, calls
`prepareModuleTdzGlobals`). Each fix is therefore one decision that both pipelines ask. No IR-only arm is added.
No slice edits `source-binding-projection.ts` or `module-binding-table.ts`: slices only read
`moduleBindingOf(…).tdz` and the #7530 live-binding records.

Line numbers below are at `ada18e6bb6`.

### Slice A: gap 1, namespace values behind an import binding (`module-namespace-value.ts`)

**Cause.** `tryEmitCompiledModuleNamespaceObject` (`module-namespace-value.ts:1359`) admits only a
`ts.NamespaceImport` declaration. For `import { ns }`, the declaration is an `ImportSpecifier` whose aliased value
declaration is dep's `SourceFile`. So the function declines, and `compileIdentifierCore` (`identifiers.ts:1393`)
falls through to the null fallback. The nested-namespace arm (`:420`, `moduleSourceFile(target)`) already handles
this alias shape inside an outer namespace object, which is why `m.ns.g` works.

**Change.**

- `tryEmitCompiledModuleNamespaceObject`: resolve `ctx.oracle.aliasedValueDeclarationOf(identifier)`. When that
  declaration is a `SourceFile`, emit through `tryEmitModuleNamespaceObjectForSource` (`:1376`). That function keys
  the getter by the module symbol, as the N3 arm and dynamic `import()` already do. A `NamespaceImport` takes the same
  route. The function then has one path, and the `namespaceFunctionExports` wrapper (`:335`) becomes dead and is
  deleted. Its #5330 Node-builtin decline moves into the shared entry.
- **Identity.** Keying every namespace getter by the module symbol makes `d === m.ns` and two files' `import * as`
  the same object (identity rows: 0 → 1). Today a `NamespaceImport` is keyed by its declaration (`:1367`).
- **Experiment.** A throwaway patch to `tryEmitCompiledModuleNamespaceObject` alone, on main, made rows 1, 2 (IR on),
  3, 4 (IR on) and 5 answer like node. `ns.f()` and `ns.bump()` with IR off still throw (R1).
- **Reuse.** `moduleSourceFile`, `moduleSymbolNamespaceExports`, `ensureNamespaceObjectGetter` and the
  `aliasedValueDeclarationOf` test that `importsOwnNamespace` (`module-global-registration.ts:390`) already uses.
- **Duplication removed.** The alias-following check is written four times: `namespaceFunctionExports`,
  `canonicalRuntimeNamespaceSymbol` (`:565`), `isRuntimeNamespaceReceiver` (`calls.ts:2750`) and
  `runtimeNamespaceFunctionValueReceiver` (`property-access.ts:3424`). Fold the module-namespace half into one
  exported `moduleNamespaceSourceOf(ctx, identifier): ts.SourceFile | undefined` next to `moduleSourceFile`.
  `isRuntimeNamespaceReceiver` and `runtimeNamespaceFunctionValueReceiver` call it, so that `ns.f()` behind
  `export * as` takes the static member-call path, like an `import * as` receiver. The TypeScript `namespace`
  (`ModuleDeclaration`) half stays where it is.
- **Pipeline.** Legacy only.
- **#7558 dependency.** None semantically. The file is one #7558 rewrites (the export-kind hunks at 233-480); these
  edits are at 335 and 1359. Base the PR on #7558's head, or on main after #7558 lands, to avoid a conflict.
- **Size.** The file is at 1,431 lines against the 1,500 threshold. If the slice needs more than about 60 net lines,
  move the import-binding entry points (`tryEmitCompiledModuleNamespaceObject`, `moduleNamespaceSourceOf`) into a
  sibling module. Do not grant the growth.

### Slice A2: N0 / N(a) / N(b), a reassigned function export read through a namespace (depends on #7530)

**Cause.**

1. `tryRuntimeNamespaceMemberCall` (`calls.ts:2800`) lowers `d.f()` to a direct call of `f`'s declaration. It never
   asks `ctx.reassignedFunctionDeclarations`, so after `swap()` it still calls the original body (3).
   `exactImportedTopLevelFunction` (`identifiers.ts:878`) has exactly that check for the named-import path, which is
   why N0 by name answers 4.
2. `moduleSymbolNamespaceExports` (`module-namespace-value.ts:486-497`) declines the whole namespace object when an
   export is a reassigned function. So `const k = d.f` throws, and so would the dynamic fallback for (1).

**Change.**

- `tryRuntimeNamespaceMemberCall` declines for a declaration in `reassignedFunctionDeclarations`. Share that test
  with `exactImportedTopLevelFunction` as one predicate, `isImmutableTopLevelFunction(ctx, declaration)`, next to
  `exactImportedTopLevelFunction`. The call then compiles as a dynamic call on the namespace object.
- `moduleSymbolNamespaceExports` gets a `live` arm for a reassigned function. It reads the function's live binding
  record from #7470's table, `moduleBindingOf(ctx, declaration)`, through #7530's API (`liveFunctionBindings` /
  `markLiveFunctionBinding` records). The arm has the same shape as the `var`/`let` arm at `:468`. The getter reads
  the record's `GlobalDef` directly (`NamedGlobalRead`, `rebaseNamespaceGlobalReads`), so it does not depend on the
  name state that `withDirectRuntimeModuleBindings` sets.

**Depends on #7530 landing.** Before #7530 the live global is name-keyed (`ctx.liveFuncBindingGlobals`). Using it here
would reintroduce the bare-name keying #7470 removed, and N(a)/N(b) would still read 4 from the shared `__mod_f`.

**Coordination point with #7530.** The slice does not edit `setModuleNameState`, `withDirectRuntimeModuleBindings`
or any #7530 region. S7's note applies: while a namespace body compiles, `withDirectRuntimeModuleBindings` also hides
liveness. The namespace getter therefore must not resolve the export by name. If the slice finds it needs that
interaction changed, raise it with #7530 first.

**Expected after A2 + #7530.** N0 4, N(a)/N(b) 14, `k()` 4, on IR on. Rows with IR off still need R1.

### Slice B: gap 2, block-scoped slots are visible before block entry (`index.ts`, `statements/shared.ts`, `nested-declarations.ts`)

**Cause.**

- `hoistLetConstWithTdz` (`index.ts:13407`) pass 2 (`walkStmtForLetConst`, `:13809`) claims a function-level
  `localMap` slot for a nested block's `let`/`const` whenever no local holds the name. A module global, an import,
  or a binding of an enclosing function is not in `localMap`, so the claim wins.
- From function entry, every read or write of that name resolves to the block's slot. That includes reads and writes
  before the block, which should see the outer binding.
- #6994 fixed the after-block half: `blockOwnPreHoistedNames` (`statements/shared.ts:200`) keeps block exit from
  reinstalling the slot. The before-block half is this gap.

**Change.** Hide a nested-block slot from function entry until its block is entered, and only when the function
also refers to an outer binding of that name. Programs without that shadow keep their exact locals.

1. New `hideOuterShadowedBlockSlots(ctx, fctx, stmts)` in `statements/shared.ts`, next to `blockOwnPreHoistedNames`,
   called as the last step of `hoistLetConstWithTdz`.
   - Take every `fctx.preHoistedLetConstSlots` record whose declaration is not one of the body's direct statements,
     and whose name currently maps to that record's `valueSlot`.
   - Hide it when the body contains an identifier of that name whose `ctx.oracle.valueDeclarationOf` lies outside
     the function-like node. Parameters count as inside.
   - "Hide" removes the `localMap` and `tdzFlagLocals` entries and records `{name, slot, flag}` in a
     declaration-keyed `fctx.dormantBlockSlots`. The pre-hoist record stays.
2. `hoistFunctionDeclarations` (`nested-declarations.ts:3153`). When it recurses into a block (a non-top-level call,
   `_eagerBoxFuncNames !== undefined`), it re-exposes the dormant slots of that block's own direct declarations for
   the duration of the call, then hides them again.
   - This is what lets a block's function declaration pin its capture to the block slot (the `k1` row).
   - It is the same rule the #5271 F1 `reinstallPreHoistedCapturedSlots` applies at block entry.
3. Block entry needs no change. `preallocateBlockScopedSlots` (`index.ts:13472`) reinstalls the record slot for a
   captured name (`reinstallPreHoistedCapturedSlots`, `:13519`). Otherwise it allocates a fresh block slot, as for any
   shadow.

**Experiment.** A throwaway patch at `ada18e6bb6` that implements 1 and 2 made every gap-2 row above answer like node,
on gc and standalone with IR on and off. That includes the function declaration, closure, TDZ, write, loop and
class-method rows. With the patch, `tests/issue-1177`, `-2641`, `-5221-*`, `-5271-es2015-statements-r2` and `-5356-*`
gave 112 of 113 passing, the same as the base. The one failure (`#5271 F2 … folded constant is still in the
module`) also fails on `ada18e6bb6` without the patch.

- An earlier variant reserved the names in pass 2 instead (the #6994 `reserved` set). It broke the `k1` row
  (22 instead of 25). Hiding after the claim is what keeps the slot the hoisted function pins.
- A variant that hid the slots only after `hoistFunctionDeclarations` missed class methods (`class-bodies.ts:3374`
  hoists no functions), and its first cut also hid parameters.

**Reuse.** `preHoistedLetConstSlots`, `reinstallPreHoistedCapturedSlots`, `preallocateBlockScopedSlots` and the
#6994 helper's module. **Leave it better:** move the #6994 `reserved` computation (`index.ts:13444-13447`) into the
same `shared.ts` helper family. `index.ts` (14,299 lines, over the 1,500 threshold) then shrinks while gaining the
one call.

- `nested-declarations.ts` (4,476 lines) grows by the expose-and-restore wrapper. Either offset it by extracting
  existing code in the same PR, or carry a dated `loc-budget-allow:` grant that the review must accept.
- **Pipeline.** Legacy only. The IR refuses these bodies (`body-shape-rejected`). The pin rows run with IR on too, so
  a future IR claim of block shadows is held to the same answers.
- **#7558 dependency.** None. #7558 does not touch these functions. This slice can land first, from main.

### Slice C: gap 3, cyclic-import TDZ (`module-global-registration.ts`, `identifier-module-storage.ts`; waits for #7558)

A throwaway experiment at `ada18e6bb6` needed all three parts below. Part 2 alone changed nothing (13). Parts 1 and
2 fixed the direct read (13 → 4) and the `const` row. The function-read row (101 → 41) also needed part 3, which the
experiment approximated with a bare-name `tdzGlobals` fallback; the plan does it by declaration.

1. **The exporter keeps its flag** (`elidableTopLevelTdzNames`, `module-global-registration.ts:411`).
   - `computeElidableTopLevelTdzNames` (`identifiers.ts:645`) walks only the declaring file, so a read in an
     importer is invisible to it, and entry's `g` is elided.
   - Do not elide a binding that another module of the same import cycle imports. Build the cycle with
     `condenseDirectedGraph` (`analysis/strongly-connected-components.ts:25`) over static
     `import`/`export … from` edges, resolved by `ctx.oracle.declarationsOf(moduleSpecifier)` (the
     `registerImportBindingAliases` pattern, `index.ts:9428`).
   - Read the importers from `ctx.importBindingTargets` (filled by `registerImportBindingAliases`, `index.ts:9457`,
     before any body compiles).
   - Only an importer in the same strongly connected component can evaluate before the exporter, so acyclic graphs
     keep today's elision and bytes.
2. **The importer checks the exporter's flag** (`moduleTdzGlobalIndexForIdentifier`,
   `identifier-module-storage.ts:156`).
   - `rejectsModuleTdzOwnership` (`:144`) refuses every import binding. For an `ImportSpecifier`/`ImportClause`,
     resolve `ctx.importBindingTargets.get(binding)` to the exporter's declaration and answer
     `absoluteGlobalIdx(ctx, moduleBindingOf(ctx, declaration).tdz)`.
   - That per-declaration flag exists only on #7558 (`module-binding-table.ts`), so this part waits for #7558. On
     main the only flag map is bare-name `ctx.tdzGlobals`, which is wrong for a colliding name.
   - `analyzeTdzAccess` (`identifiers.ts:371`) compares source positions across files in its closure arm (`:398-402`),
     which makes the arrow row "skip". It must answer "check" when the access and the declaration are in different
     files.
   - `identifiers.ts` is over the threshold, so make this a condition on the existing line. Net growth must be zero.
3. **The flag exists before the first importer compiles** (`prepareModuleTdzGlobals`, `:432`).
   - dep's `r()` compiles, and is then inlined (`registerInlinableFunction`, `function-body.ts:172`), before entry's
     `prepareModuleTdzGlobals` runs. So `r()` baked an unchecked read.
   - At the first `prepareModuleTdzGlobals` call for any member of a cycle, decide and allocate the flags of the
     whole cycle's cross-imported bindings (`registerModuleTdzGlobal`, `:336`, with the exact declaration).
   - This is the rule `prepareCollidingModuleTdz` (`:447`) already applies to colliding names: "every binding is
     decided at the first call, so a module compiled before the one it imports from still finds the flag". Extend
     that mechanism. Do not add a second one.
   - Doing it inside `prepareModuleTdzGlobals` means no edit to `generateMultiModule` (`index.ts`, which #7558
     rewrites around `:10154`).

- **Reuse.** `moduleBindingOf`, `registerModuleTdzGlobal`, `prepareCollidingModuleTdz`'s first-call rule,
  `condenseDirectedGraph`, `importBindingTargets`, `emitTdzCheckAtGlobal` via the unchanged
  `emitModuleTdzReadCheck`.
- **Duplication removed.** `importsOwnNamespace` (`:390`) is the self-cycle special case of "a module in my
  component can observe my bindings early". Express it as that case of the same cycle test.
- **Pipeline.** Both. The Prepared path calls `prepareModuleTdzGlobals` (`multi-prepared-module-init-batch.ts:229`),
  so it consumes the same elision decision. The legacy reader gets part 2.
- **Namespace reads of cyclic bindings** (`ns.g` before init) already use TDZ-checked live getters when the flag
  exists (`module-namespace-value.ts:443`). Part 1 makes the flag exist for a cross-cycle namespace import too. Add a
  pin row.

### Order of the slices

1. **B** (gap 2). Independent; can land from main now.
2. **A** (gap 1 and namespace identity). Base it on #7558's head, or land it after #7558, because the two touch the
   same file.
3. **C** (gap 3), after #7558 merges.
4. **A2** (N0 / N(a) / N(b)), after #7530 merges.

R1 (IR-off identity context) is its own issue. A's and A2's IR-off pin rows stay red until R1 lands, and each pin
says so in a comment.

### #7530 overlap (S7's regions, commit `a22972b089`)

| #7620 slice | files and functions it edits | overlap with #7530 |
| --- | --- | --- |
| A | `module-namespace-value.ts`: `tryEmitCompiledModuleNamespaceObject`, `namespaceFunctionExports` (deleted), new `moduleNamespaceSourceOf`; `calls.ts`: `isRuntimeNamespaceReceiver`; `property-access.ts`: `runtimeNamespaceFunctionValueReceiver` | none (#7530 states it does not touch `module-namespace-value.ts`) |
| A2 | `calls.ts`: `tryRuntimeNamespaceMemberCall`; `identifiers.ts`: `exactImportedTopLevelFunction` (shared predicate); `module-namespace-value.ts`: `moduleSymbolNamespaceExports` | **consumes** #7530's `markLiveFunctionBinding` / `liveFunctionBindings` and `moduleBindingOf` (read-only). Coordination point: `withDirectRuntimeModuleBindings` hides liveness while namespace bodies compile |
| B | `index.ts`: `hoistLetConstWithTdz`; `statements/shared.ts`: new `hideOuterShadowedBlockSlots`; `statements/nested-declarations.ts`: `hoistFunctionDeclarations`; `context/types.ts`: `FunctionContext.dormantBlockSlots` | none (`index.ts`, but not `registerReassignedFunctionGlobals`) |
| C | `module-global-registration.ts`: `elidableTopLevelTdzNames`, `prepareModuleTdzGlobals`, `prepareCollidingModuleTdz`, `importsOwnNamespace`; `identifier-module-storage.ts`: `moduleTdzGlobalIndexForIdentifier`, `rejectsModuleTdzOwnership`; `identifiers.ts`: `analyzeTdzAccess` | **same file**, other functions: #7530 edits `registerModuleGlobal`'s tail and adds `registerLiveFunctionGlobal` in `module-global-registration.ts`. A textual merge only, no shared function |

### Risks

- **B changes local layout.** Only functions with a hidden slot change: the dead pre-hoist slot stays declared, and
  the block gets its own slot.
  - #5221/#6994 ordering, #5271 captured-slot reinstall and #5356 eager capture boxes depend on these slots.
    `tests/issue-1177`, `-2641`, `-5221-*`, `-5271-es2015-statements-r2` and `-5356-*` must stay green.
  - Direct-eval bodies (`reifyCurrentDirectEvalBindings`) see `localMap` after the hoist: a hidden name must stay
    invisible to eval until its block is entered. Add an eval row.
- **C's cycle test costs a graph walk.** It is per `compileMulti`, memoized per context, not per file. Single-file
  compiles have no import edges, so the walk is trivial and their bytes cannot change.
- **A's identity change** reorders nothing, but a namespace that two files used to build twice is now built once. The
  bytes of multi-file graphs with repeated `import * as` change. That is intended, and the byte gate below excludes
  those graphs by name.
- **Prepared path.** If C's extra flags reach a `<module-init>` that the Prepared path claims, its
  `missing-or-unproven-tdz` observation (`multi-prepared-module-init-batch.ts:175-188`) must find them. The flags
  are allocated by the same helper, so this should hold. Pin it with `TEST262_COMPILER_PATH=ir` on the scoped
  test262 run.

## Acceptance criteria

- **Pin tests.** New `tests/issue-7620-module-semantics-gaps.test.ts`, on the harness of
  `tests/issue-7470-same-named-module-bindings.test.ts` (`compileMulti`, `buildImports`, `main()`).
  - It holds every row of the tables above with node's answer, × gc/standalone × `experimentalIR` on/off.
  - Each slice turns its rows from red on its base to green.
  - Rows blocked on R1 (IR off with a namespace function call) are listed with a comment naming R1, not skipped
    silently.
  - Extra rows: gap 2 under direct eval; gap 3 through `import * as` (`ns.g` before init).
- **gc output byte-identical** for programs without these constructs. Base vs new, both gc and standalone, IR on and
  off. Programs whose namespace identity A changes on purpose are listed by name as the expected diffs. Corpus:
  - the #7470 single-file corpus: `.tmp/hash.mts` + `.tmp/sample3.txt` in the `claude/7470-module-bindings` worktree,
    389 test262 files: the 240-file sample plus 149 module-goal files from `language/module-code`,
    `language/export` and `language/import`;
  - the #7470 multi-file graphs (`.tmp/mhash.mts`);
  - the 31 graphs of `tests/issue-7470-same-named-module-bindings.test.ts`;
  - `website/playground/examples/`.
- **Code quality.**
  - No duplicated predicate or helper. The namespace alias check exists once (`moduleNamespaceSourceOf`), the
    immutable-function test once, and the cycle TDZ rule extends `prepareCollidingModuleTdz`'s mechanism, not a
    parallel one.
  - Each fix sits next to its siblings: namespace arms in `module-namespace-value.ts`, block-scope helpers beside
    `blockOwnPreHoistedNames`, TDZ decisions in `module-global-registration.ts`.
  - No defensive branches for impossible cases. No edits to `source-binding-projection.ts` or
    `module-binding-table.ts`.
  - `check-loc-budget` and `check-func-budget` pass, including with `LOC_GATE_BASE` set to the upstream main tip.
    `index.ts` and `identifiers.ts` do not grow. Any grant for `nested-declarations.ts` is restated in this file,
    with a date.
  - An adversarial review agent's verdict goes in each PR body.
- **No test262 regression.** Scoped per-test diff over `language/module-code|language/import|language/export` (731
  verdicts, as in #7470) on standalone and with `TEST262_COMPILER_PATH=ir`: no pass → fail.
  - The eight `export * as` files (`language/module-code/export-star-as-dflt.js`, `eval-rqstd-once.js`, the three
    `ambiguous-export-bindings/namespace-unambiguous-*` files, …) are reported before and after. Their yield is not
    measured yet.
  - The full merge-queue run must keep the completed ES5 edition at its floor.
- **Related suites green.** `tests/issue-7470-*`, `tests/issue-6651-*`, `tests/issue-1177`, `tests/issue-2641`,
  `tests/issue-5221-*`, `tests/issue-5271-*`, `tests/issue-5356-*` and `node scripts/equivalence-gate.mjs`.
