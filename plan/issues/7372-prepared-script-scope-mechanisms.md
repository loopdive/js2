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
loc-budget-allow:
  - src/ir/program-source.ts
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

Owner: lane S19. Replaces the earlier two-sentence plan for slice 2. Slices 3 and 4 (undeclared writes, `delete`)
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
  cluster cannot pass before nested function declarations do (#7349 S3 territory).
- Script-level building blocks already run: `var x; function g(){return 2} x = g; x()` (F1b's value home + a script
  var), `if (true) { var y = function () { return 2; }; } y()` (slice 1's nested var + a closure literal).

**Yield estimate** (not a build, labelled as such): each script-level block function rewritten in the source as
`var F = function F(…){…};` at its own position (B.3.3's var write, without the block binding) makes **30** global-code
files pass (6 each of `update`, `existing-var-update`, `existing-var-no-init`, `existing-block-fn-update`,
`existing-block-fn-no-init`; the two `switch` forms fail elsewhere). The rewrite cannot model `block-scoping`,
`skip-early-err*` (a `let f` beside it) or `existing-fn-*` (a top-level `function f` beside it); those 8 + 64 + 16
files need the real mechanism and then meet other walls, so the estimate for slice 2a is **30 to 50 files**. The
`init` and `existing-*-global-init` rows (24) read the global object (`fnGlobalObject`, `verifyProperty`), Session B's
area, and stay out. Function-code: **0** before nested function declarations exist; the same rewrite there stops at
`identifier "f" is not in scope` (61), `redeclaration of 'f'` (26), `unexpected statement before tail` (13).

#### Semantics to build (ECMA-262 §B.3.2.1–B.3.2.6; ES5 sloppy code relies on them)

For each FunctionDeclaration *f* named *F* directly in the statement list of a Block, CaseClause or DefaultClause
(and, by §B.3.3, the sole statement of an `if` clause, treated as a block around it):

1. **Block binding (always, sloppy and strict).** *F* is a lexical binding of that block, initialized to a new
   function object when the block is entered (BlockDeclarationInstantiation), before the block's first statement.
   Several declarations of *F* in one block: the last one wins (§B.3.2.4, sloppy only). Inside the block, including
   inside *f*'s own body, *F* reads and writes this binding (`f = 123` in the body changes it, not the var).
2. **Var binding (sloppy only, §B.3.2.1 function / §B.3.2.2 script).** Only when replacing *f* by `var F` would raise
   no early error: no `let`/`const`/`class` *F* in any block from *f*'s block up to the function body or script, nor
   at that top level; a simple `catch (F)` parameter does not block (§B.3.4), a `for (let F …)` head does. Function
   level also skips it when *F* is a parameter name, or `arguments`. When it applies:
   - if *F* is not already a `var`, a parameter or a function declared at that top level, a var binding *F* is
     created at entry with `undefined`;
   - otherwise the existing binding is used, with its existing initial value (`existing-fn-no-init`);
   - **when *f*'s statement is evaluated**, the var binding is set to the block binding's current value.
3. **Strict code:** step 1 only. A read of *F* outside the block resolves to whatever an outer scope binds, or to
   no binding.
4. **Script vs function level.** At script level the var binding is the script var (a global): the slice-1 nested
   `var` home. At function level it is a function-scoped local.

The TypeScript checker binds a sloppy block function to its container: one symbol answers both the block and the var
binding (verified with a scratch program: `f` before, inside and after the block all resolve to the
FunctionDeclaration; a `let g` beside a block `function g` resolves outside the block to the `let`). So which binding
a read means is decided by position, not by symbol: inside *f*'s block (lexically, not under a nested block that
declares its own *F*) it is the block binding; elsewhere it is the var binding.

#### Target structure

- **New module `src/ir/annexb-block-functions.ts`** — pure, backend-independent analysis, asked by both pipelines:
  `blockFunctionBindings(varScope)` answers, for a script or a function body, each block function with its binding
  block, whether the var binding applies (and why not, as a refusal name), and whether it is new or reuses an
  existing `var`/parameter/function. Reads only the AST. It reuses `ast-scope.ts`'s `lexicalDeclarations`,
  `addLexicalNames` and `isFunctionScopeBoundary` (exported for this, not copied).
- **Script var (2a):** a new var binding is one more module-init binding in the slice-1 machinery:
  `moduleBindingDeclarationOrder` (`module-init-vars.ts`) appends the canonical (first) block function of each name
  that needs a new var binding, and the startup plan (`module-init-plan.ts`, beside `nestedVarBindings`) gives it an
  `undefined-at-instantiation` `var` intent. No second var-hoisting mechanism; the home is the existing dynamic
  script-var home (`irOwnedScriptVarHome`).
- **Existing binding reused:** a `var F` keeps its home; a top-level `function F` keeps F1b's value home, which is
  mutable when rewritten. `preparedBindingRewritten` (`module-binding-script-var.ts`) counts a B.3.3 evaluation of a
  same-named block function as a write, which closes the "Annex B block function" route named in that module's H2
  doc; the route's pin in `tests/issue-7354-h2-script-binding-routes.test.ts` changes from refusal to a run.
- **Block binding at script level (2a):** a module-init dynamic home per block function name and block, typed like
  F1b's (`irDynamic(JS_TAG_IDS.Function)` unless rewritten). Script-level code runs once, so a global is exact;
  a block inside a script-level loop body is re-entered and refuses by name in 2a ("block function in a loop body").
- **The function object:** the block function is lowered as the closure literal it is, through the existing
  dynamic-closure route (`resolver.dynamicClosureSignature` → `lowerClosureExpressionWithSignature`), whose literal
  union (`IrClosureLiteral`, `from-ast.ts`) gains `ts.FunctionDeclaration`. Its name is not a self-binding (unlike a
  named function expression): inside the body *F* is the block binding. Step 1 checks that the dynamic-closure
  planner (`source-dynamic-contracts.ts`) admits the declaration the way it admits a function expression; if it does
  not, the extension goes there, not into a copy.
- **Lowering arms (`from-ast.ts`, kept to two calls):** on entering a statement list that declares block functions,
  one call emits each function object into its block home (source order, last wins); the `FunctionDeclaration` arm of
  `lowerBodyStatement` (today the `unsupported body statement` refusal) emits the var write or nothing. Both bodies
  live in a new `src/ir/annexb-block-function-lowering.ts` beside `function-declaration-values.ts`, so `from-ast.ts`
  grows by the two dispatch lines only.
- **Identifier resolution:** the module-init identifier read and write (`identifier-read.ts` classification and the
  module-binding write) ask the analysis which binding a reference to *F* means by position.
- **Function level (2b), after nested function declarations run on the Prepared path:** the same analysis; the block
  binding is a function local (a ref cell when a closure writes it, as captured locals are), the var binding a
  function local created by the existing function-local var model (`function-local-var.ts`). Starts only when
  `function outer(){ function g(){return 2} return g(); }` runs on main. Until then the function-level arm keeps
  aborting by name, with one named reason instead of today's five.

- **Eval code (2c, §B.3.2.3, EvalDeclarationInstantiation), after eval A4 (#7363) runs the literal as a called
  script source.** Lead's note (2026-11-26, from lane S2's census): 93 `annexB/language/eval-code/direct/global-*`
  files and their 90 indirect twins stop at block functions (`f` not in scope ×48, FunctionDeclaration body ×30), so
  about 183 more files ride on this mechanism once eval runs; S2 holds the lists. The same analysis carries it with
  two inputs that differ from a script:
  - **Outer lexical names.** A direct eval's conflict check also walks the caller's enclosing lexical scopes
    (`{ let f; eval('{ function f(){} }') }` creates no var); an indirect eval has none. So `blockFunctionBindings`
    takes the var-scope root plus an "outer lexical names" set, empty for a script, a function body and an indirect
    eval.
  - **When the var binding comes into being.** A script's or function's var exists from entry. An eval's new
    global var exists only once the eval runs: before it, `f` throws ReferenceError and `typeof f` is
    `"undefined"` (`…-skip-early-err*` checks exactly that). The binding is configurable (deletable), unlike a
    script var. So the analysis reports the creation point ("var-scope entry" vs "eval instantiation"), and the
    home of an eval-created global starts in lane S10's absent state (#7372 slice 3's absent marker), which the
    eval's instantiation sets to `undefined`. No third home kind.
  - A direct eval in a function (the `func-*` files, 144) is function level: it waits for 2b as well.

Still refused by name in 2a: a block function in a script-level loop body; a labelled function declaration; a
generator or async function in a block; a block function whose closure the dynamic-closure planner refuses (its own
reason); a script with a `with` or direct `eval` (H2 invariant).

#### Order (small PRs, each with pin tests that fail on main)

1. **2a-1** analysis module + unit tests on the §B.3.2 conditions (no lowering change; every case of the test262
   variants as a pure-AST fixture: `update`, `no-init`, `existing-var/fn/block-fn`, `skip-param`,
   `skip-early-err{,-block,-switch,-try,-for,-for-in,-for-of}`, `no-skip-try`, strict, `if` clause, `switch`).
2. **2a-2** script level: block home + function object at block entry + var write + resolution. Pins: each program
   run through the strict Prepared entry and node, right answer returns, a wrong twin throws.
3. **2b** function level, after nested function declarations land.
4. **2c** eval code, after eval A4 (#7363) and slice 3's absent global; re-measured on S2's 183-file list first.

#### Acceptance

- Correctness: the 2a programs agree with node; every 2a census file either passes or stops at a gap outside this
  slice; no file that passes on main stops passing (re-run the 578-file census, base `c3b7be66` vs head).
- Bytes: JS-environment and ordinary-pipeline output byte-identical on the annexB and `language/statements` files
  (default and standalone, base export vs head).
- Code quality: one analysis module both pipelines can ask; no second var-hoisting or home mechanism (slice-1
  bindings, the script-var home and the closure-literal route are reused); `from-ast.ts` grows by dispatch lines
  only; no loc/func grant, or a dated one the review agrees cannot be split.

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
