---
id: 7288
title: "IR module-init: a nested top-level `var` (block / `for` / `for-in` head) lowers to its module binding instead of withdrawing"
status: done
completed: 2026-11-07
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
  # 2026-11-07 (#7288): module-global-registration.ts → ir/module-init-vars.ts.
  # Legacy must observe exactly the hoisted heads the IR resolves; a second
  # copy of the rule in codegen would let the two drift, which is the
  # hard-compile-error class the review found. The edge cannot be cut:
  #   - moving the predicate below both is not possible, because
  #     module-init-vars.ts depends on IR modules (binding-pattern-plan,
  #     function-local-var);
  #   - injecting it would thread a callback through `collectDeclarations`
  #     (already over its budget) only to hide the same dependency.
  # codegen already imports the IR's module-init identity (declarations.ts →
  # ir/module-init.js), so the direction is not new; only the file pair is.
  - codegen->ir: 303 # 2026-11-07 (#7288): legacy observes exactly the for-heads the IR resolves, through the IR's one predicate (see above)
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
- **The selector checks a hoisted head as the `var` statement it lowers as.** The for-init arm routes a module-init head through `isPhase1VarDecl`, whose "direct module declaration" test becomes `isDirectModuleDeclaration`. So storage, value flow and closure checks are the statement's own, with no partial copy. from-ast lowers the head in the enclosing scope (`lowerForInitializer`) for the same reason (added after review, findings 2 and 4).
- **Legacy observation.** `observeHoistedForHeadVars` (`module-global-registration.ts`) observes the head's by-name slot under its exact declaration, only for lists `isModuleInitVarList` models. It shares `observeModuleGlobal` with `registerModuleGlobal`'s existing-global branch. No new slot is allocated, so no wasm output changes.
- **for-in.** `isPhase1ForInStatement` refuses a `<module-init>` head that hoists into its module slot (`forin-head-module-var`). There is no claim-then-withdraw left.
- **Code-quality criterion.** No sibling declaration arm: the head lowers through the existing module-binding declaration path (`lowerVariableDeclaration` → module slot). One predicate decides modelled lists on both the IR and the legacy side.

## Result (2026-11-07, base: #7276 tip d634f60f, head 2f7f7110)

- **Wrapped ledger** (stride 40, standalone, SHAPE_DIAG):
  - compileOk and invariants unchanged (0 = 0);
  - legacy units 4749 → 4748;
  - **zero-legacy 33 → 34** (`language/statements/for/12.6.3_2-3-a-ii-16.js`);
  - five files only move their first refusal later.
- **Targeted census** (506 files: `language/statements/for` + `for-in` + `built-ins/Object/create`):
  - **zero-legacy 67 → 78**: `for/12.6.3_2-3-a-ii-{11,13–21}` and `for/head-init-var-check-empty-inc-empty-syntax`; 0 new CE;
  - the 9 `Object/create` for-in files now refuse up front (`forin-head-module-var`); before, they were claimed and withdrawn.
- **Typed corpus** (playground × gc / standalone / WASI, 39 compiles): byte-identical, host imports identical.
- **test262 A/B**, row by row, identical:
  - standalone, 803 files (`for` + `for-in` + `Object/create` + 300 seeded-random): 673 / 104 / 14 / 12;
  - gc, `for` + `for-in` (186 files): 163 / 23.
- **Tests:**
  - `tests/issue-7288-module-init-for-head-var.test.ts`: 16 cases × 3 lanes, verdict against JS and route per lane;
  - the #7106 S5 / script-var / uninitialized-var suites, plus #7276 and #7128: 367 / 367;
  - #7106's `identifierHead` (S6) moved from refused to claimed;
  - 26 failures in `issue-2949-slice3b`, `issue-2952-slice3/6`, `issue-3142`, `issue-3583` and `issue-7106-module-init-chunks` fail identically on base; they predate this change.

## Adversarial review (fresh context, 2026-11-07)

Round 1 verdict: not ready (3 must-fix). All findings fixed in 2f7f7110:

1. **Fixed (must-fix).** Statement pattern leaves were dropped from the leaf set, which made `var [a, b] = …` a hard CE (46 failures in the #7106 suite). The leaves are back; for-head identifiers are a separate list (`forHeadDeclarations`).
2. **Fixed (must-fix).** A head named like a top-level function was a hard CE. It is now checked as the `var` statement it is, so it is refused up front (`vardecl-module-storage-unrepresentable`).
3. **Fixed (must-fix).** An ES-module head next to a dynamic `++` was a hard CE. The scripts-only rule now lives in `moduleInitVarList` itself, the one predicate, so the head keeps `for-init-var-kind`.
4. **Fixed.** A `toString` head was claimed and then withdrawn. The head is now bound in the enclosing scope, like a statement `var`, and it claims cleanly.
5. **Fixed.** The test's for-in case now reaches `forin-head-module-var`, through an `any` receiver in a `.ts` file.
6. **Fixed.** Tests were added for a same-named function, a pattern statement next to a head, an ES module with a dynamic update, a carrier initializer, and a `toString` head.
7. **Fixed (nit).** The noise comment on the import specifier is gone.
8. **Fixed (nit).** `moduleInitLeaves` holds leaves only again; for-head declarations have their own function.

Found correct by the reviewer:
- legacy output byte-identical with `experimentalIR: false` on every lane;
- nested and closure-captured heads and `eval` refused up front;
- function-scoped `for` and `for-in` unaffected;
- the for-in check placed correctly.

