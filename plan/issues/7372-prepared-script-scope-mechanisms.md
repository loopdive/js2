---
id: 7372
title: "Prepared IR path: script-scope mechanisms (nested var, block functions, undeclared globals, delete)"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-19
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

### Slice 2 — FunctionDeclaration in a block at script level (planned)

Rule to state and build: ES5 has no block functions; the test262 ES5 files rely on the web-legacy behaviour that
Annex B.3.3 (ES2015) codified for sloppy scripts: the function is hoisted inside its block (callable before its
statement in the block), and when its statement is evaluated the function value is also assigned to a script
`var` of the same name (undefined before). Build the block-level binding only where the function is a direct
callable (no value use); refuse by name a block function used as a value, one in strict code, and one whose name
collides with a lexical binding.

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

## Registry extraction R1 (2026-11-19, move-only; stacked on #7321)

Decided by the C lead with S2 (#7363, eval) and S4 (Fa, function values): one registry for the Prepared
program's source globals, so that the startup-store changes of the three lanes land in one module.

Built (`src/ir/program-source-globals.ts`, new; program-source.ts shrinks by 38 lines):

- `collectProgramSourceGlobals`: the producer's former globals loop, moved. One row per module-init global
  (`isModuleInitGlobalDeclaration`), a repeated `var` one row keyed by its binding id, each with its storage
  (`ModuleBindingGlobal`, `storageType` moved here) and its instantiation. The instantiation is read from the
  startup plan's own `IrModuleInitBindingIntent.initialization` (`undefined-at-instantiation` | `tdz`), not a
  second vocabulary. The TDZ flag global now follows from it: a row is in its TDZ exactly when the plan says
  `tdz` (before: the declaration list's `let`/`const` flag, the same set).
- Not added, by the IR rule (no kind without a user): `function-at-startup`, `on-first-run`,
  `global-object-property`. Not done: keying the repeated-declaration rule by symbol across sources. Its first
  user is S2's eval source. The resolver's `moduleBindingDeclarations` is shared with the ordinary pipeline's
  multi-module compile, so the change belongs in S2's PR, where a test can see it.

Measured:

- Prepared bytes, the #7321 head `dd8e3628` vs this one, 872 programs (every program literal of the #7354 and
  #7372 tests and of prepared-entry/-runtime, each as `.js` and `.ts`): identical (247 binaries, 625 identical
  refusals).
- Gates: typecheck, loc, func (also against `origin/main`), coercion-sites, oracle-ratchet, dead-exports,
  import-cycles; compiler-boundaries inventory valid (new module classified, `owner: 7372`).

### Review round 1 (RV7329, head `4792b8f2`): BLOCKER, addressed

- **Must-fix: not move-only.** The prologue seam (`legalizeDynamicGlobals` storing `undefined` only into the
  rows the plan instantiates as `undefined`) dropped the store into a dynamic `let`. Such a `let` exists: the
  Prepared producer's `numberStorage: "f64"` plus `updateRetypesModuleBinding` gives a `++`/`--` target the
  carrier, e.g. `let x = "a"; x++;`. The lead's decision: keep this PR move-only. The seam and
  `instantiateProgramSourceGlobals` are removed. `legalizeDynamicGlobals` is back to `dd8e3628`, storing into
  every dynamic global it owns. Narrowing that store, if wanted, is a later PR with a pinning test.
- **Should-fix:** `IrProgramSourcePreparation.globals` uses the registry's `ProgramSourceGlobal` (no second
  spelling). A global without a startup binding throws a named `PreparedIrProgramInvariantError` instead of
  `!`.
- **Nits:** D1's doc names the dynamic `let`; the registry exposes `globals` and `byDeclaration` only (the
  internal row type is gone; the instantiation decides the TDZ flag global).
- Prepared bytes vs `dd8e3628`: 886 programs, the 872 above plus the reviewer's four rows and three more dynamic
  `let` programs, each as `.js` and `.ts`, are identical. The reviewer's `dd8e3628` hashes reproduce (`let x =
  "a"; x++;` → `eb4d8edaddca`). The 872-program sample had missed the class because no test program has a
  `++`/`--` on a non-number `let`.
