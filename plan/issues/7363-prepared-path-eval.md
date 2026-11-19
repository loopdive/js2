---
id: 7363
title: "Prepared IR path: eval — a named refusal first, then literal direct eval as a certified nested program"
status: in-progress
assignee: ttraenkler/c-lead
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7354, 7106, 7345, 3630]
# 2026-11-19 (review RV7310, round 2): the realm-eval proof is dropped. from-ast +3 lines, all in lowerCall: the
# Prepared refusal, which asks the lexical walk `resolvesToSourceBinding` (src/ir/analysis/ast-scope.ts).
# 2026-11-19 (slice A, A1): +1 line each in program-physical-plan.ts and ir-program-presentation.ts, the import of
# `runsAtStartup` (module-init-plan.ts), the one predicate both startup consumers ask; no logic grows there.
# 2026-11-19 (slice A, A2): the literal-eval relation is new code in src/ir/eval-literal.ts; the seams only carry it.
# program-source.ts +6: the input field, the receipt call, `called` for buildIrModuleInitPlan and the resolver
# capability. compiler.ts +4: the field passes from the Prepared pipeline input into `preparation`. from-ast +5 in
# lowerCall: the site's label asks the capability.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/program-physical-plan.ts
  - src/compiler/ir-program-presentation.ts
  - src/ir/program-source.ts
  - src/compiler.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerCall
import-cycles-allow:
  - ir->frontend: 10 # 2026-11-19 (#7363 A2): src/ir/eval-literal.ts asks the shared pure eval syntax in src/frontend/eval/ (parse, static SyntaxError, declared names), the one copy both pipelines ask, as the plan's "Reused" list says
---

# #7363 — `eval` on the Prepared IR path

## Problem

`eval` is the fourth foundation the IR migration builds before narrow slices (CLAUDE.md, "IR migration:
foundations first"). On the Prepared whole-program path (`TEST262_COMPILER_PATH=ir`, front door
`wholeProgram: { kind: "prepared-program-required" }`), every eval statement crashed compile() with an invariant
error: `ir/from-ast: certified global eval lost an owning predicate`.

- S9's Prepared stand-in census (main `ee3fcdd610`, 8,717 positive ES5 files) counts 195 files that crash this way.
- A further 96 files have an eval refusal as their first gap (#3630).

Cause: `lowerCall` (`src/ir/from-ast.ts`) treats any `exactGlobalEvalStatement` shape as certified. On the
ordinary pipeline, the selector's `certifiedGlobalEval` certifies such a statement before from-ast sees it. The
Prepared path shares only `lowerFunctionAstToIr`, not the selector. Its resolver has neither `globalEvalTarget` nor
`isAmbientBinding`, so every eval statement, even one whose `eval` is a parameter, fell into the invariant.

## Measured (2026-11-19, main `ee3fcdd610`)

**(a) The prelude.** None of the default includes (`assert.js`, `sta.js`, `propertyHelper.js`, `compareArray.js`)
calls `eval`. `fnGlobalObject.js` calls `Function("return this;")()`. `eval` matters to the prelude only as a name
in the built-in globals list.

**(b) ES5 files by eval shape.** A TypeScript AST scan of all 9,174 ES5-classified test262 files
(`classifyEdition`) finds 1,214 that contain dynamic code; 47 of them are negative tests. Files per shape (one file
can have several):

| shape | files |
| --- | ---: |
| direct `eval("…")` of a string literal, statement position | 345 |
| `Function(…)` | 202 |
| `with` | 201 |
| indirect: `(0, eval)(…)`, `(eval)`, `x.eval(…)` | 183 |
| direct `eval("…")` of a literal, expression position (`var r = eval("…")`) | 126 |
| `eval` used as a value (aliased, passed, compared) | 117 |
| direct `eval(s)` of a computed string, statement position | 88 |
| direct `eval(s)` of a computed string, expression position | 9 |
| literal eval where `eval` may be shadowed | 8 |

473 files use only literal direct eval. Their literal sources:

| content | files |
| --- | ---: |
| statements (`if`, `for`, `throw`, …) | 200 |
| declarations (`var` / `function`) | 127 |
| expressions only | 112 |
| declarations with an inner `"use strict"` | 24 |
| anything else | 10 |

By position, about 280 of these eval sites sit at top level and about 190 inside functions; about 25 are in
strict code.

**(c) What the ordinary pipeline already has.**

- Pure syntax: `src/eval-call-shape.ts` (`exactGlobalEvalStatement`). The Prepared path uses it already.
- Static early errors of a literal eval: `src/codegen/expressions/eval-early-errors.ts` (`foldedEvalEarlyError`,
  `evalCallerCapabilities`). It imports only `ts` and a directive helper, so it is pure, but it lives under
  `codegen/`. The IR may not import from there.
- `src/codegen/expressions/eval-script.ts` (`parseEvalScript`, `foldedEvalStaticSyntaxError`): pure except for a
  `CodegenContext` used for strictness.
- `src/codegen/expressions/eval-inline.ts` (2,217 lines; `tryStaticEvalInline`, `foldedEvalDeclarationNames`):
  legacy compile-time inlining of literal eval. It is codegen-bound (`CodegenContext`, `FunctionContext`, hoisting
  into legacy locals), so it is not reusable as is. Its declaration-name walk is the reusable part.
- The runtime-eval provider (`src/codegen/expressions/runtime-eval-provider.ts`, `linkRuntimeEvalGlobalEval`):
  legacy codegen linking a runtime evaluator, and the #7106 A2c global-eval arm. Not reusable on the Prepared
  path; a computed-string eval needs a Prepared-native provider of its own (a later slice).

## Implementation Plan

Target structure: the Prepared path decides eval in the IR front end (`from-ast`) through the resolver's eval
capability, never through codegen. The pure literal-eval analysis (parse, early errors, declaration names) moves
to one shared module both pipelines ask, instead of a second copy.

### Slice 1 — the invariant becomes a named refusal (this PR)

- Slice 1 asks one LEXICAL question: does the source itself bind this `eval`? `resolvesToSourceBinding`
  (`src/ir/analysis/ast-scope.ts`) walks the enclosing scopes on the file's existing scope collectors, with
  hoisting. It needs no checker. The forms it covers:
  - `var`, including its binding patterns;
  - function declarations, including block functions (Annex B.3.3 hoists them in sloppy code, so the walk leans
    to "bound");
  - `class`;
  - parameters, including patterns and defaults;
  - `catch` bindings, including patterns;
  - `let`/`const` in blocks, switch cases and loop heads;
  - imports;
  - the own name of a named function or class expression.
- `lowerCall`: on a resolver with a provider (the ordinary pipeline), the certified-eval branch and its invariant
  are unchanged. Otherwise:
  - an eval statement whose `eval` the source does not bind refuses by name:
    `ir/from-ast: eval statement has no eval provider in <fn>` (`call-resolution-unsupported`);
  - a bound `eval` is an ordinary callee.
- Not slice 1's question: whether the global `eval` still holds the realm's %eval% when the call runs. That is
  answered at run time (slice 2). A static whole-program "never rebound" proof was tried and dropped at review
  RV7310: JavaScript can rebind the global by too many routes (destructuring, computed keys, `defineProperty`,
  `Function`, another file), and the real harness prelude uses `globalThis`.
- Proving program: `tests/issue-7363-prepared-eval-refusal.test.ts`.
  - Literal, in-function, computed and `(0, eval)` statements refuse by name through the strict entry.
  - Every shadow form above stops at its own first gap, asserted by message.
  - A non-lexical rebinding (`globalThis.eval = f`, `this.eval = f`) still refuses as eval.
  - A direct table of `resolvesToSourceBinding` over each declaration form.
  - The ordinary pipeline's invariant still throws when a provider-bearing resolver disagrees.
- Quality criterion: no second scope walk. The question extends `ast-scope.ts`'s collectors, and slice 2 asks the
  same predicate.

### Slice 2 — direct literal eval behind a run-time %eval% identity test

- A direct eval is `eval(…)` whose callee VALUE is %eval% (§13.3.6.1), which is a run-time fact.
- Each admitted site does three things:
  - it reads the global binding `eval` (`dyn.member_get(dyn.global_object, "eval")`, lane S5's global object,
    `NATIVE_REALM_GLOBALS` row %eval%, PR #7315);
  - it compares that value by reference with the realm intrinsic %eval%: `js.value.strict_eq` against a B2b realm
    intrinsic (lane S5, branch `claude/7350-b2b`; working name `js.realm.intrinsic`);
  - if they are equal, it runs the precompiled literal text; if not, it makes an ordinary call of that value.
- Sound against every rebinding route, and it works under the real prelude. Until the realm intrinsic exists,
  slice 2 stays refused by name.
- The precompiled text has two forms:
  - a literal that is a static SyntaxError (`foldedEvalStaticSyntaxError`, `src/frontend/eval/script.ts`) throws
    a SyntaxError at run time at the site, never at compile time;
  - a top-level sloppy literal is a called script source of the program (Slice A below).
- Proving program: each form checked against node (the right answer returns, a wrong one throws), plus a rebound
  `eval` taking the ordinary-call arm.
- Acceptance (review RV7310 should-fix): the identity test reads the callee through the real environment chain, not
  through slice 1's lexical answer. An `eval` that slice 1 calls unbound is not therefore %eval%:
  - `eval("var eval = g"); eval("1")`: an earlier sloppy direct eval declared a var `eval`, so the second call is an
    ordinary call of `g`;
  - `with (o) { eval("1") }`: an `eval` property of `o` is the callee;
  - `eval("1"); { function eval() {} }` (Annex B lean): slice 1 treats `eval` as bound. The answer must match node
    in sloppy and in strict code.

### Later (own slices, measured first)

- Expression-position literal eval (126 files): the completion value as the call's result.
- Indirect eval (183 files): global scope, same nested program.
- Computed-string eval (97 files): needs a Prepared-native runtime provider.
- `Function(…)` (202 files) and `with` (201 files): separate foundations.

## Acceptance criteria

- Slice 1: no Prepared compile throws "certified global eval lost an owning predicate"; the 195 files report the
  named refusal instead. Ordinary-pipeline bytes are identical.
- Slice 2: every literal-only direct-eval file whose other gaps are closed passes on the Prepared path, with a
  census count stated per run.

## Slice 1 result (2026-11-19)

- `lowerCall` (`src/ir/from-ast.ts`, +3 lines); `resolvesToSourceBinding` (`src/ir/analysis/ast-scope.ts`, +61);
  92 tests, green.
- Mutation: removing any of 13 declaration rules of the walk turns tests red. The rules are own locals and params,
  var and top-level, a named expression's own name, block and file, switch case, loop head, catch, binding
  patterns, class, default import, namespace import, named imports, and block function declarations.
- S9's 196 crash files (`crash-eval-owning-predicate.tsv`, PR #7308):
  - stand-in harness: 196 of 196 stop at `ir/from-ast: eval statement has no eval provider` in the test body;
  - real harness: all 196 stop earlier, in `assert.js` (`dynamic operation dyn.typeof has no Prepared intrinsic`);
  - none throws.
- Ordinary-pipeline bytes are identical to `origin/main` on 102 test262 files × default and standalone.
- The eval test files fail the same set as `origin/main` (46 failures there, pre-existing).
- Expression-position literal eval still refuses with the generic `direct call to "eval" has no exact AST-site
  plan`; slice 2 gives it the eval label.


## Slice A — a top-level literal direct eval is a called script source

Lead decisions of 2026-11-19. Slice A replaces slice 2's "nested program of the calling function" for the sites
it covers.

### Target structure

- A qualifying site is `eval("<text>")` at the top level of a non-strict script, where no scope of the source
  binds `eval` (`resolvesToSourceBinding`, `src/ir/analysis/ast-scope.ts:262`). A0 states the exact predicate.
- `present()` (`src/test262/test262-prepared-entry.ts:348`) adds each site's text as a virtual script
  `<eval:N>.js`, after `sourceGraph` (:354) and before `analyzeMultiSource` (:395). Every source is a script, so
  the checker resolves the text's names in the one shared global scope. The caller's text is not rewritten.
- The site-to-source link is explicit data:
  `literalEvalSources: readonly { call: ts.CallExpression; source: ts.SourceFile }[]` on `IrProgramSourceInput`
  (`src/ir/program-source.ts:844`). A new `src/ir/eval-literal.ts` owns the site predicate and the receipt that a
  pair belongs together: the source's text is the literal's value, and the site qualifies.
- No new unit kind and no new source kind. The eval source keeps its ordinary `module-init` terminal; its startup
  plan has the invocation kind `"called"`: startup does not run it, its call site does.

### ABI

- No parameters. No result in statement position; the dynamic value in expression position.
- One source per site, so a source has one caller and one result type. The signature is derived from the lowered
  body, as every module-init's is today (`returnTypeOverride: null`, `src/ir/program-source.ts:1782`).
- Each call runs the whole text again: no once-guard, no cache.
- Run-time identity test. The global `eval` is writable, so a site is a direct eval only while the global's value
  is the realm's %eval%. Every direct-eval arm reads `dyn.member_get(dyn.global_object, "eval")` and compares it
  with `js.value.strict_eq` to the realm's %eval%, a realm intrinsic from lane S5's B2b (branch
  `claude/7350-b2b`, working name `js.realm.intrinsic`). Equal runs the source's unit; not equal is an ordinary
  call of the value read. Until B2b lands, no arm is enabled. This gates A4 and A5, not A0 to A3.

### Steps

| step | what | files and functions | proving program |
| --- | --- | --- | --- |
| A0 | Measure the site predicate on the ES5 corpus. No `src` change. | `.tmp/a0-site-census.mts` | the table under "A0 measured" |
| A1 | The called init. | `IrModuleInitInvocationKind` gains `"called"`; `exactlyOnce` becomes `boolean` (`src/ir/program/startup.ts:6-12`). `verifyIrModuleInitPlan` (`src/ir/module-init-plan.ts:466`, check at :507) requires `exactlyOnce === (kind !== "called")`. One predicate `runsAtStartup(plan)` beside it, asked by `planPhysicalStartup` (`src/ir/program-physical-plan.ts:1152-1181`) and `joinStartup` (`src/compiler/ir-program-presentation.ts:716`; the population at :723, the zero-demand check at :745). | `tests/issue-7363-called-module-init.test.ts`: two scripts, one called; the adapter calls one init and the called one is still emitted; the verifier refuses both mismatches. |
| A2 | The sources and the relation. | `present()`; `literalEvalSources`; `eval-literal.ts` (predicate, receipt); `invocationPolicy` (`src/ir/module-init-plan.ts:131-144`) and `buildIrModuleInitPlan` (:190) take `"called"`, passed by `prepareIrProgramSources` for each related source (`src/ir/program-source.ts:1610`). | A qualifying statement adds one source with a called plan and still refuses by name at the site. A site of each excluded shape adds no source. |
| A3 | Script-var homes with eval sources. | `irOwnedScriptVarHome` (`src/ir/module-binding-script-var-home.ts:40`) requires the program's only source (:45, :52). The rule becomes "the only source that is not an eval source", and `scriptVarReadsFollowInitializer` (`src/ir/module-binding-script-var.ts:101`) also walks the eval texts, placing their reads at the site. | `var x = 1; eval("x = x + 1");` keeps a home for `x` and stops at the eval site, not at `x`. |
| A4 | The statement-position call. | A `lowerCall` arm (`src/ir/from-ast.ts`) on a resolver capability answered from the relation: the identity test, then a direct call of the source's unit. A name in the text that refers to the caller's top-level function crosses files: `resolveTopLevelFunctionValue` (`src/ir/imported-functions.ts:528-535`) accepts only a same-file target today. | The A3 program runs and agrees with node (right value returns, wrong one throws). A site in a loop runs its text each time. With `eval` reassigned, the text does not run. |
| A5a | Completion value: the text ends in an expression statement. | The called init returns that value; the site reads it. | `var r = eval("1 + 1");` against node. |
| A5b | Completion value: the tail is `if`, a loop, `switch` or `try`. | A completion register in the called init. | The `cptn-*` shapes, e.g. `eval("do ; while(false)") === undefined`. |
| A6 | Texts that declare names (`var`, function, Annex B block function). | The shared globals registry (below) gains `on-first-run`. | `eval("var x = 1"); x` against node; a read before the eval throws a ReferenceError. |

Needs no change, checked for A1: `fillStartupAdapter` (`src/ir/program-consumer.ts:960`, body :967-971) fills
from `plan.startup.units`, which `planPhysicalStartup` builds. `postStartupCallableUnits`
(`src/ir/program-startup-proof.ts:19`) proves no unit post-startup when an executable plan is not `wasm-start`, so
a program with a called init keeps every TDZ check: conservative and correct.

`runsAtStartup` lives in `module-init-plan.ts`, not in `program/startup.ts`:
`tests/issue-3518-startup-contract.test.ts` pins that file as type-only.

### Reused and new

- Reused: the `module-init` terminal and its lowering, the startup plan, the unit's ABI entry and emission; the
  lexical walk; `parseEvalSource`, `foldedEvalStaticSyntaxError` and `foldedEvalDeclarationNames` in
  `src/frontend/eval/` (commit `0cf01923` on `claude/prepared-eval-s2`, not on this base; A2 needs it merged).
- New: the `"called"` kind and `runsAtStartup`; `eval-literal.ts`; `literalEvalSources`; the call arm; the
  completion value; `on-first-run`.
- Not touched: legacy `eval-inline.ts` and the runtime-eval provider.
- Quality criterion: one predicate for "startup invokes this init", one site predicate asked by `present()` and by
  the lowering, one globals registry. No second copy of any of the three.

### The shared globals registry

A6 must say when a global comes into existence. That is one registry, `program-source-globals.ts`, which lane S10
extracts first as a move-only PR. It holds one row per global, with an instantiation kind:

| kind | meaning | owner |
| --- | --- | --- |
| `undefined-at-startup` | a script `var` | lane S10 (the kinds that exist today) |
| `tdz` | `let`, `const`, `class` | lane S10 |
| `function-at-startup` | a top-level function declaration | lane S4 |
| `on-first-run` | a name an eval text declares, created when the text first runs | this issue (A6) |

Every consumer reads this registry. No step adds a second loop over the program's globals.

### Risks and their pinned refusals

- A site inside a `catch`, a `with` body, a block, loop or switch with `let`/`const`/`class`, or any function or
  class would bind the text's names to the wrong scope without an error. A2's test has one row per shape: the site
  refuses by name and adds no source.
- A multi-chunk eval init (`lowerModuleInitStatements`, `src/ir/module-init-chunk-lowering.ts:50-71`, lifts one
  derived function per chunk) is refused by name at select.
- Under `strictJsSyntax` a syntax error in the virtual file is a compile error. Only a text that passes the
  PerformEval parse and `foldedEvalStaticSyntaxError` becomes a source; any other stays a named refusal.
- An `import` or `export` in the text would make the virtual file a module. The predicate excludes both.
- `var y;` alone crashes today with "empty startup source … claims an executable body"
  (`src/ir/program/validation.ts:369-370`). It blocks A6.

### Order

1. A0 and A1 now.
2. A2 to A5 after slice 1's rework is approved. A4 and A5 also wait for B2b's %eval% intrinsic.
3. A6 after the registry is on main.

### Size (estimates, not measurements)

A1 about 15 source lines and a 150-line test. A2 about 150. A3 about 30. A4 about 60. A5a about 40. A5b about 100.
A6 about 200.

### A0 measured (2026-11-19, base `07f19e42`)

Script: `.tmp/a0-site-census.mts` (TS API; `resolvesToSourceBinding` from this base, `src/frontend/eval/` copied
verbatim from `0cf01923`). Population: the 474 ES5 files with a literal direct eval in the 2026-11-19 shape census
(main `ee3fcdd610`), 881 sites. A site qualifies when every rule of the predicate holds: `eval(<string literal>)`
with `eval` unbound in the source; a script without a file-level `"use strict"` or an `onlyStrict` flag; no
enclosing function, class, `catch`, `with`, or block/loop/switch with lexical declarations; the text passes
`parseEvalSource` and `foldedEvalStaticSyntaxError`; it declares nothing and has no nested `var` or `eval`.

| qualifying | sites | files |
| --- | ---: | ---: |
| all | 485 | 118 |
| statement position | 49 | 38 |
| expression position | 436 | 82 |

| completion tail of the text | statement | expression |
| --- | ---: | ---: |
| none (empty text, `;`, comments) | 22 | 2 |
| a single expression statement | 12 | 409 |
| ends in an expression statement after a `"use strict"` directive | 1 | 1 |
| needs a register: `with` / loop / `if` / `switch` / block | 12 / 0 / 0 / 0 / 0 | 0 / 15 / 3 / 2 / 2 |
| `throw` (abrupt, no value) | 1 | 1 |
| `return` (a SyntaxError, see below) | 1 | 1 |

| excluded, by first failing rule | sites |
| --- | ---: |
| the text declares `var` or a function | 174 |
| inside a function or class | 173 |
| strict file | 24 |
| static SyntaxError: early error / parse failure | 11 / 2 |
| inside a `catch` | 9 |
| the text has a nested `eval` | 2 |
| inside a `with` | 1 |
| inside a block, loop or switch with lexical declarations | 0 |

Files whose every literal direct eval qualifies: 115, all positive and none with another `eval` use. 36 of them
have statement-position sites only, which A4 alone serves.

Findings:

- `eval("return;")` (`language/eval-code/direct/parse-failure-5.js`) passes both shared checks, yet `return` at a
  Script's top level is an early SyntaxError. A2's predicate refuses a top-level `return` by name, and the shared
  check gains the rule in the same PR.
- 12 statement texts are `with (…) {…}` (`S12.10_A4_*`) and 2 call `Function`: they qualify as sites but also need
  those foundations.

### A1 result (2026-11-19)

- `"called"` and `exactlyOnce: boolean` in `src/ir/program/startup.ts`; the verifier rule and `runsAtStartup` in
  `src/ir/module-init-plan.ts`; `planPhysicalStartup` and `joinStartup` ask it. `fillStartupAdapter` and
  `postStartupCallableUnits` are unchanged.
- No producer yet: only A2's relation decides that a source is called, so `invocationPolicy` and
  `buildIrModuleInitPlan` take `"called"` in A2. `tests/issue-7363-called-module-init.test.ts` marks one script's
  real plan called by wrapping `buildIrModuleInitPlan` and re-verifying the result.
- Mutation: each of the five new conditions, reverted alone, turns at least one of its five tests red.

### A2 result (2026-11-19)

- `src/ir/eval-literal.ts` holds the site predicate (A0's, plus `return` outside a function and "one init chunk"),
  the pairing and the receipt. `present()` parses the entry only when its text contains `eval`, adds `<eval:N>.js`
  per qualifying site, and passes `literalEvalSources` through `runPreparedIrPipelinePresentation` into
  `preparation`. A module-goal compile adds none; without `allowJs` a site refuses by name
  (`prepared-literal-eval-requires-allowjs`); a supplied file with an eval source's name is refused.
- `prepareIrProgramSources` runs the receipt, passes `called` to `buildIrModuleInitPlan`, and gives `lowerCall` the
  capability `literalEvalHasCalledSource`. A related statement site refuses with
  `eval literal has a called source; its call needs the %eval% identity test (#7363 A4)`.
- A1's test now uses the real relation; the mock is gone. A site after `break` is never lowered, so its program
  compiles and shows the called source. A1's third case (the only executable init is called) cannot arise from the
  relation: the entry holds the site's statement, so it is always executable. That case is dropped.
- Plan correction: the `return` rule could not go into the shared early-error check. It changes the legacy fold's
  bytes for `parse-failure-5.js` (default and standalone), so it lives in the IR predicate and the shared check is
  unchanged.
- Measured on the 118 A0 files (stand-in harness): the first gap moves for 72. 50 now stop at a script `var` of the
  entry (`module binding … has no exact typed storage`): a second source takes away the only-source script-var home,
  which is A3's work. About 20 stop inside an eval text (counted on the raw test texts): `<eval:N>.js` sorts before
  the entry and is lowered first, and the census charges those gaps to the stand-in by line. 2 stop at the new label.
  Real harness: 116 of 118 move from `assert.js` (`dyn.typeof`) to a harness `var` with no home, for the same A3
  reason. Every file was a compile error before and is one after.
- Programs with no qualifying site: Prepared output identical on the 100-file sample, and ordinary-pipeline bytes
  identical (100 files × default and standalone). The listed regression tests fail the same 48 tests as the base.
