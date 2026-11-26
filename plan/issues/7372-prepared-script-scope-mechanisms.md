---
id: 7372
title: "Prepared IR path: script-scope mechanisms (nested var, block functions, undeclared globals, delete)"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-26
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: [7354]
related: [7354, 7106]
# 2026-11-19 (review RV7321b, must-fix 1): src/ir/program-source.ts +1, the producer's filter by the shared
# module-init global rule (`isModuleInitGlobalDeclaration`): an ES module's nested `var` / `for` head is a
# module-init local, not a global. The rule itself lives in src/ir/module-init-vars.ts.
# 2026-11-26 (slice 2a-1): src/codegen/expressions/identifiers.ts +4, formatting only. Its import of the Annex B
# analysis now names the lifted module (src/ir/analysis/annexb-block-functions.ts); the longer path makes prettier
# wrap the one-line import over five lines. No code added.
# 2026-11-26 (slice 2a-2): src/ir/from-ast.ts +16, the dispatch the Annex B lowering needs and nothing else. The
# two steps live in src/ir/annexb-block-function-lowering.ts; from-ast keeps the three call sites (Block entry,
# CaseBlock entry after the discriminant, the FunctionDeclaration arm), the resolver member, the closure-literal
# union member with its invariant, and `annexBHost`, which binds the steps to from-ast's private closure lowering and
# cannot move out. The plan's estimate was +8; the host and the invariant are the difference.
# 2026-11-26 (slice 2a-2): src/ir/program-source.ts +7, the block-function homes beside F1b's function values (the
# plan input, the globals and the lowering field); the homes themselves are src/ir/annexb-block-function-values.ts.
loc-budget-allow:
  - src/ir/program-source.ts
  - src/codegen/expressions/identifiers.ts
  - src/ir/from-ast.ts
---

# #7372 — Prepared IR path: script-scope mechanisms

> Id: #7372, reserved for this lane by the C lead (2026-11-19 14:50Z). The local commits first used #7365, a
> dry-run preview that turned out to be lane S6's reservation; renumbered in the commit that adds this note.

## Problem

Lane S9's census (main `ee3fcdd610`, all 8,717 positive ES5 test262 files through the strict Prepared entry with a
stand-in harness) names four first gaps with no issue, all script-scope / global-object mechanisms that extend
#7354 slice H (the dynamic home of a script `var`):

| first gap | files |
| --- | ---: |
| a `var` nested in top-level code (inside `if`/`for`/`try`/`switch`/block) | 245 |
| a FunctionDeclaration in a block | 69 |
| a write to an undeclared global (sloppy `x = 1`) | 53 |
| `delete` | 37 |

Figures are S9's, not re-measured here (S9's per-label file lists and its Prepared census script are not on its
branch `claude/es5-census-1119` yet, which holds the ordinary-pipeline census only).

## Implementation Plan

Measured on main `ee3fcdd610` (2026-11-19), strict Prepared entry, standalone:

- `if (true) { var x = 1; } if (x !== 1) throw 1;` → `identifier "x" is not in scope in <module-init>`
- `{ function f() { return 1; } } f();` → `unsupported body statement FunctionDeclaration in <module-init>`
- `x = 1; if (x !== 1) throw 1;` → `assignment to undeclared identifier "x" in <module-init>`
- `var x = 1; delete x;` → `delete has no IR lowering in <module-init>`
- `for (var i = 0; i < 3; i++) {} if (i !== 3) throw 1;` already ran (the `for` head was a module-init local).

### Slice 1 — a `var` nested in top-level code

Root cause: the ordinary pipeline already models these `var` lists (`isModuleInitVarList`, #7106 levers L/L2) and
the identity layer already numbers them (`moduleBindingDeclarationOrder` appends them after the top-level
statements' declarations), but the Prepared producer made globals for top-level `VariableStatement`s only, so a
nested `var` fell through to a block-scoped module-init local.

Target structure (no new module; each change sits beside the code it extends):

- `src/ir/program-source.ts` — the producer takes its globals from `moduleInitBindings`, the same per-statement
  list the ordinary pipeline's `buildModuleBindingsMap` (`src/ir/integration.ts`) uses. Removes the producer's own
  hand-rolled top-level `VariableStatement` walk (the duplicate). Patterns still refuse by the existing name.
- `src/ir/module-init-plan.ts` — the startup plan adds a `var` binding (`undefined-at-instantiation`, no TDZ) for
  each nested ordinal `moduleBindingDeclarationOrder` already assigns, so the program input's storage join finds
  the global's startup binding.
- `src/ir/source-dynamic-provenance.ts` — a nested script `var` is the global it is, so its read carries the
  dynamic value when its home is dynamic.
- `src/ir/module-binding-script-var.ts` — the typed home's reads proof accepts a top-level `for (;;)` head, which
  runs once before its own test, body and update and before every later top-level statement; so a top-level loop
  counter stays `f64` instead of becoming dynamic (the dynamic relational operators have no Prepared intrinsic).
- Reused unchanged: H's dynamic home (`irOwnedScriptVarHome`), the D1 carrier, the module-init prologue that
  stores `undefined`, from-ast's module-binding lowering (`bindUninitializedModuleVar`, the global write).

Rule: ES5 §10.5 — every `VariableDeclaration` in the script's code (outside functions) is instantiated on the
global environment with `undefined`, wherever its statement sits.

Still refused by name: a repeated `var` (no single global per name yet, `not-direct`), a `var` redeclaring its
catch parameter (Annex B.3.5), a pattern, a `for-in` head, a `var` in a `with` body.

Code-quality acceptance: no new module and no new predicate; the producer's duplicate top-level walk is replaced by
the shared `moduleInitBindings`; no growth grant.

### Slice 1b — one global per repeated `var` name

A repeated script `var` (`for (var i…) {} for (var i…) {}`) is one binding. The resolver already picks the first
declaration as the canonical identity (`uniqueTopLevelVariableDeclaration`, `allowRedeclaredVar`); the Prepared
home refuses because it requires one declaration. Plan: the home and the producer key by the canonical
declaration; each later declarator maps to the same global entry; the startup plan records no storage for a
redeclaration's ordinal.

### Slice 2 — Annex B block functions (lane S19, plan 2026-11-26)

Owner: lane S19. Replaces the earlier two-sentence plan for slice 2. Revision 2 (2026-11-26) answers plan review PRV-7372s2 (B1–B5, N1–N4), noted inline as [Bn]/[Nn]. Slices 3 and 4 (undeclared writes, `delete`)
stay with lane S10.

#### Measured (main `c3b7be66`, 2026-11-26, real harness, strict Prepared entry, standalone)

Census (`scripts/ir-census/prepared-census.mts --harness real`) on the 578 ES5 files under
`annexB/language/{function,global}-code`, `annexB/language/statements` and `language/statements/{block,function,if,
switch,labeled}`. Abort-body attribution by a scratch probe that matches the trap frame to
`requiredPreparedAbortBodies`. Annex B function-code and global-code pass **0** of 310 today.

| where | first stop | files |
| --- | --- | ---: |
| global-code | compile error `identifier "f" is not in scope in <module-init>` | 64 |
| global-code | compile error `unsupported body statement FunctionDeclaration in <module-init>` | 49 |
| global-code | `direct call to "Function"` 24, other 16 | 40 |
| function-code | trap, abort `identifier "f" is not in scope in <module-init>__closure_N` | 72 |
| function-code | trap, abort `unsupported body statement FunctionDeclaration` | 33 |
| function-code | trap, abort `unexpected statement before tail (got Block …)` 11, `redeclaration of 'f'` 8, `EmptyStatement` 5 | 24 |
| function-code | other | 28 |

Reproduced by hand (same entry, raw source):

- `{ function g() { return 2; } } if (g() !== 2) throw 1;` → compile error `unsupported body statement
  FunctionDeclaration in <module-init>`.
- `function outer() { function g() { return 2; } return g(); } outer();` → abort `nested func must have a return
  type annotation (outer)`. **An unannotated nested function declaration fails on the Prepared path even outside a
  block.** Every function-code file has its block function inside a function (an IIFE), so the function-code
  cluster cannot pass before nested function declarations do (lane S21 builds it as #7492; routed by the lead 2026-11-26, repro sent).
- Script-level building blocks already run: `var x; function g(){return 2} x = g; x()` (F1b's value home + a script
  var), `if (true) { var y = function () { return 2; }; } y()` (slice 1's nested var + a closure literal).

**Yield estimate** (not a build, labelled as such): each script-level block function rewritten in the source as
`var F = function F(…){…};` at its own position (B.3.3's var write, without the block binding) makes **30** global-code
files pass (6 each of `update`, `existing-var-update`, `existing-var-no-init`, `existing-block-fn-update`,

**How to reproduce [N4].**

```bash
npx tsx scripts/ir-census/es5-files.mts            # writes .tmp/ir-census/es5-files.txt (9,174 ES5 files)
grep -E '^(annexB/language/(function-code|global-code|statements)|language/statements/(block|function|if|switch|labeled))' \
  .tmp/ir-census/es5-files.txt > .tmp/annexb-fns.txt  # 578 files
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/annexb-fns.txt --out .tmp/annexb-fns.jsonl --harness real --jobs 4
```

Abort attribution: instantiate as the census does, catch the trap, take the innermost `at <name> (wasm…)` frame and
find the `requiredPreparedAbortBodies(result)` row whose `name` it ends with.

**Yield estimate** (not a build, labelled as such).
- Rewrite rule: in each file of `annexB/language/{function,global}-code`, every FunctionDeclaration whose parent is
  not the SourceFile and not a function body is replaced, in place, by `var F = <its own text>;` (wrapped in `{ }` when
  it is an `if` clause). That is B.3.3's var write at the declaration's position, without the block binding.
- On that rewrite, run through the same entry, exactly these **30** global-code files pass:
  `annexB/language/global-code/{block-decl,if-decl-else-decl-a,if-decl-else-decl-b,if-decl-else-stmt,if-decl-no-else,
  if-stmt-else-decl}-global-{update,existing-var-update,existing-var-no-init,existing-block-fn-update,
  existing-block-fn-no-init}.js`. The two `switch-*` forms of the same variants fail elsewhere.
- What the rewrite cannot model needs the real mechanism:
  - `block-scoping` (8);
  - `existing-fn-*` (16);
  - `no-skip-try` (8);
  - `skip-early-err*` (56).
- `skip-early-err*` passes only if an unbound read inside a closure (`assert.throws(ReferenceError, function () { f;
  })`) throws a catchable ReferenceError at run time. On main that read aborts (`(function(){ zz; })()` → abort
  `identifier "zz" is not in scope`; at top level, a compile error). The catchable throw is lane S10's slice-3
  absent-global read, so 2a does **not** deliver those 56. 2a marks the read as unbound (below) and they pass when
  S10's throw lands.
- **Ceiling for 2a: about 30 + 8 + 16 + 8 ≈ 62, before other walls.** Out of scope:
  - the `init` and `existing-*-global-init` rows (24) read the global object (`fnGlobalObject`, `verifyProperty`);
    that is Session B's area;
  - `script-decl-lex-collision` uses `$262.evalScript`.
- Function-code: **0** before #7492. On the same rewrite it stops at `identifier "f" is not in scope` (61),
  `redeclaration of 'f'` (26), `unexpected statement before tail` (13).

#### Semantics to build (ECMA-262 §B.3.2.1–B.3.2.6; ES5 sloppy code relies on them)

For each FunctionDeclaration *f* named *F* in an Annex B position — directly in the statement list of a Block or
CaseClause/DefaultClause, or the sole statement of an `if` clause (§B.3.3, its own implicit block):

1. **Block binding (always, sloppy and strict).** *F* is a lexical binding of the declaring scope: the Block, the
   whole **CaseBlock** for a clause [B4], or the implicit block of an `if` clause. It is initialized to a new function
   object by BlockDeclarationInstantiation **when that scope is entered**. For a `switch` that is CaseBlock entry,
   before any clause is selected, so `switch (2) { case 1: function f(){} case 2: f(); }` calls *f* [B4]. Several
   declarations of *F* in one scope: the last one wins (§B.3.2.4, sloppy only). Inside the scope, including inside
   *f*'s body, *F* reads and writes this binding.
2. **Var binding (sloppy only).** It applies only when replacing *f* by `var F` would raise no early error:
   - no `let`/`const`/`class` *F* in any scope from *f*'s declaring scope up to the var scope, where a **CaseBlock**
     counts as one scope across all its clauses [B1 bug, see below];
   - no lexical `for`/`for-in`/`for-of` head binding *F* around it;
   - no destructuring `catch` parameter binding *F* (a simple `catch (F)` does not block, §B.3.4);
   - no top-level lexical *F* in the var scope;
   - at function level, *F* is not a parameter name: a parameter skips the **whole** step, both the creation and the
     evaluation write.

   When it applies:
   - **creation:** a new binding, initialized to `undefined` at var-scope entry, unless the var scope already binds
     *F* (a `var`, or a top-level function); then the existing binding and its existing initial value are kept.
     At function level, *F* = `arguments` also creates nothing new, but the evaluation write still happens: it writes
     the `arguments` binding [N1];
   - **evaluation:** when *f*'s statement is reached, the var-scope binding is set to the block binding's current
     value. This write goes to the **var-scope binding by declaration identity**, through the VariableEnvironment,
     never through an ordinary identifier write of *F*. In `catch (f) { { function f(){} } }` an identifier write
     would land on the catch parameter [B3].
3. **Var binding skipped.** A read of *F* outside the declaring scope resolves to whatever an enclosing scope binds,
   or, when nothing binds it, to **no binding**: a ReferenceError, and `typeof` gives `"undefined"`. It is never a home
   that holds `undefined` [B2].
4. **Strict code:** step 1 only, so step 3's "no binding" answer applies outside the scope.
5. **Built-in global names [B5].** At script level, *F* may already be a property of the global object: `Array`,
   `parseInt`, `undefined`, `NaN`, `Infinity`, …. CreateGlobalVarBinding keeps the existing property and its value,
   so a read before the block gives the built-in. For a non-writable property, the evaluation write fails silently in
   sloppy code. Slice 1 has no answer to reuse: `if (1) { var Array; } typeof Array` is a compile error on main,
   `identifier "Array" is not in scope`. So 2a **refuses by name** a block function whose name the realm or the lib
   declares as a global ("Annex B block function shadows the built-in global `F`"). It is the same lib/realm test
   identifier reads already use (`isLibOnlyBinding`, the realm intrinsic catalog). No home is made for it.

**Global-object invariants this slice relies on [N3].**
- The global object stays out of the slice. The H2 invariant (`module-binding-script-var.ts` header) already refuses
  or aborts every route by which it escapes as a value: script or sloppy-function `this`, `globalThis`,
  `Object.defineProperty(this, …)`, `eval`, `Function`, `with`.
- Two consequences on this path:
  - `CanDeclareGlobalVar(F)` is constant true, because the global object cannot be made non-extensible without
    escaping;
  - `HasLexicalDeclaration(F)` sees only the script's own top-level `let`/`const`/`class`, because the harness is
    compiled into the same script.
- The 24 `*-init` files and `script-decl-lex-collision` (`$262.evalScript`) stay out, correctly.

**How a reference to *F* is resolved [B2].** Checker symbol first; position only to split one symbol.
- The TypeScript checker binds a sloppy block function to its container. One symbol then stands for the block binding
  and the var binding (verified: `f` before, inside and after the block all resolve to the FunctionDeclaration;
  next to a `let g`, a block `function g` stays block-scoped).
- When the symbol is anything else (the catch parameter in `catch (f) { … f … }`, a parameter, a `var`, a `let`),
  the reference is that binding, as today.
- When the symbol is an Annex B block FunctionDeclaration *f*:
  - inside *f*'s declaring scope (not under a nearer scope that binds *F* itself) it is the block binding;
  - outside, it is the var binding when step 2 applies;
  - when step 2 is skipped, it is **unbound**: a run-time ReferenceError once lane S10's absent-global read exists,
    and until then a named refusal at select ("read of `F`, which Annex B leaves unbound"). This is legacy's
    `annexBReadIsUnbound` answer, lifted (below). It never reads a home.

#### Target structure

- **Lift, do not copy [B1].** `src/codegen/annexb-cancel.ts` (605 lines) already implements the §B.3.2 conditions as
  pure AST predicates:
  - `annexBDeclaringRange`: Block, CaseBlock, `if` clause;
  - `enclosingVarScope`;
  - `scopeBindsName`, and the private parameter test;
  - `hasInterveningLexicalBinder`, with the loop-head and catch-parameter rules;
  - `collectAnnexBCancelSites` and `annexBReadIsUnbound`;
  - `annexBUpdatesExistingVarBinding`.

  Its only non-`ts` import is `isStrictContext` (`src/codegen/helpers/is-strict-function.ts`); 15 `src/ir` files
  already import from `src/codegen`, so that import is not a new layering edge. Moving the strictness helper to
  `src/shared` is a separate cleanup, which I'll file.

  2a-1 moves the module to **`src/ir/analysis/annexb-block-functions.ts`**, beside `ast-scope.ts`. The legacy callers
  import it from there; there are 8 of them: `annexb-global-live-binding.ts`, `statements.ts`,
  `statements/nested-declarations.ts`, `expressions/identifiers.ts`, `expressions/call-identifier.ts`,
  `function-declaration-observation.ts`, `nested-function-name-scope.ts`, `analysis/mixed-assignment-carrier.ts`.
  The old path is deleted, with no re-export shim.

  The lifted module then gains one entry point for the IR, `blockFunctionBindings(varScope)`. It is built from the
  lifted predicates and returns, per Annex B declaration:
  - its declaring scope;
  - var binding `applies` / `skipped` (with the reason) / `parameter`;
  - var binding `new` / `existing`;
  - the creation point: var-scope entry, or eval instantiation (2c).
- **Legacy bug fixed while lifting [B1].** `hasInterveningLexicalBinder` checks only the declaring clause's own
  statements. A `let F` in a sibling clause of the same CaseBlock is also an early error, because a CaseBlock's
  LexicallyDeclaredNames spans all its clauses. The fix walks the CaseBlock once.
  - It changes legacy output only for programs with that shape.
  - 2a-1 measures the shape over test262 (AST scan) and reports the affected files with their legacy verdicts, base vs
    head, so this is the one deliberate non-byte-identical change. Everything else in legacy stays byte-identical.
- **Reference semantics.** `src/codegen/annexb-global-live-binding.ts` is legacy's §B.3.2.2 script-level mechanism:
  a global seeded from a top-level `function F`, else `undefined`, written at the evaluation point. The IR differs
  deliberately in three places:
  - the IR keeps a separate block binding, so the evaluation write copies the block binding's **current** value
    (`block-scoping`: `f = 123` inside the block before the write), where legacy stores the declaration's closure;
  - the IR instantiates at CaseBlock entry;
  - the IR refuses built-in names, where legacy widens or skips by global type.
- **Script var (2a).** A new var binding is one more module-init binding in the slice-1 machinery:
  - `moduleBindingDeclarationOrder` (`module-init-vars.ts`) appends the first block function of each name that needs a
    new var binding;
  - the startup plan (`module-init-plan.ts`, beside `nestedVarBindings`) gives it an `undefined-at-instantiation`
    `var` intent;
  - the home is the existing dynamic script-var home (`irOwnedScriptVarHome`).

  No second var-hoisting mechanism.
- **Existing binding reused.** A `var F` keeps its home. A top-level `function F` keeps F1b's value home, which is
  mutable once rewritten. `preparedBindingRewritten` (`module-binding-script-var.ts`) counts an Annex B evaluation
  write of that binding as a write. That closes the "Annex B block function" route its H2 header names, and the
  route's pin in `tests/issue-7354-h2-script-binding-routes.test.ts` moves from a refusal to a run.
- **Block binding at script level (2a).** One module-init dynamic home per declaring scope and name, typed like F1b's.
  Script-level code runs once, so a global is exact. A declaring scope inside a script-level loop body is re-entered,
  so it refuses by name ("Annex B block function in a loop body").
- **Function object.** Lowered as the closure literal it is, through the existing dynamic-closure route
  (`resolver.dynamicClosureSignature` → `lowerClosureExpressionWithSignature`); `IrClosureLiteral` gains
  `ts.FunctionDeclaration`. Its name is no self-binding: inside the body, *F* is the block binding. The planner
  extension, if one is needed, goes into `source-dynamic-contracts.ts`, not into a copy.
- **Lowering [B3, B4]** lives in a new `src/ir/annexb-block-function-lowering.ts`, beside
  `function-declaration-values.ts`, with two entry points:
  - `instantiateBlockFunctions(scopeNode, cx)` runs on entering a declaring scope: a Block, a CaseBlock (before the
    discriminant dispatch, so every clause sees the functions), or an `if` clause's implicit block. It stores each
    function object in its block home, in source order, last wins.
  - `evaluateBlockFunction(decl, cx)` is the `FunctionDeclaration` arm of `lowerBodyStatement`. It writes the
    var-scope home named by the declaration's identity (from `blockFunctionBindings`, never an identifier lookup of
    *F*), or emits nothing when the var binding is skipped.
- **`from-ast.ts` budget [N2].** The file is at its ceiling (17,340 = baseline). The changes there are:
  - three dispatch calls: Block entry, the CaseBlock entry in `lowerSwitchStatement`, and the FunctionDeclaration arm,
    which replaces the current `demoteToLegacy` lines;
  - one union member.

  Nothing in `from-ast.ts` can move out to pay for them: its nested-function code is #7492's to change. So 2a-2
  adds a dated `loc-budget-allow: src/ir/from-ast.ts` grant to this issue's frontmatter for **≤ +8 lines**, with that
  reason, and the review checks the count.
- **Identifier resolution.** The module-init identifier read and write (`identifier-read.ts` classification, and the
  module-binding write) ask `blockFunctionBindings` only when the checker symbol is an Annex B block declaration.
- **Function level (2b), after #7492.** The same analysis.
  - The block binding is a function local: a ref cell when a closure writes it.
  - The var binding is a function local of the existing function-local var model (`function-local-var.ts`).
  - A parameter skips everything; `arguments` gets the write without a creation [N1].
- **Eval code (2c, §B.3.2.3), after eval A4 (#7363), slice 3 (absent global) and slice 4 (`delete`).** Its own PR
  sequence; 2a does not wait for it. Review findings C1–C6 answered inline.
  - **List [C6].** Lane S2 measured it on main `c3b7be66` with the real harness, over all 469 files in
    `annexB/language/eval-code/{direct,indirect}`. These are the files whose first stop is the eval refusal:
    - 90 `annexB/language/eval-code/{direct,indirect}/global-<P>-eval-global-<S>.js` in each directory, where
      - P ∈ {block-decl, if-decl-else-decl-a, if-decl-else-decl-b, if-decl-else-stmt, if-decl-no-else,
        if-stmt-else-decl};
      - S ∈ {block-scoping, existing-block-fn-no-init, existing-fn-no-init, existing-fn-update, existing-var-no-init,
        existing-var-update, no-skip-try, skip-early-err, skip-early-err-block, skip-early-err-for,
        skip-early-err-for-in, skip-early-err-for-of, skip-early-err-switch, skip-early-err-try, update};
    - plus `direct/{block-decl,switch-case-decl,switch-dflt-decl}-nostrict.js` and
      `direct/var-env-lower-lex-catch-non-strict.js`.

    The glob is the list, so the 184 files can be regenerated from this text. The ~183-file yield is S2's estimate,
    conditional on A4 and slice 3, and is re-measured before 2c starts.
  - **Var-binding test [C1, C2]** (§B.3.2.3 step 1.b, bindingExists):
    - *F* must not be bound by **any** declarative environment between the eval and its var environment (HasBinding):
      `let`/`const`/`class`, a lexical `for` head, an outer block function's block binding
      (`{ function f(){} eval('{ function f(){} }') }` creates no var), or a class's inner name binding. Only a
      catch-clause parameter is exempt (§B.3.4).
    - The set is "every name bound in the intervening scopes, minus catch parameters". It comes from the lifted
      analysis's existing scope walk (B1), extended to count block functions and class names; there is no new walk.
    - When the var environment is the global one (an indirect eval, or a direct eval at script level),
      HasLexicalDeclaration(*F*) applies as well: the script's top-level `let`/`const`/`class` *F* blocks the var. An
      indirect eval's set is not empty: it is that global check alone.
  - **Creation [C3].** CreateGlobalVarBinding(*F*, true) runs when the eval runs. If *F* already exists — an earlier
    script `var` or function, or an earlier run of the same eval (a loop) — it is a no-op and the **current value is
    kept**. Only when the home is in S10's absent state does instantiation set it to `undefined`. The home starts
    absent only for a name nothing else declares.
  - **Configurable [C4].** An eval-created global is deletable. `delete F` on it is slice 4's path, so 2c is ordered
    **after slice 4**. Until then, any 2c draft refuses `delete` of an eval-created name by name.
  - **H2 invariant change [C5].** Today the H2 header (`module-binding-script-var.ts`) makes a script with a direct
    `eval` decline. 2c changes it in one stated way:
    - a literal eval that A4 compiles is a known writer: `preparedBindingRewritten` counts the Annex B evaluation
      writes inside its text (the `existing-var-*` / `existing-fn-*` eval files), through the same block-function
      identity as 2a;
    - a non-literal eval still makes the script decline.

    The header and `tests/issue-7354-h2-script-binding-routes.test.ts` get the new route.
  - The direct `func-*` eval files (144) are function level and also wait for 2b.

Still refused by name in 2a:
- a block function in a script-level loop body;
- a labelled function declaration;
- a generator or async function in a block;
- a built-in global's name [B5];
- a read Annex B leaves unbound, until S10's throw exists [B2];
- a block function whose closure the dynamic-closure planner refuses (its own reason);
- a script with `with` or direct `eval` (H2).

#### 2a-1 CaseBlock shape list (fixed before the move, main `c3b7be66`, 2026-11-26)

Reviewer check (a): the list is fixed before any code moves.
- Method: an AST scan of every test262 file containing `switch` (444 files). The old rule is legacy's
  `hasInterveningLexicalBinder` / `annexBReadIsUnbound` as on main. The new rule treats a CaseBlock as one lexical
  scope across all its clauses. A file is listed when the two disagree for a function declaration or a read.
- Result: **24 files, all function declarations, no reads**. Every one is a negative syntax test:
  `language/statements/switch/syntax/redeclaration/{async-function,async-generator,class,const,function,generator,
  let}-name-redeclaration-attempt-with-*.js`, the 24 that pair a lexical name with a function form in sibling
  clauses. They expect an early SyntaxError.
- No annexB file changes.
- Legacy bytes must be identical everywhere else. For the 24, the verdicts are compared base vs head.

Reviewer check (b), for 2a-2: a `switch` evaluates its discriminant first, then runs BlockDeclarationInstantiation
for the CaseBlock, then dispatches to a clause. `instantiateBlockFunctions` runs between the discriminant and the
dispatch.

`blockFunctionBindings` lands in 2a-2 with its first caller, so 2a-1 exports nothing unused (dead-exports gate).

#### Order (small PRs, each with pin tests that fail on main)

1. **2a-1. Lift [B1].**
   - Move `annexb-cancel.ts` to `src/ir/analysis/annexb-block-functions.ts`, fix the CaseBlock rule, and add
     `blockFunctionBindings`.
   - Unit tests on the §B.3.2 conditions, one pure-AST fixture per test262 variant: `update`, `no-init`,
     `existing-var/fn/block-fn`, `skip-param`, `skip-early-err{,-block,-switch,-try,-for,-for-in,-for-of}`,
     `no-skip-try`, strict, `if` clause, `switch` with a sibling-clause `let`, and `arguments`.
   - Legacy: byte-identical on the annexB / `language/statements` corpus, except the measured CaseBlock-shape files.
2. **2a-2. Script level.** Block homes, CaseBlock and block instantiation, the evaluation write by identity, symbol-first
   resolution, and the named refusals.
   - Pins: each program run through the strict Prepared entry and through node; the right answer returns, a wrong
     twin throws.
   - Pins include `switch (2) { case 1: function f(){} case 2: f(); }`, `catch (f) { { function f(){} } }` reading
     `f` inside and after, and `block-scoping`'s reassignment.
3. **2b.** Function level, after #7492.
4. **2c.** Eval code, after eval A4 (#7363), slice 3 (absent global) and slice 4 (`delete`). Re-measured on the C6 list
   first. If it grows, it moves to its own plan; 2a is released independently.

#### Acceptance

- **Correctness.** The 2a programs agree with node. Every 2a census file passes or stops at a gap outside this
  slice. No file that passes on main stops passing: re-run the 578-file census, base `c3b7be66` vs head.
- **Bytes.**
  - JS-environment and ordinary-pipeline output are byte-identical on the annexB and `language/statements` files,
    default and standalone, base export vs head.
  - The single exception is 2a-1's measured CaseBlock-shape list, with legacy verdicts compared.
- **Code quality.**
  - One Annex B analysis module, lifted from legacy and used by both pipelines; no second copy of any §B.3.2
    predicate.
  - No second var-hoisting or home mechanism.
  - `from-ast.ts` grows by at most the granted 8 dispatch lines.
  - The lowering lives in its own module.

### Slice 3 — sloppy write to an undeclared name (planned)

PutValue on an unresolvable reference in sloppy code creates a global object property. Plan: the name gets a
dynamic home like a script `var` but with no instantiation-time binding: its carrier starts as an "absent"
marker, a read of an absent name throws ReferenceError (catchable through slice X's throw), `typeof` answers
`"undefined"`; a write stores the value. Strict code refuses by name.

### Slice 4 — `delete` (planned)

`delete x` of a script `var` answers `false` and leaves it (non-configurable); of an undeclared global created by
slice 3 answers `true` and makes it absent again; `delete` of a literal or other non-reference answers `true`
after evaluating it. A member `delete` is a named refusal unless slice O's objects are on the base.

## Slice 1 result (2026-11-19, local, not pushed)

- Proving programs run: `if (true) { var x = 1; } if (x !== 1) throw 1;` returns and `x !== 2` throws;
  `if (false) { var y = 1; } if (y !== undefined) throw 1;` returns.
- `tests/issue-7372-nested-script-var.test.ts`: 18 programs, each run twice through the strict Prepared entry with
  node's verdict asserted on the same source (right answer returns, wrong throws); 4 named refusals.
- `tests/issue-7354-h2-hoisted-var-declaration.test.ts` pins updated: the script-loop repeated `var` now refuses as
  `not-direct`; the script-loop var read by a function now runs (`r === 5`, node agrees).
- Mutation check: 5 mutants (producer back to top-level only; plan drops one nested binding; provenance ignores
  nested vars; no typed `for` head; `for` head proof ends at the loop's end), all killed.
- Ordinary-pipeline bytes: 100 test262 files with nested `var`s × default and standalone, against an `origin/main`
  export: identical (176 binaries, 24 identical compile errors).
- Gates: typecheck, loc, func (also against `origin/main`), coercion-sites, oracle-ratchet, dead-exports.
- Census re-run on S9's 245 files (S9's `prepared-census.mts --harness stand-in`, this tree): **0 files move**;
  all 245 still stop at `module-init unit contains a nested var declaration`. That label is not what slice 1
  built: it is raised for a `var` list the module-init does NOT model. Classified by construct: 188 a top-level
  `for (var k in …)` head, 47 a `var` in a `with` body, 8 both, 1 a `for-of` head, 1 a catch-parameter
  redeclaration. Slice 1 fixed the modelled lists (block/branch/loop/`try`/`switch` bodies), which the census
  counted under no label of its own.
- Consequence for the label: `for-in` itself has no Prepared lowering (`function f(){ for (var k in [1,2]) {} }`
  → `dynamic for-in runtime is unavailable`), and 25 of the first 40 files iterate an object (`newObj`), so the
  188 need slice O's objects plus a for-in enumeration runtime, not a script-scope change. Modelling the head
  `var` as a script global is a few lines once that exists. `with` (55) stays deferred.
- The other three lists (S9 @ `54d5a075`) carry one first-gap detail each: block FunctionDeclaration 69
  (`unsupported body statement FunctionDeclaration`), undeclared global 53 (42 `assignment to undeclared
  identifier`, 11 compound assignment), `delete` 37 (`delete has no IR lowering`). Slices 2–4 not started.

## Slice 1b result (2026-11-19, local, not pushed)

Built (no new module; one shared predicate replaces the home's own declaration count):

- `scriptVarDeclarations` (`src/ir/module-init-vars.ts`): every declarator of a script `var` name in source
  order, when each is a module-init binding's own; `undefined` when any declaration is something else (a
  function, a lexical, an ambient, a JS property declaration such as `Object.defineProperty(o, …)`). The first is
  the canonical identity, as the resolver's `uniqueTopLevelVariableDeclaration` already picks it.
- The home (`irOwnedScriptVarHome`) asks it instead of counting declarations itself, and answers only for the
  first declarator.
- The startup plan (`module-init-plan.ts`, two extracted helpers `redeclaredScriptVarOrdinal` and
  `nestedVarBindings`, which also keep `buildIrModuleInitPlan` under its function budget) records no binding for a
  later declarator; its statement's evaluation names the first declarator's global.
- The producer maps every declarator to the first one's global entry.

Measured:

- `tests/issue-7372-nested-script-var.test.ts`: +9 programs for repeated `var`s (both run, node agrees), 30 tests.
  The test helper tolerates the checker's `Subsequent variable declarations must have the same type` on legal JS
  (`var x = 1; var x;`), which does not stop the compile.
- Pins moved into this file: H's "declared twice", VG's "declared twice", H2's two script repeats.
- S9's repeated-var list, stand-in census on this tree: all **195** real repeated-`var` files get past the gap
  (S9 reproduced it on `2c3a877c`). An earlier figure here, 243/255, was 255 files minus the 12 still at
  `not-direct`; S9's AST check found 60 of the 255 rows to be false hits. The 12 dropped are not repeated vars.
  Earlier wording for the record: 12 still stopped
  at `not-direct`. None of the 12 is a repeated `var`: 8 are `Object.defineProperty(props, …)` (a JS property
  declaration, kept as slice O's named gap) and 4 are `this.x = 1` (the global object as `this`, slice C).
  The other 243 move on to: `unknown class` (Test262Error, slice C) 107, an object/array literal initializer with
  no carrier (slice O) 58, closures (Fa) 15, a direct call with no AST-site plan 10, RegExp crash (#7364) 8,
  postfix/prefix update 14, and smaller ones.
- Mutation check: 5 mutants. Killed: home answering a single declaration only; the plan keeping a nested or a
  top-level redeclaration's binding; the predicate ignoring a non-var declaration (killed by H's
  `Object.defineProperty` refusal). Survivor, with its reason: the redeclarator's evaluation naming its own
  ordinal instead of the first one's. Evaluation binding ids are read only by the source-map validator, and the
  Prepared entry refuses source maps today.
- Ordinary-pipeline bytes: 160 files (the 100 above + 60 of S9's repeated-var list) × default and standalone,
  against an `origin/main` export: identical (296 binaries, 24 identical compile errors).
- Prepared tests (#7188, every #7354 file, prepared-entry/-runtime, this issue): 733/733. Vitest exits 1 on one
  worker RPC timeout under CPU load, not a test failure.
- Gates: typecheck, loc, func (also against `origin/main`), coercion-sites, oracle-ratchet, dead-exports.

## Review round 1 (RV7321b, head `2c3a877c`): BLOCKER, addressed

- **Must-fix 1, ES-module regression.** An ES module with a top-level `for (var …)` head refused (`not-direct`)
  where the base ran it: the producer walked `moduleInitBindings`, which lists a `for` head in every source,
  while the resolver makes it a global only in a script. Fix: ONE rule, `isModuleInitGlobalDeclaration`
  (`module-init-vars.ts`), which the resolver's `isModuleBindingDeclaration`, the startup plan's
  `nestedVarBindings` and the Prepared producer all ask; no per-caller `isExternalModule`. Measured base vs head
  through the strict entry (`test.mjs`): the reviewer's three programs return again, and a nested `if` var and a
  repeated `var` in a module refuse as on the base. An ES-module nested `var` pattern, which crashed the base with
  an invariant (`module-init var leaf 'a' has no slot its value fits`), now refuses by name. Pinned: 3 ES-module
  run programs and the pattern refusal.
- **Should-fix 2, duplicate redeclaration rule.** `scriptVarDeclarations` is gone. The resolver exports
  `moduleBindingDeclarations` (its own declarators in source order, which `uniqueTopLevelVariableDeclaration` now
  reads); the home and the plan ask it. The home keeps only its own stricter rule, that a JS property declaration
  (`Object.defineProperty(o, …)`) leaves the binding without a home.
- **Nits.** The producer keys entries by `globalBindingId` in a `Map` (no linear `find`); the plan computes the
  redeclared ordinals once per source (`redeclaredScriptVarOrdinals`, one map lookup per declarator); `const list`
  moved below the early return.
- Mutation check of the fix: the producer without the filter, and the plan without it, are both killed by the
  ES-module pins. A third mutant (the plan's "no lexical among the declarators" check) survived because
  `let x; var x;` is an early error the entry refuses first, so the check was removed as unreachable.
- Ordinary-pipeline bytes, base vs head: 220 files (the 160 above + 60 ES modules flagged `module` that contain
  `var`, compiled as `test.mjs`) × default and standalone: identical (440 compiles).
