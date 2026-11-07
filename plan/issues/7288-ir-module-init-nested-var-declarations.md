---
id: 7288
title: "IR module-init: a nested top-level `var` (block / `for` / `for-in` head) lowers to its module binding instead of withdrawing"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7276, 3523]
assignee: "ttraenkler/c-lead"
loc-budget-allow:
  # 2026-11-06 (#7288): one shared predicate, `isModuleInitVarList`, decides
  # which hoisted `var` lists are module bindings; the growth is its wiring.
  # module-bindings.ts +2: `isModuleBindingDeclaration` admits a script's
  # modelled `for (;;)` head. declarations.ts +2: the one call that observes
  # the head's `__mod_<name>` slot under its exact declaration, and its import.
  #
  # select.ts +13: `isDirectModuleDeclaration` (the statement path's "direct
  # module declaration" test, now shared with hoisted heads), and the for-init
  # arm routing a hoisted head through the `var`-statement check
  # (`isPhase1VarDecl`), which replaces a partial copy of its checks.
  # from-ast.ts +4: `lowerForInitializer`, so that a hoisted head lowers in
  # the enclosing scope and the loop keeps its inner one.
  - src/ir/module-bindings.ts
  - src/codegen/declarations.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
func-budget-allow:
  # 2026-11-06 (#7288): the one observe call in the for-head arm of
  # `walkModuleStmtForVars`, which is nested in `collectDeclarations`.
  - src/codegen/declarations.ts::collectDeclarations
import-cycles-allow:
  - codegen->ir: 303 # 2026-11-06 (#7288): module-global-registration.ts reads the IR's `isModuleInitVarList`, the one predicate for which hoisted `var` lists are module bindings, so legacy observes exactly the slots the IR resolves
---

# #7288: nested top-level `var` in `<module-init>`

## Problem

from-ast withdraws a selector-claimed `<module-init>` with
`ir/from-ast: module-init unit contains a nested var declaration`: a `var`
declared inside a block, a `for` head or a `for-in` head at script top level
is still a module binding (hoisted), but the lowering refuses it. This is a
claim-then-withdraw. #7276 measured it on the 7 `built-ins/Object/create`
for-in files.

## Measurement (2026-11-06, base: the #7276 branch, stacked)

**Stride-40 census.** From the #7276 head ledger, wrapped, standalone, SHAPE_DIAG:

- the from-ast withdrawal (`module-init unit contains a nested var declaration`) occurs in **0** files;
- the selector's up-front `for-init-var-kind` refusal occurs in 6 files and is the sole blocker in 3: `language/statements/for/12.6.3_2-3-a-ii-16`, `…/head-var-bound-names-in-stmt`, and `intl402/…/basic-persian`.

**Targeted census**, 506 files: `language/statements/for` + `for-in` + `built-ins/Object/create`. Sole blockers:

- `for-init-var-kind`: 19 files;
- the withdrawal: 7 files, all of them `Object/create` for-in files (`for (var property in newObj)`);
- of the 100 sole `expr-ident-not-in-scope` rows, none is a read of a nested `var`.

**Shapes** (standalone probes, selector verdict, then from-ast):

| shape | before | legacy |
| --- | --- | --- |
| `for (var i = 0; …; …)` at top level | refused up front: `for-init-var-kind` | `__mod_i` (hoisted, by name) |
| `for (var k in o)` at top level, `k` read only in the body | **claimed, then withdrawn** by from-ast | `__mod_k` |
| `for (var k in o)`, `k` read after the loop | refused: `expr-ident-not-in-scope k` | `__mod_k` |
| `for (var x of a)` | refused: `unattributed-arm` | `__mod_x` |
| `if (…) { var y }`, `{ var z }`, `try { var t }` | refused: `vardecl-var-kind` | hoisted `__mod_` |

So the claim-then-withdraw is exactly the for-in head. The selector binds that head as a loop-local slot (#2952 S6c), but it is a hoisted module `var`. The other nested shapes are already refused up front.

**Why a for-head did not lower.**

- `module-init-vars.ts` models identifier for-heads as "the S6 follow-up": only pattern heads (S5) were module bindings.
- Legacy registers every hoisted nested `var` slot by name (`registerVarDeclListGlobals`) without its declaration. The IR's resolver, however, looks a slot up by exact declaration (`programAbiGlobals.moduleBinding`).
- Admitting the head without the observation is therefore a hard compile error (measured: `IR path failed for <module-init>: module-init: supported binding 'i' has no exact allocator-owned module global`).

**for-in head as a module binding.** The slot is typed `string` (the native string carrier), while the for-in key is an externref carrier. Writing it on every iteration would need the string-carrier recovery on every lane, which is a separate slice. So the head is refused up front.

**Expected zero-legacy delta**, stated before coding: +3 at stride 40 at most, and +19 at most in the targeted census (the sole `for-init-var-kind` files).

## Implementation Plan

- **One predicate.** `moduleInitVarList` (`src/ir/module-init-vars.ts`) models any top-level `for (;;)` `var` head; identifiers are scripts only. Everything else follows from it:
  - the selector's safe lists (`collectIrSafeModuleVarDeclarationLists`);
  - `isModuleBindingDeclaration` (`module-bindings.ts`), which admits a script's modelled head declaration;
  - `moduleBindingDeclarationOrder`, where head declarations are appended after the leaves, so no existing ordinal moves;
  - from-ast's `moduleInitContainsNestedVar`, which skips modelled lists.
- **Legacy observation.** `observeHoistedForHeadVars` (`module-global-registration.ts`) observes the head's by-name slot under its exact declaration, only for lists `isModuleInitVarList` models. It shares `observeModuleGlobal` with `registerModuleGlobal`'s existing-global branch. No new slot is allocated, so no wasm output changes.
- **for-in.** `isPhase1ForInStatement` refuses a `<module-init>` head that hoists into its module slot (`forin-head-module-var`). There is no claim-then-withdraw left.
- **Code-quality criterion.** No sibling declaration arm: the head lowers through the existing module-binding declaration path (`lowerVariableDeclaration` → module slot). One predicate decides modelled lists on both the IR and the legacy side.
