---
id: 7530
title: "Same-named reassigned functions in different files share one live-binding global"
status: done
completed: 2026-11-28
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
related: [7470, 7621, 7627, 7635, 7636, 7639, 7640, 7644]
loc-budget-allow:
  # 2026-11-28 (#7530): +2 in withDirectRuntimeModuleBindings, which keeps the name's live-function kind across a namespace projection (plan step at declarations.ts:1748); the save/restore loop lives in that driver, so the line cannot move to a module
  - src/codegen/declarations.ts
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

- **Fixed rows.** A, C, F, H, X, Y2 and Z (sources below), plus D′ (D with `swap` declared before `get`) and G read
  as a value, answer like node on gc and standalone, with the IR path on and off.
  - *Amended 2026-11-28, after implementation.* D, G (direct call), AB1 and I were listed here and are **not met**.
    Each keeps a residual that reproduces on main with no name clash at all, so it is a separate defect (Results):
    D goes to #7627 (shape Y, the compile-order defect), G to [#7635](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7635-direct-call-through-renamed-import-of-reassigned-function) and AB1 to
    [#7636](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7636-block-function-resolves-to-other-modules-function).
  - "I answers like node with the IR path on" is **not met** either: with `k` live, the IR declines `main`, and the
    bare-name inliner of [#7621](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7621-import-alias-named-like-other-files-function) substitutes the third file's `k`. Only I read as a value
    (`const g = k`) is pinned.
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
  - No liveness name set beside the table: the `reassigned` set and `ctx.evalOnlyLiveFuncBindings` are removed.
    `ctx.annexBModuleBindings` and `ctx.globalObjectVarBindings` stay: they record other facts about a name (it is
    an Annex B B.3.3 binding, so `__module_init` evaluates its block declarations and seeds it `undefined`; it is a
    global-object property), not whether it is live, and moving them into the table is outside this issue.
  - (Review condition e) A live function name is hidden only in a source that spells it, so a module that never
    names it compiles without the projection. lodash-es compile time before and after is under Results. "Spells"
    means an identifier in the source's AST: a name that appears only inside an eval string is not hidden there.
  - No new module, no branch for a state the table cannot reach. One budget grant: `loc-budget-allow` for
    `src/codegen/declarations.ts`, +2 lines in `withDirectRuntimeModuleBindings` (the namespace projection keeps a
    name's live-function kind, the plan's step at ~L1748). It was added on the merge with main, 2026-11-28; the
    reviewer judges it.

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
  The acyclic control (Y5) and the other cycle direction (Y3) both pass. It is #7627.
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
   - `ModuleNameState` gains `liveFunction?: LiveFunctionKind`, the same `"assigned" | "eval"` union as
     `ModuleBinding.liveFunction`, so a binding passed as a state carries one representation (review condition a).
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

## Results (2026-11-28)

Implemented on `claude/7530-reassigned-functions` against 73c3b4070a, the plan's design with the changes below.
Base for every before/after figure: 73c3b4070a, exported with `git archive` into `.tmp/base`.

### Rows

Measured with `.tmp/7530/probe.mts` and pinned in `tests/issue-7530-same-named-reassigned-functions.test.ts`
(70 tests: 9 fixed rows and 8 kept rows on gc and standalone, IR on and off, plus the Annex B row on IR on).

| row | node | before | after (all four lanes) |
| --- | --- | --- | --- |
| A | 12 | 42 | 12 |
| C | 24 | 44 | 24 |
| D | 314 | 343 | 313, see below |
| D′ (D with `swap` declared before `get`) | 314 | 144 | 314 |
| F | 125 | 122 | 125 |
| G | 127 | 112 | 117, see below |
| G read as a value (`const h = k`) | 127 | 122 | 127 |
| H | 12 | 42 | 12 |
| I | 25 | 55 | 55, see below |
| I read as a value (`const g = k`) | 25 | 25 | 25 |
| X | 12 | 42 | 12 |
| Y2 | 41 | 44 | 41 |
| Z | 31 | 14 | 31 |
| AB1 | 23 | 21 | 21, see below |
| B, B2, B3, E, Y3, Y5, AB2 | as node | as node | as node |

The pinned fixed rows (A, C, D′, F, G as a value, H, X, Y2, Z) fail on the base on every lane (36 of 36); the
kept rows pass on both.

**Four rows keep a residual that needs no name clash, so they are not fixed here.** Each part this issue owns (the
other module's live global) is gone; what remains reproduces without it, and fixing it would change bytes of the
clash-free gates:

- **D.** A direct call of a live function that compiles before any assignment to it stays a direct call: the call
  path routes through the live global only once `closureMap` holds the name, which the assignment's compile sets.
  The single-file form gives 303 for node's 304 on the base too. D′ pins the clash part.
- **G.** A direct call of a renamed import (`k()`) of a reassigned function stays direct: the alias gets no closure
  entry. With no clash at all (the `G0` mhash graph) the base already gives 110 for node's 120. G read as a value
  is pinned.
- **I.** The same alias call, and then the call-site inliner, keyed by bare name, inlines the third file's own `k`.
  That is #7621's defect; once `k` is live in the entry the IR declines `main`, so it shows with the IR path on as
  well (55 on the base too). Review condition f: I read as a value is pinned, on all four lanes.
- **AB1.** A block function `f` in one module calls another module's top-level `f` (`funcMap` is keyed by bare
  name and #4133's projection covers top-level functions only). Without any reassignment the base gives 11 for 13.

**Routing (2026-11-28).** Each residual reproduces on main without a name clash, so this issue stays done and
the residuals are separate defects:

| row | clash-free form on main dae2db2cca (all four lanes) | issue |
| --- | --- | --- |
| D | single file, 303 for node's 304 | #7627, as a row beside shape Y (same compile-order defect) |
| G | `G0`, 110 for node's 120 | [#7635](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7635-direct-call-through-renamed-import-of-reassigned-function) |
| AB1 | `AB0`, 11 for node's 13 | [#7636](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7636-block-function-resolves-to-other-modules-function) |
| I | I0, 55 for node's 15 with the IR path off | [#7621](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7621-import-alias-named-like-other-files-function) |

### Deviations from the plan

- **The hiding rule is limited to sources that spell the name** (review condition e). Hiding every live name in
  every module cost lodash-es +34 % compile time on gc and +35 % on standalone (46.9 s and 43.1 s against 34.9 s and
  31.9 s, one run each). A source that never spells a name has no read of it. The identifier index this needs
  already existed privately in `declarations/provenance-closed-arrays.ts`; it moved to
  `src/shared/callee-name-index.ts`, beside the call-site index, and both users import it (no new module). The IR's
  verbatim copy in `src/ir/closure-signature-flow.ts` now imports it too (review finding 2).
- **The seed loop loses its `seededGlobals` dedupe.** It existed for import aliases sharing their target's global.
  Aliases no longer join the list, and no two bindings share a global, so the set could never hit.
- **Two more collect-time readers of the set ask the table.** `multi-prepared-module-init-census.ts` (the IR-on
  pin rows failed with `parity-changed` until it did, because the census re-read the set under a view) and the
  matching admission check in `multi-prepared-module-init.ts` read `liveFunctionBindings(ctx)`, as the Risks section
  provides. `ir-overlay-preparation.ts` needed no change.
- **`moduleNameState` finds a non-colliding live name's kind through the table's owner of the global**
  (`moduleBindingOfGlobal`, a `byValue` map in the table), so a saved state keeps the `"assigned" | "eval"` union
  (review condition a), including for an import alias shown in its importing file.
- **`registerModuleGlobal` keeps a variable-only parameter type.** `ModuleBindingDeclaration` now includes
  `ts.FunctionDeclaration`; the variable registration path and the Program ABI registry
  (`IrModuleBindingDeclaration`) keep the narrower types.

### Review conditions

- **9.** Row Y cites #7627 under "Out of scope".
- **a.** `ModuleNameState.liveFunction` is `LiveFunctionKind` (`source-binding-projection.ts`), the type of
  `ModuleBinding.liveFunction` (`module-binding-table.ts`).
- **b.** `registerAnnexBLiveBinding` marks `binding.liveFunction ?? "assigned"` and `markLiveFunctionBinding` never
  downgrades, so an eval-only binding stays eval-only. **The corpus byte gate would not catch a break**: an
  instrumented run over the eval/Annex B and reassign samples found 21 Annex B registrations, none on an existing
  eval-only binding, and the kind is read only by `named-this-call.ts`, which no corpus file reaches. So the row is
  pinned by behaviour instead: a Script with an eval-only `function f`, an Annex B block `f`, and
  `if (!f.call(o)) throw …`. With the rule broken (marking `"assigned"`), both IR-on lanes of that test fail (the
  receiver is dropped and the initializer throws). The same source with the check moved into a function compiles to
  the base's bytes with the rule (gc `b0e7095b3064`) and to other bytes without it (`8768480f02c0`).
  With the IR path off the receiver is dropped before and after this change, so the row runs IR on only.
- **c.** The criterion now reads "no liveness name set"; why `annexBModuleBindings` and `globalObjectVarBindings`
  stay is under the criterion.
- **d.** `registerAnnexBLiveBinding(ctx, name, declarations)` attaches every block declaration to the one binding.
- **e.** See the first deviation.
- **f.** Pinned (row "I renamed import k …, read as a value").

### Adversarial review (RV-PR7569, 2026-11-28)

Verdict on 35db004b05: **block** on one finding; everything else checked out (2,184 byte rows identical, rows A, C,
X and Z and the reviewer's extra probes match node, the residuals reproduce without a clash on main, the
`declarations.ts` grant accepted). Fixed in the next push:

1. **Block: eval liveness went through the graph-wide name map.** `registerReassignedFunctionGlobals` iterated
   `ctx.topLevelFunctionDeclarations`, which keeps one declaration per name across the program (the last one
   registered, `declarations.ts` ~2568). With a clash, only that module's `f` became eval-live, so a module whose
   own eval rebinds its `f` lost its live binding. It now walks each source's own top-level functions
   (`sourceTopLevelFunctions` in `index.ts`, built from the per-environment declaration map the function already
   collects). Measured with the QuickJS provider, standalone, IR on and off:

   | row | node | before | after |
   | --- | --- | --- | --- |
   | EV1 (dep's eval rebinds its own `f`; entry has its own `f`) | 41 | 31 | 41 |
   | EV2 (EV1 without the clash) | 40 | 40 | 40 |
   | EV3 (EV1's clash in a third file imported after dep) | 41 | 31 | 41 |
   | EV4 (EV3 with that file imported first) | 41 | 41 | 41 |

   Pinned twice in `tests/issue-7530-same-named-reassigned-functions.test.ts`: by structure on every run (one
   `__mod_f` per eval-rebindable `f`; EV1, EV3 and EV4 fail without the fix), and by answer under QuickJS, which
   skips where QuickJS is not built (unit CI builds only the refusal provider).
2. Fold the IR's verbatim `identifierIndex` copy (`src/ir/closure-signature-flow.ts`) into
   `src/shared/callee-name-index.ts`: done.
3. (Nit) `registerAnnexBLiveBinding` used `map` for its side effects: now the first declaration's binding, then a
   plain loop that joins the rest.
4. (Nit) `module-global-registration.ts` and `ModuleBindingDeclaration` spell `ts.VariableDeclaration |
   ts.BindingElement` as `IrModuleBindingDeclaration` (`src/ir/module-bindings.ts`).
5. (8) Condition e now says a name that appears only inside an eval string is not hidden.

After the fix, against the reviewed head (dc5c7fed3d), on 2026-11-28:

- Byte gate: 4,220 of 4,220 rows identical (the 389-file, eval/Annex B and reassign samples × gc/standalone × IR
  on/off). Every corpus file is a single source, so the per-source walk visits the same declarations in the same
  order there.
- lodash-es `compileProject(lodash.js)`, three runs each: gc 6,356,395 → 6,359,057 bytes (+2,662, +0.04 %; each
  source's own eval-rebindable functions are now live), standalone 6,232,698 bytes both. Compile medians gc 36.6 s
  → 35.9 s, standalone 33.6 s → 33.5 s (within noise). Both validate. The "after" side includes the merge of main
  ea628a7874.
- Pins: the 7530, 7470, 7464, 4133 ×2, 2930, 2931, 4182 and 6880 files, 261 of 261 (the 8 new eval rows included,
  run with QuickJS built here).

**Known regression against main (approved on condition, 2026-11-28): EV5**, two modules each rebinding their own
`f` with a direct eval. node gives 42 and main gives 42, but only by accident: one shared `__mod_f`. This PR gives 41,
because runtime-eval push and pull still form one program-wide namespace keyed by bare name, and carry only one
module's `f`. This is not a test262 shape (test262 runs one source at a time). It needs a per-module eval scope and is
filed as [#7644](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7644-eval-push-pull-one-namespace-for-all-modules), which also holds its known-wrong pin.

Follow-ups filed, unclaimed: [#7639](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7639-eval-liveness-only-in-modules-with-direct-eval) (eval liveness only in modules that contain a direct eval, the
lodash-es cost driver) and [#7640](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7640-reassigned-let-and-function-of-same-name-in-two-modules) (VAR2: a reassigned `let f` in one module and a `function f` in
another, wrong on main too). [#7621](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7621-import-alias-named-like-other-files-function)'s
acceptance now names row I with the IR path on.

### Validation

| check | result |
| --- | --- |
| byte gate: 389-file sample, eval/Annex B sample (113), reassign sample (553) × gc/standalone × IR on/off | 4,220 of 4,220 rows identical |
| `mhash` (#7470's 5 graphs plus E, G0, E with a third file, Y3) × 4 lanes | 36 of 36 identical |
| `tests/issue-7530-*` | 70 passed |
| issue-7470, 7464, 2930, 2931, 4133 (2 files), 4182, 6880 (2 files) | all passed |
| issue-3505 | 2 of 3 fail on base and after: `test262-fyi/data` submodule absent here |
| lodash-es e2e, 6985, 3995 | 12 passed, 2 skipped in-file (`it.skip`, unchanged) |
| lodash-es upstream suite | before and after: compiles, validates, 3,229,932 bytes; 0/62 run, both failing at instantiation on the absent `js2wasm:runtime-eval` provider |
| `node scripts/equivalence-gate.mjs` | exit 0, no new regressions (2 baseline failures now pass) |
| loc/func budget, coercion sites, oracle ratchet, dead exports, import cycles, compiler boundaries (`--base HEAD^1` and `origin/main`) | exit 0 |
| `LOC_GATE_BASE=origin/main` loc budget | exit 1, on two files this change does not touch: `eval-inline.ts` and `ir/select.ts` are larger on this stacked branch than on main (2,216 vs 2,159 and 14,773 vs 14,748 lines). Merging main into the stack clears it |

lodash-es `compileProject(lodash.js)`, three runs each, idle box:

| target | bytes before | bytes after | compile before (ms) | compile after (ms) |
| --- | --- | --- | --- | --- |
| gc | 6,237,710 | 6,356,395 (+1.9 %) | 34,695 / 34,279 / 34,342 | 40,604 / 35,762 / 35,147 |
| standalone | 6,113,303 | 6,232,698 (+2.0 %) | 33,948 / 30,522 / 29,949 | 33,702 / 33,279 / 31,933 |

Both validate. The growth is in the closure dispatchers (`__dyn_call_*`, `__call_fn_method_*`): 97 names clash in
lodash-es, and each module's own same-named function is now its own value instead of the last module's.
