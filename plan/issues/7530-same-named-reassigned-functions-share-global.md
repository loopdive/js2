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

- **Fixed rows.** A, C, D, F, G, H, X, Y2, Z and AB1 (sources below) answer like node on gc and standalone, with
  the IR path on and off. I answers like node with the IR path on.
- **Rows that must keep passing:** B, B2, B3, E, Y3, Y5 and AB2.
- **Pinned.** `tests/issue-7530-same-named-reassigned-functions.test.ts` holds every row above, and the fixed rows
  fail on main.
- **Byte identity.** The three single-file corpora and the clash-free `mhash` graphs under "Byte identity" give
  identical bytes before and after. lodash-es passes its tests and upstream suite as before.
- **Code quality.**
  - One source of liveness: `ModuleBinding.liveFunction` in the table. `ctx.liveFuncBindingGlobals` is only the
    bare-name view of it, written by the table and the projection and by nothing else.
  - One allocation helper for `__mod_` globals. No inline `__mod_` push remains in `index.ts` or
    `annexb-global-live-binding.ts`.
  - One per-file view. Liveness travels in `ModuleNameState`, with no second save and restore.
  - No name set beside the table: the `reassigned` set and `ctx.evalOnlyLiveFuncBindings` are removed.
  - No budget grants, no new module, no branch for a state the table cannot reach.

## Implementation Plan

Revision 2, against cada0d37f7 (branch `claude/7530-reassigned-functions`, stacked on PR #7558 / #7470), 2026-11-28.
It answers review PRV-7530 of revision 1 (a22972b089).

### Out of scope

- **Namespace-import reads** (`import * as d; d.f()`, rows N0 and N) belong to
  #7620 (C8, which owns
  `export * as ns`). N0 fails without any name clash, so this design cannot fix it.
- **Row I0**, an import alias named like another file's own function with the IR path off, is
  [#7621](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7621-import-alias-named-like-other-files-function).
- **Row Y**, a cyclic import in which the reassigning module is imported by its importer, fails with no name clash.
  The acyclic control (Y5) and the other cycle direction (Y3) both pass. It needs its own issue, or C8's cycle work.
- **Rows T, T1 and T2**, a TS `namespace` variable named like an outer function, do not compile on any lane. The
  compiler reports `Duplicate identifier 'f'` (T2) or `Cannot assign to 'f' because it is a function` (T, T1). So
  their liveness cannot be measured (design step 5).

### Measurement (cada0d37f7, 2026-11-28, `compileMulti`, probe `.tmp/7530/probe.mts`)

The node column is node 22 running the `ts.transpileModule` output of the same sources.

| row | node | gc IR on | gc IR off | standalone IR on | standalone IR off |
| --- | --- | --- | --- | --- | --- |
| A | 12 | 42 | 42 | 42 | 42 |
| B | 34 | 34 | 34 | 34 | 34 |
| B2 | 14 | 14 | 14 | 14 | 14 |
| B3 | 42 | 42 | 42 | 42 | 42 |
| C | 24 | 44 | 44 | 44 | 44 |
| D | 314 | 343 | 343 | 343 | 343 |
| E | 12 | 12 | 12 | 12 | 12 |
| F | 125 | 122 | 122 | 122 | 122 |
| G | 127 | 112 | 112 | 112 | 112 |
| H | 12 | 42 | 42 | 42 | 42 |
| I | 25 | 55 | 55 | 55 | 55 |
| I0 ([#7621](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7621-import-alias-named-like-other-files-function)) | 15 | 15 | 55 | 15 | 55 |
| X | 12 | 42 | 42 | 42 | 42 |
| Z | 31 | 14 | 14 | 14 | 14 |
| Y | 15 | 11 | 11 | 11 | 11 |
| Y2 | 41 | 44 | 44 | 44 | 44 |
| Y3 | 12 | 12 | 12 | 12 | 12 |
| Y5 | 15 | 15 | 15 | 15 | 15 |
| AB1 | 23 | 21 | 21 | 21 | 21 |
| AB2 | 23 | 23 | 23 | 23 | 23 |
| N0 (#7620) | 4 | 3 | trap | 3 | trap |
| N (#7620) | 14 | 43 | trap | 43 | trap |
| T | 25 | CE | CE | CE | CE |
| T1 | 25 | CE | CE | CE | CE |
| T2 | 15 | CE | CE | CE | CE |

- **Issue row 2 does not reproduce.** It read 14 in node and 34 on 50bce1ba04 ("entry reassigns, dep calls").
  B, B2 and B3 match node on this head.
- **What fails is reading another module's live global.** A file that has no live binding of `f`, and does not
  import one, still reads another file's live `f`: rows A, D, F, H, X, Z and AB1. The same holds when both files
  reassign (C, Y2), and for a renamed import (G, I).
- **Annex B is not involved in module graphs.** Module sources are strict, and `registerAnnexBGlobalLiveBindings`
  skips strict sources (`annexb-global-live-binding.ts:175`). A Script compile puts every source in one realm, so
  no clash between modules can arise there. AB1 fails because of the clash above: dep's block-scoped `f()` reads
  entry's live global. AB2, the same block function beside a `let f`, passes.

### Sources

`entry.ts`, `dep.ts` and, where named, `c.ts` / `lib.ts`. Each row's `main()` is called.

```ts
// A
entry: import { swap } from "./dep"; function f(): number { return 1; } export function main(): number { swap(); return f() * 10 + 2; }
dep:   function f(): number { return 3; } export function swap(): void { f = () => 4; }
// B
entry: import { callF } from "./dep"; function f(): number { return 1; } export function main(): number { f = () => 3; return f() * 10 + callF(); }
dep:   function f(): number { return 4; } export function callF(): number { return f(); }
// B2: B with main = { const a = f(); f = () => 3; return a * 10 + callF(); }
// B3: B with main = { f = () => 3; return callF() * 10 + 2; }
// C
entry: import { swap, callF } from "./dep"; function f(): number { return 1; } export function main(): number { f = () => 2; swap(); return f() * 10 + callF(); }
dep:   function f(): number { return 3; } export function swap(): void { f = () => 4; } export function callF(): number { return f(); }
// D
entry: import { get, swap } from "./dep"; function f(): number { return 1; } export function main(): number { const a = get(); swap(); return a * 100 + f() * 10 + get(); }
dep:   function f(): number { return 3; } export function get(): number { return f(); } export function swap(): void { f = () => 4; }
// E
entry: import { f, swap } from "./dep"; export function main(): number { const a = f(); swap(); return a * 10 + f(); }
dep:   export function f(): number { return 1; } export function swap(): void { f = () => 2; }
// F: E's dep, plus
entry: import { f, swap } from "./dep"; import { h } from "./c"; export function main(): number { const a = f(); swap(); return a * 100 + f() * 10 + h(); }
c:     function f(): number { return 5; } export function h(): number { return f(); }
// G: E's dep, plus
entry: import { f as k, swap } from "./dep"; function f(): number { return 7; } export function main(): number { const a = k(); swap(); return a * 100 + k() * 10 + f(); }
// H
entry: import { f } from "./lib"; import { swap } from "./dep"; export function main(): number { swap(); return f() * 10 + 2; }
lib:   export function f(): number { return 1; }
dep:   function f(): number { return 3; } export function swap(): void { f = () => 4; }
// I: E's dep, plus (I0: the same with dep's swap body empty)
entry: import { f as k, swap } from "./dep"; import { h } from "./c"; export function main(): number { swap(); return k() * 10 + h(); }
c:     function k(): number { return 5; } export function h(): number { return k(); }
// X
entry: import { mk } from "./dep"; function f(): number { return 1; } export function main(): number { mk()(); return f() * 10 + 2; }
dep:   function f(): number { return 3; } export function mk(): () => void { return () => { f = () => 4; }; }
// Z
entry: import { r } from "./dep"; function f(): number { return 1; } export function main(): number { return r * 10 + f(); }
dep:   function f(): number { return 3; } export const r = f(); f = () => 4;
// Y
entry: import { g } from "./dep"; export function f(): number { return 1; } export function main(): number { const a = g(); f = () => 5; return a * 10 + g(); }
dep:   import { f } from "./entry"; export function g(): number { return f(); }
// Y2
entry: import { g } from "./dep"; function f(): number { return 1; } export function k(): number { return f(); } export function main(): number { return g() * 10 + f(); }
dep:   import { k } from "./entry"; function f(): number { return 3; } export function g(): number { f = () => 4; return f() + k() * 0; }
// Y3
entry: import { f, swap } from "./dep"; export const base = 10; export function main(): number { const a = f(); swap(); return a * 10 + f(); }
dep:   import { base } from "./entry"; export function f(): number { return 1; } export function swap(): void { f = () => 2 + base * 0; }
// Y5
entry: import { g } from "./dep"; import { swap } from "./lib"; export function main(): number { const a = g(); swap(); return a * 10 + g(); }
lib:   export function f(): number { return 1; } export function swap(): void { f = () => 5; }
dep:   import { f } from "./lib"; export function g(): number { return f(); }
// AB1
entry: import { d } from "./dep"; function f(): number { return 1; } export function main(): number { f = () => 2; return f() * 10 + d(); }
dep:   export function d(): number { let r = 0; { function f(): number { return 3; } r = f(); } return r; }
// AB2: AB1's dep, plus
entry: import { d } from "./dep"; let f = 1; export function main(): number { f = 2; return f * 10 + d(); }
// N0
entry: import * as d from "./dep"; export function main(): number { d.swap(); return d.f(); }
dep:   export function f(): number { return 3; } export function swap(): void { f = () => 4; }
// N: N0's dep, plus
entry: import * as d from "./dep"; function f(): number { return 1; } export function main(): number { d.swap(); return f() * 10 + d.f(); }
// T (one file; T2 drops `f = () => 2;`; T1 makes the namespace's `var f` non-exported)
entry: function f(): number { return 1; } namespace N { export var f = (): number => 5; export function g(): number { return f(); } }
       export function main(): number { f = () => 2; return f() * 10 + N.g(); }
```

### Cause

- **Registration is by name.** `registerReassignedFunctionGlobals` (`src/codegen/index.ts:9053`) collects exact
  declarations but mints one `__mod_f` per name (9224-9237). It finds the function through `ctx.funcMap.get(name)`,
  the last file's `f` after collect, and skips the name whenever `ctx.moduleGlobals.has(name)`.
- **Liveness is a graph-wide name set**, written from three places:
  - this loop;
  - Annex B (`annexb-global-live-binding.ts:207`);
  - the import alias copy (`index.ts:9607`).

  `ctx.evalOnlyLiveFuncBindings` is a second name set beside it.
- **The seed walks names.** The initial-value code (`declarations/module-init-prologue.ts:94-133`) walks the set by
  name, under the last body pass's view. That is why Z reads the entry's `f` during dep's module initialiser.

### Design

Liveness has one source: the binding in #7470's table. `ctx.liveFuncBindingGlobals` becomes what
`ctx.moduleGlobals` already is, a bare-name view of the table that the per-file projection re-points.

1. **The table owns liveness** (`module-binding-table.ts`).
   - `ModuleBindingDeclaration` adds `ts.FunctionDeclaration`. The key is unchanged (a module's SourceFile, or the
     one Script realm).
   - `ModuleBinding` gains `liveFunction?: "assigned" | "eval"`.
   - New `markLiveFunctionBinding(ctx, binding, kind)`:
     - sets the field (`"assigned"` wins over `"eval"`);
     - appends the binding to a registration-ordered list, read by `liveFunctionBindings(ctx)`;
     - adds the name to `ctx.liveFuncBindingGlobals` when the bare `moduleGlobals` entry is this binding's global.
       That is the only write to the set outside the projection.
   - `ProgramAbiGlobalRegistry.moduleBinding` keeps the narrower `IrModuleBindingDeclaration` parameter, so `src/ir`
     does not change.
2. **One allocation helper** (`module-global-registration.ts`).
   - Extract the tail of `registerModuleGlobal` (243-258: scoped lookup, mint bare / allocate / reuse an entry no
     binding holds, add, attach) into a private `bindModuleGlobal`. Its users:
     - `registerModuleGlobal`;
     - new `registerLiveFunctionGlobal(ctx, declaration, kind)`;
     - new `registerAnnexBLiveBinding(ctx, declaration)`.
   - `registerLiveFunctionGlobal` keeps today's two skips:
     - the scope already has a non-live binding of the name (a same-scope `var f`);
     - the bare entry is a global no binding holds.

     Otherwise it mints, or attaches the declaration to the scope's existing live binding, then marks the binding.
     A duplicate `function f` in one Script (#3419: the last body wins) therefore attaches to one binding. The
     function check below finds the surviving body.
   - `registerAnnexBLiveBinding` takes the scope's existing binding or mints one, then marks it `"assigned"`. The
     externref widening of an existing `var` global stays in `annexb-global-live-binding.ts`, which loses its
     inline `__mod_` push.
3. **The caller** (`index.ts`, `registerReassignedFunctionGlobals`).
   - The loop iterates `reassignedDeclarations` in insertion order. The kind is `"eval"` for a declaration added
     only by the eval branch, `"assigned"` otherwise. The function check is
     `ownSourceFunctionIdx(ctx, sourceFile, name) ?? ctx.funcMap.get(name)`.
   - Removed:
     - the `reassigned` name set;
     - the inline push;
     - `ctx.evalOnlyLiveFuncBindings` (and its field in `context/types.ts`).
   - The eval branch's `!declaration` arms (9206, 9215) are dead and go, for two reasons:
     - `topLevelFunctionNames` and `topLevelFunctionDeclarations` are filled together in `collectDeclarations`
       (`declarations.ts:2565-2566`);
     - the single-file pre-scan (`index.ts:5472-5476`) admits only declarations that `collectDeclarations` then
       records.

     Measured: no declaration-less eval name in any corpus below.
   - **Finding 7.** `named-this-call.ts:655-656` asks
     `moduleBindingOf(ctx, declaration)?.liveFunction === "eval"` of the declaration it already holds. So eval-only
     liveness follows the binding, and the separate name set is gone.
4. **Import aliases** (`index.ts`, `registerImportBindingAliases`).
   - Delete `liveFuncBindingGlobals.add(localName)` (9607). An alias is live only where it is imported. The
     projection's import rule (step 5) shows it in the importing file, from the target binding's `liveFunction`.
   - The alias's `moduleGlobals` copy (9583-9585) stays as it is: it is #7470's, and the funcMap half belongs to
     [#7621](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7621-import-alias-named-like-other-files-function).
5. **Projection** (`source-binding-projection.ts`).
   - `ModuleNameState` gains `liveFunction?: boolean`.
     - `moduleNameState` reads it from the set, and from the binding for a colliding name.
     - `setModuleNameState` writes it into the set next to the two maps.
   - `SourceBindingView.globals` becomes `Map<string, ModuleNameState>`, and a frozen `NO_MODULE_BINDING = {}` state
     hides a name.
   - `recordSourceModuleBindingView` gains one rule. For each name of a live-function binding, each module source
     must show, in this order:
     1. its own binding of the name;
     2. the binding its import of that local name resolves to (`aliasedValueDeclarationOf`);
     3. `NO_MODULE_BINDING`.

     An entry is recorded only when this differs from what the bare name shows, in value global or in liveness. In
     a Script compile every source shares the realm's binding, so step 1 always answers and nothing is recorded.
   - The existing import condition also compares liveness, so a live alias (G, I) is shown in its importing file
     only.
   - This replaces revision 1's two special rules (an own colliding function, a never-reassigned import). Both are
     instances of the third case.
   - **Finding 4: the namespace projection keeps liveness out.** `withDirectRuntimeModuleBindings`
     (`declarations.ts:1748`) passes the name's current `liveFunction` through, so a TS namespace binding never
     changes liveness. The shapes where it would matter (T, T1, T2) do not compile on any lane, so a change there
     could not be measured. Keeping today's behaviour is the only verifiable choice.
6. **Seed** (`declarations/module-init-prologue.ts`).
   - One loop over `liveFunctionBindings(ctx)`. Each record is seeded inside
     `withSourceBindings(ctx, record.source, …)` (#7470's nested-view path), with the per-name body extracted as is,
     including its Annex B arm and its `seededGlobals` dedupe.
   - Annex B bindings are records now, and aliases no longer join the set, so the set walk goes away.
   - `moduleInitPrologueForcesInit` asks `liveFunctionBindings(ctx).length > 0`.
   - In a single file the list order equals today's set order: assignment-reassigned, then eval, then Annex B.

### Byte identity (finding 6)

Census on cada0d37f7 with a temporary counter in the mint loop (`.tmp/7530/instr.py`, `.tmp/7530/census.mts`;
not committed). "Reach" means the loop runs with a non-empty set.

| corpus | files | reach the loop | mint ≥ 1 global | eval branch runs | eval-only bindings | name with no declaration | duplicate declarations in one scope | name already in `moduleGlobals` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sample3.txt` (the 389-file #7470 sample) | 389 | 2 | 2 | 2 | 0 | 0 | 0 | 0 |
| `eval-sample.txt` | 113 | 3 | 1 | 94 | 1 | 0 | 0 | 0 |
| `reassign-sample.txt` | 553 | 29 | 18 | 371 | 16 | 0 | 0 | 0 |
| lodash-es (`compileProject(lodash.js)`) | 1 graph | yes | 475 gc / 473 standalone | yes | 476 gc / 474 standalone | 0 | 0 | 1 |

- **The counts do not depend on the lane.** They are the same on gc and standalone, with the IR path on or off;
  only lodash-es's totals differ by target.
- **The 389-file sample barely exercises this code.** Only 2 of its files reach the loop:
  `language/module-code/instn-local-bndng-export-{fun,gen}.js`. That is why the gate adds the other two corpora:
  34 single files reach the loop in all.
- **lodash-es is the large case.** It mints one eval-only live binding per function (it contains a dynamic
  `Function` source), so it exercises the hiding rule heavily.
  - It is a graph with name clashes (97 names), so its bytes are expected to change.
  - Its one existing-global name is today a silently shared global. It gets its own global after this change.
  - The gate for it is behaviour, not bytes, as in #7470:
    - `tests/lodash-es-e2e.test.ts`, `tests/issue-6985-lodash-es-o4.test.ts` and
      `tests/issue-3995-lodash-es-global-builtin-alias.test.ts`;
    - the upstream suite (`tests/dogfood/lodash-upstream-suite.mjs --package=lodash-es`) compiles and validates;
    - binary size and compile time, recorded before and after (base: 6,237,710 bytes gc, 6,113,303 standalone).

Gate, base (cada0d37f7) against new, every corpus × gc/standalone × IR on/off:

- `.tmp/7530/sample3.txt`: the 389-file sample, copied from the #7470 worktree.
- `.tmp/7530/eval-sample.txt`: 113 eval and Annex B files.
- `.tmp/7530/reassign-sample.txt`: 553 files picked by `.tmp/7530/find-reassign.mjs`, which match a function
  declaration whose name is assigned, or `eval`.
- `.tmp/mhash.mts` from the #7470 worktree, plus four graphs:
  - E (an import of a reassigned function);
  - a renamed import of a reassigned function with no name clash (G without entry's own `f`);
  - E plus a third file that never names `f`;
  - Y3 (cyclic).

### Tests

New `tests/issue-7530-same-named-reassigned-functions.test.ts`, using the harness of
`tests/issue-7470-same-named-module-bindings.test.ts`.

- **Pin rows.** Every row of the acceptance criteria, × gc/standalone × `experimentalIR` on/off. Row I runs with the
  IR path on only, citing [#7621](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7621-import-alias-named-like-other-files-function).
- **Related suites.** `tests/issue-7470-*`, `tests/issue-2930*`, `tests/issue-2931*`, `tests/issue-4133*`,
  `tests/issue-4182*`, `tests/issue-3505*`, `tests/issue-6880*`, and the lodash-es tests #7470 ran.
- **Gates.** Unpiped, including `check:import-cycles`, because `module-init-prologue.ts` now imports the projection
  module.

### Risks

- **Set readers outside a body pass.** `multi-prepared-module-init.ts:150`, `multi-prepared-module-init-census.ts:280`
  and `ir-overlay-preparation.ts:115/168` read the set at collect-time state. There it still holds every live name whose binding
  holds the bare entry, but not a colliding second binding, which shows only inside its own file's view. If an
  IR-on pin row shows such a reader deciding wrongly, it asks `liveFunctionBindings(ctx)` instead. Do not add a
  second set.
- **Hidden names in files that never name them.** A graph with a live function makes every other module's view
  hide that name. Readers keyed by a bare name the file never mentions do not run, and the mhash graph with a third
  file checks this. In lodash-es that is about 475 names across every module, so record its compile time before and
  after.

### Files and functions (for the lane split with C8, #7620)

| file | functions / region |
| --- | --- |
| `src/codegen/module-binding-table.ts` | `ModuleBindingDeclaration`, `ModuleBinding`, the table record; new `markLiveFunctionBinding`, `liveFunctionBindings` |
| `src/codegen/source-binding-projection.ts` | `SourceBindingView`, `recordSourceModuleBindingView`, `ModuleNameState`, `moduleNameState`, `setModuleNameState`; new `NO_MODULE_BINDING` |
| `src/codegen/module-global-registration.ts` | `registerModuleGlobal` (203-259, tail extracted to `bindModuleGlobal`); new `registerLiveFunctionGlobal` and `registerAnnexBLiveBinding` right after it. The TDZ functions (309 onward) are untouched |
| `src/codegen/index.ts` | `registerReassignedFunctionGlobals` (9053-9240); one line of `registerImportBindingAliases` (9607) |
| `src/codegen/annexb-global-live-binding.ts` | `registerAnnexBGlobalLiveBindings` (169-212) |
| `src/codegen/declarations/module-init-prologue.ts` | the seed loop (88-133), `moduleInitPrologueForcesInit` (139-145) |
| `src/codegen/declarations.ts` | `withDirectRuntimeModuleBindings`, line 1748 only |
| `src/codegen/named-this-call.ts` | lines 655-656 |
| `src/codegen/context/types.ts` | drop `evalOnlyLiveFuncBindings` (3203) |
| `tests/issue-7530-same-named-reassigned-functions.test.ts` | new |

- **Not touched:** `module-namespace-value.ts`, `identifiers.ts`, `identifier-module-storage.ts`, the TDZ
  functions and `src/ir/`.
- **Shared with C8:** `module-global-registration.ts` (disjoint regions) and `declarations.ts` (one line).
