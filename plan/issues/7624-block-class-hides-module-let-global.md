---
id: 7624
title: "A block-scoped binding (let/const/class/function) is visible outside its block in the enclosing function"
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

# #7624 — block-scoped bindings leak out of their block

Child B of #7620. It covers #7620's gap 2 (`let`/`const`) and the former side finding R3 (a block `class`), widened to
block `function` declarations. The PRV-7620 review found that the earlier hide/expose design left state-machine
residue. This plan replaces it with declaration-keyed slots.

## Problem

Inside a function, a `let`, `const`, `class` or `function` declared in a nested block (a block, a `switch` case, an
`if` arm) must be invisible outside that block. Today, a read or write of the same name elsewhere in the function
reaches the block's binding instead of the outer one (a module `let`/`var`, an import, an enclosing function's
binding).

The function's own top-level bindings and its parameters are not affected.

### Measured

Measured on 2026-11-28 with node v22.23.5, on `ada18e6bb6` (head of PR #7558) and on origin/main `01c9284f78`.

- Single-file rows use `compile`; `m_*` rows use `compileMulti` with dep `export let g = 2;`.
- `ir` is `experimentalIR` on (the default), `off` is `experimentalIR: false`.
- Probes: `.tmp/p7620/{b-cases.mjs,b-ctrl.mjs,rows.mts,rows-node.mjs}` in the c8-7620 worktree.
- Both bases answer identically on every row, and standalone and gc agree. So each cell is one answer for
  standalone/gc × both bases.

**`let`/`const` (part B1).**

| row | program (module `let g = 2` unless noted) | node | ir | off |
| --- | --- | --- | --- | --- |
| `s_let_before` | `const o = g; { let g = 5; r = g; } return o*10+r` | 25 | 5 | 5 |
| `s_var_before` | the same with module `var g` | 25 | 5 | 5 |
| `s_write_before` | `g = 3; { let g = 5; r = g; } return g*10+r` | 35 | 25 | 25 |
| `sw_case_let_early` | `const o = g; switch (r) { case 0: let g = 5; r = g; }` | 25 | 25 | 5 |
| `sw_case_block_early` | `… case 0: { let g = 5; r = g; } …` | 25 | 25 | 5 |
| `sw_case_let_after` | the case `let`, read after the switch | 25 | 25 | 25 |
| `pd_default` | `function m(a = g) { { let g = 5; … } … }` | 25 | 25 | 25 |
| `tdz_inner` | `{ try { r = g } catch { r = 7 } let g = 5; }` (must throw) | 7 | 7 | 7 |
| `tdz_inner_noouter` | the same with no outer `g` | 7 | 7 | 7 |
| `cl_fn_in_block` | `const o = g; { let g = 5; function k() { return g; } r = k(); }` | 25 | throws | throws |
| `cl_arrow_in_block` | `const o = g; { let g = 5; const f = () => g; r = f(); }` | 25 | throws | throws |
| `cm_class_method` | the `s_let_before` body in a class method | 25 | 5 | 5 |
| `iter_outer_read` (per iteration) | `const fs = []; const o = g; for (let i = 0; i < 2; i++) { let g = i + 4; fs.push(() => g); } return o*100 + fs[0]()*10 + fs[1]()` | 245 | throws | throws |
| `iter_fn_decl` (per iteration) | the same, with `function k() { return g; } fs.push(k);` in the loop body | 245 | throws | throws |
| `iter_no_outer_read` (guard) | the same loop, outer `g` read only after the loop | 245 | 245 | 245 |
| `iter_no_outer` (guard) | the same loop with `h`, no outer binding | 245 | 245 | 245 |
| `fnv_no_outer` (block function as a value) | `for (…) { let h = i + 4; function k() { return h; } fs.push(k); } return fs[0]()*10 + fs[1]()` | 45 | 44 | 44 |
| `fnv_outer_after` | the same with outer `let g` and `g`, read after the loop | 245 | 244 | 244 |
| `fnv_call_and_value` | `c = c*10 + k(); fs.push(k);` in the same iteration; `return c*100 + fs[0]()*10 + fs[1]()` | 4545 | 4544 | 4544 |
| `fnv_call_mut_value` | the same with `k` returning `h++` | 4556 | 4567 | 4567 |
| `fnv_identity` | `function k() { return i } fs.push(k)`; `fs[0] === fs[1] ? 1 : 2` | 2 | 1 | 1 |
| `tdz_iter` (TDZ per iteration) | `for (…) { try { k(); } catch { c++; } let h = i; function k() { return h; } } return c` | 2 | 0 | 0 |
| `tdz_iter_after_ok` | the same, then `s = s*10 + k()` after `let h = i + 1`; `return c*100 + s` | 212 | 12 | 12 |
| `sib_value` (sibling read as a value) | `{ function a() { return b; } function b() { return 1; } r = a()(); }` | 1 | 1 | 1 |
| `sib_mutual_loop` (mutual recursion in a loop) | `for (…) { const n = i + 2; function ev(x) { … od(x-1) } function od(x) { … ev(x-1) } s = s*10 + (ev(n)?1:0) + (od(n)?2:0); }` | 12 | 12 | 12 |
| `sib_mutual_values` | `for (…) { const n = i + 2; function a() { return b() + n; } function b() { return n * 10; } fs.push(a); } return fs[0]()*100 + fs[1]()` | 2233 | 2222 | 2222 |
| `m_import_before` | `import { g }`, then `s_let_before`'s body | 25 | 5 | 5 |
| `m_import_switch` | `import { g }`, then `sw_case_let_early`'s body | 25 | 5 | 5 |
| (gap-2 rows of #7620) | two sibling blocks / loop body / TDZ before a block `let` | 25 | 5 / 21 / throws | same |

- On the switch rows, IR on answers correctly in a single file but not through an import. The PRV-7620 reviewer
  reported 0 for a switch shape; I did not get 0 for any switch shape I tried.
- The throwing rows are a TDZ throw: the early read hits the block slot's flag.

**Block `class` and block `function` (parts B2, B3).**

| row | program (module `let g = 2`) | node | ir | off |
| --- | --- | --- | --- | --- |
| `bc_class_after` | `{ class g {} r = 5; } return g*10+r` | 25 | CE¹ | NaN |
| `bc_class_early` | `const o = g; { class g {} r = 5; } return o*10+r` | 25 | CE¹ | NaN |
| `bc_class_used` | `{ class g { v() { return 5; } } r = new g().v(); }` | 25 | CE¹ | NaN |
| imported `let g`, or function-local `let g`, with the block class | | 25 | 25 | 25 |
| `bf_fn_after` | `{ function g() { return 5; } r = g(); } return g*10+r` | 25 | throws | throws |
| `bf_fn_early` | `const o = g;` before that block | 25 | throws | throws |
| control: block function named `h` | | 25 | 25 | 25 |

¹ `IR path failed for <module-init>: module-init: supported binding 'g' has no exact allocator-owned module global`.

**Excluded, with the reason.**

| row | node | measured | why it is not in B |
| --- | --- | --- | --- |
| `gen_early` (generator, read before the block) | 25 | NaN | Separate root, filed as [#7629](7629-generator-block-shadow-hides-module-binding.md). The control `gen_after` (read only after the block) is also NaN, while `gen_noshadow`, `gen_local_outer` and `gen_sibling_blocks` are 25. Native generator lowering spills bindings into name-keyed fields (`spillTypes: Map<string, ValType>`, `generators-native.ts:416`, `:624-709`). |
| `ev_before` / `ev_inside` (direct eval of `g`) | 25 | 5 / 5 | The control `ctl_ev_noshadow` (`eval("g")` of a module `let`, no shadow) throws on every lane. An eval row therefore measures the eval path's own defect, not B, and no B trigger can fix that. B must not break the eval-inline snapshot of `preHoistedLetConstSlots` (`eval-inline.ts:875-902`, `1254-1313`), so B keeps the eval suites in its related-suite list instead. |

### Causes

**B1, `let`/`const`.**

- `hoistLetConstWithTdz` (`src/codegen/index.ts:13407`) claims slots in two passes. Pass 2 runs `walkStmtForLetConst`
  (`:13809`) on nested blocks. For a nested block's declaration whose name no local holds, it allocates a slot and
  flag at function entry and writes `localMap`/`tdzFlagLocals` **by name** (`:14021-14035`).
- That name-keyed entry is live for the whole function, so reads and writes before the block resolve to it.
- Four mechanisms then patch the name-keyed entry back and forth. They are the residue the review asked to remove:
  - `blockOwnPreHoistedNames` (`statements/shared.ts:200`, #6994) keeps block exit from reinstalling it;
  - `reinstallPreHoistedCapturedSlots` (`index.ts:13519`) and the #2814 Bug-C arm (`statements/variables.ts:1979-1995`)
    each re-scan `ctx.nestedFuncCaptures` to decide whether to reuse the slot;
  - the switch `preHoistedBindingIsLive` filter (`statements/control-flow.ts:1552-1575`);
  - the `__tdz_<name>` local-name scan fallback in capture planning (`statements/nested-declarations.ts:1692-1701`).
- For a declaration nobody captures, block entry mints a second slot and the function-entry slot is dead.

**B2, block `function`.** Two defects, partly measured.

- `hoistFunctionDeclarations` allocates the Annex B B.3.3 web-compat outer `var` binding (an externref local plus
  `__tdz_<name>`, `nested-declarations.ts:3376-3390`) by name. This happens in strict module code too:
  `annexBBlockNestedEligible` (`:2777`) has no strictness check, although B.3.3 applies only to sloppy code.
- A throwaway patch on main returned `null` from it in strict code (`isStrictContext`). That removed the local.
  - The outer read still throws, now through the Annex B cancel-site analysis: `annexBReadIsUnbound`
    (`identifiers.ts:1112`), which treats a read outside the block as unbound even though the checker resolves it
    to the module `let`.
  - A fix for that second defect was not tested.

**B3, block `class`.**

- `registerModuleGlobal` (`module-global-registration.ts:203`) gives the module's `let g` no global when
  `isClassOfScope` (`:265`) finds a class `g` in the same file. That class may be block-scoped.
- The module `let` then compiles to a `__module_init` local, and reads see `__class_g` (WAT checked).
- On main the guard is the bare-name `ctx.classSet.has(name)` (`:248`).
- **This part touches #7558's `isClassOfScope`, so B waits for #7558.**

## Implementation Plan

### Design: declaration-keyed block slots, no name-keyed pre-hoist

**Invariant.** A nested-block lexical declaration owns exactly one slot (and flag), allocated at function entry and
recorded only in a declaration-keyed map. Its name enters `localMap` at its block's entry and leaves at its exit,
like any shadow. Nothing name-keyed exists outside the block.

1. **Records.**
   - `walkStmtForLetConst` (`index.ts:13809`) is called by pass 2 for nested blocks. For those declarations it records
     `{ valueSlot, flagSlot }` in `fctx.preHoistedLetConstSlots` and writes no `localMap`/`tdzFlagLocals` entry.
   - Pass 1 (body-level declarations) is unchanged.
   - Because nested names never occupy `localMap`, the `fctx.localMap.has(name)` skip no longer gates nested
     declarations. Every nested declaration, sibling blocks included, gets its own record.
   - The #6994 `reserved` set (`index.ts:13444-13447`) exists only to stop a nested claim from taking a body-level
     function's name, so it is deleted.
   - The record key widens from `ts.VariableDeclaration` to `ts.VariableDeclaration | ts.FunctionDeclaration` for B2,
     and the field is renamed `blockScopedSlots` (`context/types.ts:1217`).
2. **Block entry installs by declaration.**
   - `preallocateBlockScopedSlots` (`index.ts:13472`): for each own declaration with a record, call the existing
     `reinstallPreHoistedLetConstBinding` (`statements/eager-capture-box.ts:90`), which also picks up a #5356 cell.
   - It does this unconditionally. `reinstallPreHoistedCapturedSlots` (`:13519-13552`) and its capture scan are
     deleted, and so is the early-return branch for blocks with a function child.
   - A declaration without a record (`__module_init`, script top level) keeps `walkStmtForLetConst` at block entry.
   - The `switch` path (`control-flow.ts:1552-1575`) applies the same install-by-record rule to case-clause
     declarations, and the `preHoistedBindingIsLive` filter goes.
   - The #2814 Bug-C reuse arm in `compileVariableStatement` (`variables.ts:1979-1995`) is deleted: the slot is
     always already installed.
3. **Block exit** needs no special case. `saveBlockScopedShadowsForNames` restores only real outer entries, so
   `blockOwnPreHoistedNames` (`shared.ts:200-216`) and its `ownPreHoisted` parameter are deleted.
4. **Capture pinning looks up by declaration.**
   - A hoisted nested `function` is compiled at function entry, before its block is entered, so its captures cannot
     come from `localMap`.
   - In capture planning (`compileNestedFunctionDeclarationInScope`, `nested-declarations.ts:1651-1701`), resolve
     `findScopedVariableDeclaration(stmt, name)` (`:1603`) first.
   - When that declaration has a record, take `valueSlot` and `flagSlot` from it. Otherwise fall back to `localMap`
     (body-level bindings).
   - The `__tdz_<name>` local-name scan (`:1692-1701`) is deleted.
   - `emitEagerCaptureBoxes` (`:2823`) keeps minting a body-level declaration's cell at function top, as today.
   - **A nested-block declaration's cell is minted at its block's entry, never at function top.**
     - Inside a loop body, block entry runs once per iteration, so each iteration gets a fresh cell (the spec creates a
       fresh block environment on every evaluation of the body).
     - `iter_fn_decl` and the `fnv_*` rows need this: a block `function k` that captures the body's binding must
       see `4` in the first iteration and `5` in the second.
     - The minting moves into step 2's block-entry install (`reinstallPreHoistedLetConstBinding` gains the "mint the
       cell if the record is captured" arm).
     - `emitEagerCaptureBoxes` skips nested-block records, so no cell for them exists at function top.
     - The hoisted function's capture resolves the record (step 4 above), and its call site forwards the current
       iteration's cell through `eagerCaptureCellForCall` (`eager-capture-box.ts:69`). That helper is already keyed
       by slot.
   - **A block function's closure value is materialized at block entry, beside the cell mint, once per evaluation of
     the block.** §14.2.2 BlockDeclarationInstantiation instantiates a block's function declarations when the block
     is entered.
     - **What today does** (WAT of `fnv_call_mut_value`, `.tmp/p7620/fnv.wat`):
       - the cell `$__boxed_h` is minted once at function top (`local.get 1; struct.new 45; local.set 3`), and each
         iteration only `struct.set`s it;
       - the closure value is memoised once per function in `$__fnmemo_k`. That memo is name-keyed
         (`fctx.nestedFnClosureMemos: Map<funcName, local>`) and built lazily on the first value use by
         `emitMemoizedNestedFnClosure` (`closures/funcref-as-closure.ts:143`).
       - Both pushed values are therefore one object over one cell: 4567 for the mutating row, 1 for the identity
         row.
     - **The change.** At block entry, `preallocateBlockScopedSlots` (`index.ts:13472`) does three things for the
       block's own declarations, in this order:
       1. mint a fresh cell, and a fresh TDZ flag box where the record has a flag, for each nested-block `let`/`const`
          record that a function captures;
       2. install those records (step 2);
       3. build the closure object of each direct-child `FunctionDeclaration` record (B2's declaration-keyed record
          for the block function) that has a non-call reference (the eager-allocation rule below), over the cells and
          flag boxes just minted, and store it in that record's value slot.
     - **Building the closure** reuses `emitMemoizedNestedFnClosure`'s construction sequence: the
       `struct.new` of funcref, arity, bag and captures. It skips the null-memo guard, and the record's value slot
       is the target in place of the name-keyed memo. The construction is split out of the guard, so the guarded lazy
       path (body-level functions) and the eager block-entry path share it; there is no second copy.
       `fctx.nestedFnClosureMemos` stops holding block functions.
     - **Captures of a nested-block declaration by a block function are always by cell**, mutable or not. The
       closure is built at block entry, before the captured `let` is initialized, so a value capture would copy the
       TDZ hole. The cell is read when the function runs. This is the reason `fnv_no_outer` reads 44 today: a value
       capture snapshotted at the first use.
   - **The TDZ flag is per iteration too.**
     - At the same block entry, beside the cell, a fresh #5356 TDZ flag box (`boxedTdzFlags`, the shape
       `emitEagerCaptureBoxes` already builds for flags) is minted for each captured nested-block record that needs a
       flag. Its initial value is 0, uninitialized.
     - The declaration's initialization sets it to 1. The block function's closure, and every direct call, carry the
       current iteration's flag box next to its cell.
     - So a call before `let h` throws in every iteration (`tdz_iter`: 2 throws). Today the flag is set in the first
       iteration and never reset, so it gives 0.
   - **Sibling block functions are read when the function runs, never copied when a closure is built.**
     - A block function that refers to a sibling block function (by call or as a value) captures the sibling's
       record. It captures the record's value slot by cell when the sibling is eagerly allocated (see the
       eager-allocation rule below), or the sibling's own captures when it is call-only.
     - It reads the sibling at the moment it runs. Building closures in source order at block entry therefore never
       copies a sibling that is not built yet.
     - This replaces, for block functions, the "fill the sibling bindings before the guard" step of
       `emitMemoizedNestedFnClosure` (`materializeHoistedFunctionValueBinding`, `closures/funcref-as-closure.ts:744`),
       which copies the value.
     - `sib_value` and `sib_mutual_loop` already pass and stay green.
     - `sib_mutual_values` (2222) fails today because both iterations share one cell of `n`. With per-iteration cells
       and run-time sibling reads it gives 2233.
   - **Eager-allocation rule.** A block function's closure object is allocated at block entry **only if the function has
     a non-call reference**: a read of its name anywhere other than the callee position of a call (pushed, passed,
     returned, stored, compared, `typeof`, or captured as a value by another closure).
     - The same AST pass as byte gate (b) finds these references. It is one scan of the enclosing function, shared,
       not a second walk.
     - A call-only block function gets no closure object: its direct calls pass the current cells and flag boxes, and
       it has no value to build.
     - This keeps allocation where the language needs an object. A loop whose block function is only called pays no
       allocation per iteration, which is the common shape: the `tdz_iter` and `sib_mutual_loop` rows have no
       non-call references.
     - If an implementation finds the rule cannot hold for some shape, it measures the allocation cost (allocations
       and wall time per iteration) on the byte-gate corpus, and justifies the shape in the PR.
   - **How a direct call `k()` and the value `k` share the cell.**
     - The lifted `$k` is compiled once at function entry by `hoistFunctionDeclarations`. Its capture is a cell
       parameter, resolved by declaration (step 4).
     - A direct call `k()` in the block passes the cell that `localMap` holds for the captured name. That is the cell
       installed at this block entry, forwarded by `eagerCaptureCellForCall` as today.
     - The value `k` is the closure object built at this block entry, holding the same cell.
     - So in one iteration the call and the value read and write one cell, and the next iteration gets a new cell and
       a new closure. `fnv_call_and_value` (4545) and `fnv_call_mut_value` (4556) pin this.
   - `iter_outer_read` is the B1 cause inside a loop: the early read hits the block slot's TDZ flag.
     `iter_no_outer_read` already passes, which shows that today's arrow-closure cell is minted at the declaration,
     per iteration. Step 2 must keep that placement for arrows.
5. **B2, block functions.**
   - `annexBBlockNestedEligible` returns `null` in strict code (`isStrictContext`, `src/shared/is-strict-function.ts:103`).
   - In sloppy code the B.3.3 outer binding stays as it is: it is a real var-scoped binding.
   - A strict block function's local (`nested-declarations.ts:3381-3386`) becomes a declaration-keyed record, installed
     at block entry by step 2.
   - **The predicate behind `annexBReadIsUnbound`** (`src/shared/annexb-block-functions.ts:556`, called at
     `identifiers.ts:1112`).
     - `annexBReadIsUnbound` itself is correct: it condemns a read only where `collectAnnexBCancelSites` (`:437`)
       recorded a site.
     - The defect is the site test. Both site pushes (`:474` for a strict block or case function, `:486` for a
       cancelled sloppy one) record a site when `!scopeBindsName(scope, name)` (`:223`). That asks only the function's
       own var scope. A module `let g`, `var g`, or `import { g }` one scope further out is not seen.
     - The exact new predicate: `scopeChainBindsName(scope, name)`, next to `scopeBindsName`. It is true when
       `scopeBindsName` holds for `scope` or any ancestor reached by `enclosingVarScope` (`:180`), up to and including
       the SourceFile.
     - For the SourceFile it also counts import bindings (`ImportClause` name, `ImportSpecifier` name,
       `NamespaceImport` name). `listBindsLexically` (`:94`) does not see those today.
     - Both site pushes use `!scopeChainBindsName(scope, name)` instead of `!scopeBindsName(scope, name)`.
     - `annexBReadEscapesFunctionScope` (`:578`) already does a one-level version of this
       (`scopeBindsName(outerScope, …)`), so it calls the new predicate too. The one-level special case goes.
     - Everything stays in the shared module, so `identifiers.ts` does not grow.
   - Not yet validated by an experiment: the strict-code patch alone left this read throwing. The PR starts by pinning
     `bf_fn_after` / `bf_fn_early`.
6. **B3, block classes.**
   - `isClassOfScope` (`module-global-registration.ts:265`) requires the class declaration to be a top-level statement
     of its source (`classDeclaration.parent === classDeclaration.getSourceFile()`). A block class no longer takes
     the module binding's storage.
   - Identifier reads already pick the module binding through `ctx.oracle.valueDeclarationOf` (`identifiers.ts:1417-1430`
     only takes the class path when the identifier denotes the class).
   - Not measured: whether `classDeclarationMap` keying the nested class by bare name misroutes `new g()` when a
     top-level class `g` also exists. The PR adds that row.

**Pipeline.**

- Legacy only. The IR refuses these bodies (`body-shape-rejected`), except the single-file switch rows, which it
  answers correctly.
- B3's `isClassOfScope` also feeds the IR `<module-init>` storage observation. Once the module `let g` owns its
  global, the CE¹ should disappear; the IR-on rows pin that.

### What it reuses, and what it removes

- **Reuses:** `preHoistedLetConstSlots` (re-keyed), `reinstallPreHoistedLetConstBinding`, `eagerCaptureBoxOf`,
  `findScopedVariableDeclaration`, `saveBlockScopedShadowsForNames`, `isStrictContext`.
- **Removes:**
  - the #6994 `reserved` set;
  - `blockOwnPreHoistedNames` and the `ownPreHoisted` parameter;
  - `reinstallPreHoistedCapturedSlots`;
  - the #2814 Bug-C capture scan;
  - the `preHoistedBindingIsLive` switch filter;
  - the `__tdz_<name>` slot-name scan;
  - the dead function-entry slot per non-captured nested declaration.
- **Duplication:** two copies of the "captured by a plain function, not a CPS function" scan
  (`index.ts:13534-13543`, `variables.ts:1981-1990`) both go away.

### Size: no grant; one extraction from `nested-declarations.ts`

- `nested-declarations.ts` is 4,476 lines at `ada18e6bb6`, with a 4,495 baseline. That is 19 lines of headroom, and the
  file is over the 1,500 threshold, so any growth fails.
- **Extraction:** move the Annex B eligibility helpers (`nested-declarations.ts:2597-2792`, 196 lines) into
  `src/shared/annexb-block-functions.ts` (677 lines → about 860). They are pure AST, `ts` only, and `rg` finds no
  external caller except `annexBBlockNestedEligible`, which the shared module's comments already name. The moved
  functions are:
  - `isAnnexBScopeBoundary`, which is **deleted, not moved**: it is a verbatim duplicate of the shared module's
    `isVarScopeBoundary` (`annexb-block-functions.ts:67`); its six uses call `enclosingVarScope`/`isVarScopeBoundary`;
  - `annexBNameObservedOutsideRange`, `isAnnexBValueReference`, `annexBSameNameDirectFunctionInScope`,
    `annexBSameNameVarOrFunctionInScope`, `annexBBlockNestedEligible`.
- **Expected size:** `nested-declarations.ts` drops to about 4,280 lines, plus one import line, before B's own edits.
  B's edits there are net negative (the `:1692-1701` fallback goes; steps 4–5 add a few lines).
- **Other files:**
  - `index.ts` (14,299 lines) shrinks: `reserved` and `reinstallPreHoistedCapturedSlots` go.
  - `variables.ts` (2,537) shrinks.
  - `control-flow.ts` (1,988) must not grow: the new install call replaces the filter.
  - `statements/shared.ts` (370) shrinks.
  - `module-global-registration.ts` (464) grows by about one line.

### Bytes and compile time

- **gc output changes by design** for any function that has a nested-block lexical declaration claimed in pass 2.
  - Today such a declaration owns a dead function-entry slot plus a second block-entry slot when nothing captures it.
    After B it owns one slot, so locals renumber.
  - This conflicts with the "keep gc output byte-identical" rule for shared code, and **needs the lead's explicit
    sign-off.** The alternative, keeping the dead slot to preserve bytes, is the residue the review forbids.
  - **Gate (mechanical; this exact gate goes to the owner).** For each corpus program, base vs new, gc and
    standalone, per function:
    - **(a) Canonicalise, then diff.** Parse the WAT. Drop every local that no instruction reads or writes. Renumber
      the remaining locals by first definition: first `local.set`/`local.tee`, or first `local.get` for a parameter.
      Then diff the canonical function bodies.
    - **(b) Allowed differences.** After (a), a function may differ only if it has either:
      - an outer reference, meaning a read or write of a name outside a nested block that declares that same name
        (`let`/`const`/`class`/`function`, or a `case` clause);
      - a capture of a nested-block declaration by a function declared in that function.

      The tool decides this from the source AST of that function, the same scan as `.tmp/p7620/yield-scan.mts`,
      extended to captures.
    - **(c) Anything else is a finding.** Any other canonical diff fails the gate and is fixed or explained in the PR
      before merge.
    - (a) absorbs the removed dead slot and the renumbering. (b) admits exactly the functions whose meaning B changes.
- **Corpus, gc and standalone:**
  - the Temporal polyfill (`node tests/dogfood/temporal-polyfill-harness.mjs`);
  - all 285 files of `tests/equivalence/`;
  - test262 `language/block-scope` (145 files) and `language/statements/switch` (111 files);
  - the #7470 389-file single-file sample.
- **Static count, an estimate.** A TypeScript AST scan (`.tmp/p7620/nested-scan.mts`) finds functions with a
  nested-block lexical in 23 of 142 functions in `language/block-scope`, and in none of the 97 functions in
  `language/statements/switch` (their switches sit at script top level). The scan does not parse the programs
  embedded as strings in `tests/equivalence/`, so it gives no count there.
- **Compile time:**
  - B removes two per-declaration scans over `ctx.nestedFuncCaptures`, which are O(declarations × capturers), and the
    O(locals) `__tdz_<name>` scan.
  - It adds O(1) map lookups per capture and per block entry.
  - Expected neutral or faster (an estimate). The PR reports the wall time of the corpus compile, base vs new.

### Order inside B, and the #7558 dependency

| step | parts | depends on | files |
| --- | --- | --- | --- |
| B-1 (option: can land first, from main) | 1–4 (`let`/`const`), the extraction | nothing: #7558 does not touch these functions | `index.ts`, `statements/{shared,variables,control-flow,nested-declarations,eager-capture-box}.ts`, `context/types.ts`, `src/shared/annexb-block-functions.ts` |
| B-2 | 5 (block function) | B-1's records | `nested-declarations.ts`, `src/shared/annexb-block-functions.ts` |
| B-3 | 6 (block class) | **#7558**: `isClassOfScope` exists only there | `module-global-registration.ts` |

All three stay in this one issue. If B-1 lands first, it is one PR against main, and B-2 + B-3 follow after #7558
lands.

### Yield estimate

This is an estimate. A TypeScript AST scan of every test262 file in the standalone baseline (`.tmp/p7620/yield-scan.mts`,
2026-11-27 baseline) looked for a function where a nested-block lexical name is also referenced outside that block
and is not a body-level binding.

- 66 of 48,735 files match. 1 of them fails today:
  `language/statements/await-using/syntax/await-using-outer-inner-using-bindings.js`.
- The direct test262 yield is about 0–1 test. B's value is wrong answers in real code (the Temporal polyfill is the
  gate), not conformance.

### Risks

- **Captured slot timing.** Hoisted-function capture now reads the record before block entry. The #5356 eager cell is
  still keyed by slot, so a call site that forwards the cell (`eagerCaptureCellForCall`) is unaffected.
- **Direct-eval bodies.** `reifyCurrentDirectEvalBindings` and eval-inline snapshot `preHoistedLetConstSlots`. Nested
  names are no longer in `localMap` at function entry, so an eval before the block sees the outer binding, which is
  the correct direction. The eval suites must stay green.
- **Async/CPS capturers.** These were excluded from the old reuse paths (`cpsCaptured`). Block-entry install is now
  unconditional, so the async/generator capture paths (`closures.ts`, `generators-native.ts`) must still find the
  slot through `localMap` inside the block. They are compiled at their textual position, inside the block.

## Acceptance criteria

- **First commit: the red pins.** The PR's first commit adds only `tests/issue-7624-block-scoped-bindings.test.ts`
  with every row below, red where the tables show a wrong answer. Fix commits follow, and each turns its rows green.
- **Pin test (red → green).** `tests/issue-7624-block-scoped-bindings.test.ts` holds every row of the B1 and B2/B3
  tables.
  - It runs single-file rows through `compile` and the `m_*` rows through `compileMulti`.
  - Each row runs × standalone/gc × `experimentalIR` on/off. The IR-on single-file rows are explicit, so an IR claim of
    block bodies is held to the same answers.
  - Each row compares with node and is red on `ada18e6bb6` where the tables show a wrong answer.
  - Extra rows: a top-level `class g` plus a block `class g` in another function; a sloppy-script block function
    (B.3.3 must still apply there: node's answer is the oracle).
  - The excluded rows (`gen_*`, `ev_*`) are not in the pin.
- **Code quality.**
  - The design above holds: nested-block slots are keyed only by declaration, and the name enters `localMap` only
    between block entry and exit.
  - There is no hide/expose state, no name-keyed pre-hoist entry, and no dead function-entry slot or flag.
  - Cells and TDZ flag boxes of nested-block records are minted at block entry, never at function top.
  - Block-function closures are built only under the eager-allocation rule, by the shared construction sequence.
  - Siblings are never copied at closure build.
  - The removals listed above are actually gone, the Annex B duplicate is folded into `isVarScopeBoundary`, and no new
    predicate duplicates an existing one.
  - `check-loc-budget` and `check-func-budget` pass, including with `LOC_GATE_BASE` set to the upstream main tip, with
    no grant.
  - An adversarial review verdict goes in the PR body.
- **Bytes.** The mechanical gate (a)–(c) above passes on the corpus, on gc and standalone. The canonical-diff list is
  attached to the PR, and the lead signs off the byte change.
- **Per-iteration pins.**
  - `iter_outer_read` and `iter_fn_decl` go red → green (245).
  - `fnv_no_outer` (45), `fnv_outer_after` (245), `fnv_call_and_value` (4545), `fnv_call_mut_value` (4556) and
    `fnv_identity` (2) go red → green.
  - `tdz_iter` (2), `tdz_iter_after_ok` (212) and `sib_mutual_values` (2233) go red → green.
  - `iter_no_outer_read`, `iter_no_outer`, `sib_value` and `sib_mutual_loop` stay green.
  - The `tdz_iter*` and `sib_*` rows were measured on `ada18e6bb6` and origin/main `41645f5711`, with identical
    answers on gc and standalone, IR on and off.
  - The `fnv_*` rows were measured on `ada18e6bb6` and origin/main `41645f5711`; both give the "ours" values above.
  - The PRV-7620 reviewer reported 55 for a block-function-value shape. Mine gives 44 for the immutable capture and 67
    for the mutating one; all of them are one shared closure.
- **No test262 regression.** Scoped per-test diff over `language/block-scope`, `language/statements/switch`,
  `language/statements/class` and `annexB/language` on standalone: no pass → fail.
- **Related suites green.**
  - `tests/issue-1177`, `-2641`, `-5221-*` and `-5356-*`.
  - `tests/issue-5271-es2015-statements-r2`, whose one failure (`#5271 F2 … folded constant`) also fails on the base.
  - The eval suites and `node scripts/equivalence-gate.mjs`.
