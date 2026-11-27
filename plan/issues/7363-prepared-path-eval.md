---
id: 7363
title: "Prepared IR path: eval — a named refusal first, then literal direct eval as a certified nested program"
status: in-progress
assignee: ttraenkler/c-lead
sprint: current
created: 2026-11-19
updated: 2026-11-26
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
# 2026-11-19 (slice A, A3): program-source.ts +11, the two seams that read the relation: `sourceInventoryOptions`
# (the inventory options moved out of prepareIrProgramSources, plus the edge that orders an eval source after its
# caller; the function itself shrinks by 3) and the startup sources the script-var home is asked over.
# 2026-11-26 (merged onto main 6694a8b8): compiler.ts +6, not +4: since #7428 a single-source request has no graph,
# so its program's source list names its called eval sources (+2). program-source.ts +20, not +17: a script's
# module-init plan takes only its own function values (#7354 F1b), so a called eval source holds none (+3). The
# capability now rides on SourceUnitLowering in program-source-units.ts (+5, under its ceiling).
# 2026-11-26 (A4 narrowed): from-ast +27: `lowerLiteralEvalCall` (the site's call of its called init or its named
# refusal, 22 lines with its doc) and the resolver's `literalEvalCalledInit` / `ambientThisMayBeGlobal`; lowerCall
# is 306 lines, +1 over main (the A2 label's branch becomes the arm). The other A4 files stay under their ceilings.
# 2026-11-27 (RV7502 finding 2): program-source.ts +7, the one admission point that refuses a site at select before
# any unit lowers (`literalEvalSiteRefusal` in eval-literal.ts, under its ceiling). from-ast -16: the gate leaves
# `lowerLiteralEvalCall`; lowerCall stays at 306.
# 2026-11-27 (merged onto main 2af9fc6e): program-source.ts +29 over main. +3 of it is new in the merge: each script's
# module-init plan takes only its own Annex B block functions (#7372), as it does its function values, so a called
# eval source holds none. lowerCall is 305 there, +1 over main.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/program-physical-plan.ts
  - src/compiler/ir-program-presentation.ts
  - src/ir/program-source.ts
  - src/compiler.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerCall
import-cycles-allow:
  - ir->frontend: 11 # 2026-11-26 (#7363 A2, on main 6694a8b8, where it is 9; was 10 on the 2026-11-19 base): src/ir/eval-literal.ts's two edges ask the shared pure eval syntax in src/frontend/eval/ (parse, static SyntaxError, declared names), the one copy both pipelines ask, as the plan's "Reused" list says
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
| A4 | The statement-position call. **Superseded by "A4 narrowed" below (2026-11-26): a static proof, no identity test.** | A `lowerCall` arm (`src/ir/from-ast.ts`) on a resolver capability answered from the relation: the identity test, then a direct call of the source's unit. A name in the text that refers to the caller's top-level function crosses files: `resolveTopLevelFunctionValue` (`src/ir/imported-functions.ts:528-535`) accepts only a same-file target today. | The A3 program runs and agrees with node (right value returns, wrong one throws). A site in a loop runs its text each time. With `eval` reassigned, the text does not run. |
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
  `preparation`. A module-goal compile adds none; without `allowJs` a site refused by name
  (`prepared-literal-eval-requires-allowjs`; since RV7432 round 1 it adds none); a supplied file with an eval
  source's name is refused.
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

### A3 result (2026-11-19)

- Script-var homes: `irOwnedScriptVarHome` is asked over the program's startup sources, every source the A2
  relation does not mark called (`prepareIrProgramSources` filters them once; `programDynamicContracts` and
  `sourceDynamicProvenance` pass the list on). The "only source" rule becomes "only startup source". Its reasons
  still hold, and the doc says why: a called eval source declares nothing (so it stores no hoisted `undefined` and
  owns no binding the home is asked about), runs only from its site after the startup source's prologue, and its
  caller holds a direct eval, so that file has no typed home (`sourceRunsDynamicCode`) and no write list
  (`hasDynamicScope`). The eval text's reads and writes resolve to the entry's globals by checker identity; no
  globals registry or cross-source key is needed.
- Order: `verifyLiteralEvalSources` also returns each source's dependency on the entry, and the inventory gets it as
  `resolvedDependencies` (merged with the caller's own edges, `sourceInventoryOptions`). The inventory's
  dependency-first order then plans and lowers the entry before `<eval:N>.js`, whatever the names sort to.
- `joinStartup`: the zero-demand branch stays. A program with no executable init reaches it (`function f() {}`,
  now tested). A1's extra condition in it (`!row.executable &&`, so that a called row passed) is removed: it served
  only a program whose every executable init is called, and the relation cannot make one, since the entry holds
  the site's statement and always runs at startup (tested on two never-lowered site shapes). A called row there is
  a gap again, as before A1.
- Plan corrections. (1) The Steps row said `scriptVarReadsFollowInitializer` would also walk the eval texts. It
  need not: the entry of every related source has a direct eval, so the reads proof never runs for its vars.
  (2) "The startup source is the one whose plan `runsAtStartup`" would be unsound: `runsAtStartup` is also false for
  a non-executable script (only function declarations), whose hoisted functions the reads proof does not walk. The
  rule asks the relation, which is exactly the `"called"` invocation kind.
- The `return` rule stays in the IR predicate; the legacy-bytes reason is stated in A2's result above.
- Measured on the 118 A0 files against base `4e7d2921` (slice 1 + A0/A1, before A2), S9's census, both harnesses.
  Per file, a first gap's position is its source file and line: within the one assembled `test.js` a lower line is
  earlier (the census's harness / stand-in / test origin follows from the line); a gap inside an eval text counts as
  after the whole entry; a compiled program is later than any gap. Result: no file moves earlier in either harness.
  Stand-in: 95 identical; 23 at the same line, now with the A2 label at the site instead of slice 1's "eval
  statement has no eval provider". Real harness: 118 identical (`assert.js`, `dyn.typeof`). No file stops at a
  script `var` with no home or inside an eval text (A2 alone: 50 and 20 stand-in, 116 real).
- Tests: `tests/issue-7363-eval-source-home-order.test.ts` (9; 7 fail on A2). The A2 file's source-order
  expectations follow the new order, and its A3-pending case moved there as the positive. Each of the 8 mutations
  of a new or changed condition turns a test red; re-adding A1's removed conjunct is test-neutral, as it should be.
  The 51 listed regression files fail the same 48 tests as A2 (`7883f81a`). Ordinary-pipeline bytes identical on the
  100-file sample × default and standalone; Prepared output identical to base on the sample's 92 files with no
  qualifying site.

## Merged onto main (2026-11-26, base `6694a8b8`)

Eval-A (A0–A3) is merged with `origin/main` `6694a8b8` (872 commits since the slice-1 merge base `9554f3c6`) on
branch `claude/prepared-eval-a6`. No PR yet; the adversarial review is still to be run. Slice 1 is on main (PR
#7310). S10's globals registry (`program-source-globals.ts`) is not on main yet, so A6 still waits for it.

**What main changed under eval-A.** Main has no eval-on-Prepared commit of its own since 2026-11-20; `c511b34f`
only re-pins the slice-1 refusal test to the `"refuse"` policy and drops its `this.eval` row (#7354 C2). Five
main designs met eval-A. None contradicts A0–A3; each needed its seam re-applied:

| main change | what eval-A does now |
| --- | --- |
| #7380 retired the startup-contract declaration-hash pins | A1's re-pinned hashes are gone with them |
| #7428: a single-source request reaches the pipeline without a graph | the single-source program's sources are the entry plus its called eval sources (`compiler.ts`) |
| #7354 U moved the unit lowering to `program-source-units.ts`; abort bodies | the A2 capability rides on `SourceUnitLowering.literalEvalCalls`; the A2 test asks for refusals with `"refuse"`, as the slice-1 test does |
| #7354 F0 dead-binding elision of a one-source graph | the eval sources join after it; the sites are the elided entry's (F0 keeps every name a literal eval text mentions) |
| #7354 F1b and Fa: function declarations as values and static function values need the program's only source | as A3's script-var home: only startup source (`programDynamicContracts` asks them over `startupSources`), and a script's function values are its own, so a called eval source holds and makes none |

The last row was a regression after the plain merge: on the real harness 114 of the 118 A0 files stopped at
`identifier "assert" is not in scope` (assert.js's `assert._isSameValue = …` reads `assert` as a value), and 3
stand-in files at a declaration read as a value or constructed (`__FACTORY`, `Test262Error`). A write
in an eval text to such a binding takes the eval route, which main's H2 invariant leaves to the slice that admits
it (`module-binding-script-var.ts`): A4 must make it write the home or refuse.

**Re-measured on the merged head, base `origin/main` `6694a8b8`.**

- Gates: typecheck, LOC, function, coercion-site, oracle, dead-export, compiler-boundary inventory, import-cycle
  and IR-layering gates pass, LOC and function also with `LOC_GATE_BASE` = `6694a8b8`. `ir->frontend` is 9 on
  main, 11 here (the grant above).
- Ordinary-pipeline bytes: identical on the 100-file sample, default and standalone.
- Prepared bytes: identical on the sample's 92 files with no qualifying site; 2 of the other 8 change only the
  site's label.
- Fail sets: the 52 listed test files (49 on main) fail the same 47 tests as main. The three eval-A test files
  pass. Mutation: each of the six seams the merge changed, reverted alone, turns at least one of them red.
- Census on the 118 A0 files, S9's census (`scripts/ir-census/`), both harnesses, compared per file by
  `.tmp/compare.mjs` (A3's rule). The census reports a module-init gap at the init's first line, so the detail
  decides within it.

| harness | identical | same site, A2 label instead of slice 1's | earlier | later |
| --- | ---: | ---: | ---: | ---: |
| stand-in | 94 | 24 | 0 | 0 |
| real | 96 | 22 | 0 | 0 |

No file passes or compiles on main or here. On the real harness 72 files stop at an expression-position site
(`direct call to "eval" has no exact AST-site plan`, A5's), 22 at the A2 label (A4's), and 24 at another gap
before any site.

### Review RV7432 round 1 (2026-11-26, base `origin/main` `c3b7be66`)

The fresh-context review blocked on two findings; both are fixed on `claude/prepared-eval-a7` (origin/main merged in).

- **B1: an eval source added compile errors.** A text that fails a compile gate (`l: l: 1`, a TS-only syntax, a
  hard type error) made a program fail that compiles on main, even with a site that never runs. Fix, in
  `withLiteralEvalSources` (`test262-prepared-entry.ts`): the program is analyzed without the texts (main's analysis)
  and with them. The texts join only when (1) the compile's own gates pass each text as they pass a JavaScript entry
  (the syntax gate with `TOLERATED_SYNTAX_CODES`, `isHardTypeScriptDiagnostic`, `sourceEarlyErrors`, all reused from
  `compiler.ts`), and (2) the other sources' diagnostics are unchanged. Any other diagnostic of a text is tolerated as
  in an entry: `eval("undeclaredX")` still claims (coordinator's scope change of 2026-11-26; #7487 depends on it).
  Otherwise no text joins and every site keeps its slice-1 refusal at select, so the program is main's.
  - Why (2): a member store in a text declares a JS expando property of a caller binding. Measured:
    `var o = {}; var n = 1; … eval("o.p = 's'") …; n = o.p` adds TS2322 to the **entry**. Such a change names no
    text, so it is all or nothing. Filtering diagnostics by file alone would miss it, and it would leave the dropped
    source in the program.
  - Cost: one more analysis for a file with a qualifying site, when F0 elided its graph. Census wall time on the 118
    files: 11 s on main, 12 s here (real harness).
  - Predicate: `await` outside every async function of a text is a Script early error that only TypeScript's
    semantic check reports, which no gate refuses. It joins `return` in `scriptEarlyError` (`eval-literal.ts`).
  - Without `allowJs`, no text joins: the old `prepared-literal-eval-requires-allowjs` refusal failed a program main
    compiles.
- **B2: writes in a text were invisible to the binding proofs.** `preparedBindingRewritten` walks only the declaring
  file. Fix (b), the smaller one: a text that stores into any identifier is no site (`bindsOrEvaluates`,
  `identifierWritesOf`). A store into the text's own parameter refuses too: no scope walk tells it from a caller
  binding. The comments in `function-declaration-values.ts` and `module-binding-script-var-home.ts` now state this
  invariant. Option (a), scanning the called sources in the write walk, is A4's when it admits writes.

Proofs:

- Tests: `tests/issue-7363-eval-source-admission.test.ts` (36). The review's five rows and its two reached rows,
  each under both diagnostic settings; the expando row; a hard type error; the undeclared-global claim; a malformed
  text; nine write shapes; the A4-shaped `g` rewrite. 29 fail on the pre-fix head, as does the reworded `allowJs` test
  of the A2 file; the 7 that pass there are controls. Eight
  mutations (each gate, the comparison and its eval-file filter, `await`, the writes rule, `allowJs`) each turn at
  least one test red. Three A3 tests read instead of writing in the text.
- Fail sets: the 55 listed files (51 on main) fail the same 47 tests as main.
- Ordinary-pipeline bytes: identical on the 100-file sample, default and standalone.
- Census, 118 A0 files, both harnesses, against main: no file earlier or later. Stand-in: 100 identical and 18 at the
  same site with the A2 label (was 94/24). Real harness: 102 and 16 (was 96/22). The six that went back to main's
  label have texts that write.
- Gates pass, LOC and function also with `LOC_GATE_BASE` = `c3b7be66`. No new grant: `compiler.ts` only exports
  two existing names.

Left open: a text the IR cannot lower (`[x]`, `delete x`, `with`, a read of a caller function as a value) still
fails a program whose site never runs. That is a lowering gap of the called init, not a diagnostic. The census
shows no such file, because a reached site stops first. A4 must claim a site only when its source's unit lowered.

### A4 narrowed: a static proof instead of the run-time identity test (2026-11-26, base `caaef907`)

B2b (the realm's %eval% intrinsic, lane S5) is stalled, so A4 no longer waits for it. A4 needs from B2b only the
value to compare against; `dyn.global_object` and `dyn.member_get` are on main (#7106 S3c). The narrowed A4 drops the
run-time test and asks a static proof that already exists.

- **The proof.** A site is a direct eval only while the global `eval` is the realm's %eval%. If no source ever
  rebinds it, that holds at every site. `pristineBuiltinGlobal` (`src/ir/builtin-global-binding.ts`, #7354 O1) is
  that proof for `Object`'s statics, and A4 reuses it unchanged:
  - `eval` is declared in lib files only;
  - no source declares a binding named `eval` at any level;
  - no source writes it: an assignment, a compound assignment, `++`/`--`, a destructuring or for-in/of target, or a
    member write through `globalThis`/`global`/`window`/`self`/`this`.
  A4 asks it through the existing resolver capability `isPristineBuiltinGlobal` (`from-ast.ts`), over every source
  of the program, the `<eval:N>.js` sources included, and reads it as `=== true` (the capability is absent off the
  native lane). A text that writes is no site anyway (RV7432 B2).
  - `delete eval` removes the binding without a global-object value: `boundOrWrittenNames` gains `DeleteExpression`
    (operand names, as for `++`). This is a soundness fix of the shared proof; the `Object` statics gain it too. The
    PR measures bytes on the 100-file sample and the census for the claim change.
  - A sloppy function that reads ambient `this`, called as a value, yields the global object today:
    `function f(){return this} var h = f; var G = h(); G.eval = function(){}; eval("1");` compiles up to the A4
    site (PRV-A4 B1). So A4 also requires that no sloppy function can receive ambient `this`. No new walk: the
    contracts' existing receiver walk (`bindsReceiver` → `closuresBindReceivers`, `src/ir/source-dynamic-contracts.ts`)
    already asks `codeStrictness(code).ambientThisStrict`, which is defined exactly for a function-like that reads
    ambient `this` (`readsAmbientThisGlobal`) when functions are values. That walk visits function expressions only,
    and the B1 program's `f` is a declaration. So the walk is widened to every non-arrow function-like and answers two
    flags in one pass: the existing `closuresBindReceivers` (expressions, any strictness: unchanged) and
    `ambientThisMayBeGlobal`: some function-like with `ambientThisStrict === false` whose own `this` **escapes**.
    A4 asks the second through the resolver beside `isPristineBuiltinGlobal`.
  - Escape, not use (PRV-A4 B1'): every real-harness program has four sloppy function-likes that read `this` (the
    shim's two, sta.js's `Test262Error` and its `toString`), so "any use" refuses all 12 files. The global object
    leaves a function only where `this` is a value. A use does not escape when `this` is (a) the object of a static
    property access whose name is not a global alias (`this.globalThis` yields the object; the alias set is
    `GLOBAL_ALIASES` of `builtin-global-binding.ts`, exported, not copied) and that access is a value read or an
    assignment target, never a callee: not the callee of a call, `new` or tagged template, and not the object of a
    `.call`/`.apply` (PRV-A4 B1'': `this.valueOf()` returns ToObject(`this`), the global object, and `this.m()` hands
    it to any method), or (b) the left operand of `instanceof`. Every other use escapes, `this["eval"]` included, and
    so does a direct `eval` call in the body (its text may read `this`, as `bodyReferencesOwnThis` already assumes). A
    write `this.eval = …` is already one of `targetNames`'s writes. The harness uses are `this.message` ×3 and `this
    instanceof` ×1, so none escapes.
  - The predicate `ownThisEscapes(declaration)` lives in `src/shared/body-references-own-this.ts`. Its traversal is
    that module's own: the scope rules `findOwnThisReference` and `bodyReferencesOwnThis` already share (do not
    descend into a non-arrow function-like or class; do descend into arrows) become one internal `forEachOwnThis(node,
    visit)`. All three predicates use it, so no second copy of the rules exists. Parameter initializers count, as in
    `functionLikeReferencesOwnThis`. When functions are not values, `ambientThisStrict` is undefined and a plain call
    of a `this`-using function already refuses ("installs no receiver"), so the flag is false and sound. The `Object`
    statics do not ask it yet: their hole (held only by the run-time trap in sloppy `dyn.current_this`) is #7503's.
- **The call.** Pristine: `lowerCall` lowers the statement site as a direct call of the source's called init unit
  (A1's `"called"` kind). There is no identity test and no read of the global. Not pristine: the site refuses at
  select, by name: `eval literal: the global eval is not pristine (#7363 A4)`. A site in expression position (its
  completion value is used) keeps a named refusal: `eval literal: its completion value needs #7363 A5`.
- **Claimed only when the text's unit lowered.** RV7432 B1 left this open: a text the IR cannot lower (`[x]`,
  `delete x`, `with`, a read of a caller function as a value, `undeclaredX` as "identifier not in scope") fails the
  program even when its site never runs. Admission stays in one place, `withLiteralEvalSources`
  (`test262-prepared-entry.ts`). There the texts already join only when the compile's gates pass them. Any failure
  of the compile with the texts now also falls back to the compile without them (PRV-A4 B2: a failure's location
  does not name its cause; `let y = 1; do { break; eval("y"); } while (false); if (y !== 1) throw 1;` fails at
  physical setup, "body <module-init> references __new_ReferenceError", and main compiles it).
  - This also covers a text that calls a caller's top-level function: `resolveTopLevelFunctionValue`
    (`src/ir/imported-functions.ts`) accepts only a same-file target, so its unit does not lower and the file falls
    back to main's.
  - The program is then exactly main's, and every site keeps its refusal.
  - Nothing is claimed and then withdrawn inside one program; the decision is the entry's, before emission.
  - The fallback is all or nothing per file, as in B1.
- **Soundness boundary.** The proof does not see these writes:
  - a computed key (`globalThis["ev" + "al"] = f`);
  - an escaped global-object value (`var g = globalThis; g.eval = f`);
  - `Object.defineProperty(globalThis, "eval", …)` or `Reflect.set`;
  - code run by the runtime-eval provider or the `Function` constructor.

  Each needs the global object as a first-class value, or a dynamic code path. Neither is reachable on the Prepared
  path today: `globalThis` lowers to "identifier "globalThis" is not in scope", script-level `this` to "'this'
  reference outside an instance method body", a plain call of a `this`-using function to "installs no receiver for
  its 'this'", and an unbound eval statement or indirect eval to the slice-1 refusal. The `Object` statics rest on
  the same boundary. Before `globalThis` or script `this` lowers, both proofs need an escape check:
  [#7503](7503-pristine-builtin-global-escaped-writes.md).
- **Pins.**
  - The refusal: one row per write shape (`eval = f`, `eval += ""`, `[eval] = [f]`, `var eval`, `function eval(){}`,
    `globalThis.eval = f`, `this.eval = f`). Each refuses the site by the A4 name.
  - The boundary: a program whose site is pristine but that also reads `globalThis`, and one with script-level
    `this`, still refuse, by the existing labels. If either label ever goes away, the test fails and points at #7503.
  - The lowering fallback: a text that cannot lower (`eval("[x]")` after `break`, never run) and the PRV-A4 B2
    program leave the output byte-identical to main's.
  - `delete eval` refuses the site; the PRV-A4 B1 program (a bare `return this`) refuses the site by the A4 name.
  - A harness-like `function E(m){ if (!(this instanceof E)) return new E(m); this.message = m; }` plus a site
    still lowers; `this.globalThis`, `this["eval"]`, `var t = this`, `this.valueOf()`, `new this.C()` and an `eval`
    call in a sloppy function each refuse.
  - Acceptance: the 12 files re-measured with the real harness on the built head, not the stand-in.
  - Measured at plan time on `05388431` with the flag instrumented (local copy, reverted), `--harness real`: in
    all 12 programs `functionObjects` is true and no sloppy ambient-`this` function lets `this` escape (the
    harness's `this.message` and `this instanceof` stay allowed). The B1 program, `this.globalThis` and `this["eval"]`
    each set the flag; the harness-like `E` with its `toString` does not. Re-measured with the B1'' callee rule: the
    same 12 × no escape; `this.valueOf()` and `new this.C()` set the flag.
  - Run: the A3 program runs and agrees with node; a site in a loop runs its text each time.
- **Yield, measured on `caaef907` (real harness).**
  - 16 files stop at the A4 label (18 with the stand-in harness).
  - Simulated by rewriting each top-level statement site into its text as a block (the narrowed A4's semantics;
    a text that is only a `//` comment becomes `{}`), then
    `npx tsx scripts/ir-census/prepared-census.mts --files <list> --out <jsonl> --harness real --jobs 3` over a
    `test262/` whose `test/` holds the rewritten copies. 12
    pass: `11.1.5_4-4-b-1`, `S7.3_A5.4`, and the ten `language/white-space/comment-{single,multi}-*`. None has an
    `eval` binding or write in the test or the harness, so the proof holds for all 12.
  - The other 6:
    - 2 need `.call`/`.apply` on a closure;
    - 2 need the `Function` constructor (#7487);
    - `cptn-thrw-prim` also has an expression-position site (A5);
    - `15.3.5.4_2-12gs` compiles but fails at run time ("unreachable").
  - The static SyntaxError throw adds 3. Total: 15.
  - The earlier "A4 alone 18" was an estimate made another way; this measurement replaces it.
- **Size (estimate).** `lowerCall` arm about 15 lines, the capability about 5, the admission fallback about 15, the
  call of the called unit about 25, the widened receiver walk about 15, `ownThisEscapes` and the shared traversal
  about 25, `DeleteExpression` 3. One test file for the pins.

### A4 result (2026-11-26, head `23ff7ea4`, base `origin/main` `1a726b3e`)

Built as planned, with three deviations, each stated here.

- **The call.** `lowerCall` asks the resolver's `literalEvalCalledInit` (it replaces A2's `literalEvalHasCalledSource`):
  the called source's module-init as a unit reference, `null` when the text runs nothing (a comment-only text has no
  init unit), undefined for no site. `lowerLiteralEvalCall` (`from-ast.ts`) emits the call, or refuses at select by
  name. `verifyLiteralEvalSources` returns each call's source (a map, was a set).
  - Deviation 1: "statement position" is from-ast's `statementPosition`, which is "the value is discarded". So
    `void eval("1")` and a comma operand also lower. Their completion value is unused, which is A5's line.
- **The proof.** `pristineBuiltinGlobal` sees `delete` (`boundOrWrittenNames`); `GLOBAL_ALIASES` is exported.
  `receiverBindings` (`source-dynamic-contracts.ts`) is the widened walk: one pass over every non-arrow function-like
  (`isReceiverBindingFunction`, exported from `body-references-own-this.ts`) answers `closuresBindReceivers`
  (function expressions only, unchanged) and `ambientThisMayBeGlobal`. The resolver carries it beside
  `isPristineBuiltinGlobal`; the `Object` statics do not ask it (#7503).
  - Deviation 2: `ownThisEscapes(declaration, globalAliases)` takes the alias set as a parameter. Importing it from
    `src/ir/` into `src/shared/` would add a shared→ir edge under a module that codegen imports. The caller passes
    `GLOBAL_ALIASES`, so the set is still defined once.
  - `forEachOwnThis` visits each `this` and each direct `eval` call of the own-`this` scope; the three predicates
    differ only in their visitor. `findOwnThisReference` keeps its DFS order, so the node it returns is unchanged.
- **The fallback.** `withLiteralEvalSources` takes the graph compile as a callback (`presentAnalyzed`, split out of
  `present`) and returns the compile with the texts only when it succeeds; otherwise the compile without them.
  - Deviation 3: when that fails too, the failure with the texts is returned. Without this, every A4/A5 refusal would
    read as main's slice-1 label, and the census could not see the site's own refusal. No program changes: both
    compiles failed.
- **Tests.** `tests/issue-7363-eval-a4.test.ts` (33), all through the Prepared entry's `compile` with the census's
  options:
  - eight write shapes, each refusing by the A4 name. `var eval` and `function eval(){}` sit inside a function: at
    the top level they bind the call's `eval`, so there is no site (slice 1's rows);
  - the B1 program, and eight sloppy-`this` escapes (the plan's six, a tagged template, a `.call` member, and a
    parameter initializer), each refusing by the A4 name; `var h = f` makes `f` a value, without which no plain call
    gives it the global object;
  - controls that lower and run: a member read, a member write, `instanceof`, strict code, and the harness's
    `Test262Error` shape;
  - an A5 row (`var v = eval("1")`), and the two boundary labels;
  - the two fallback programs. Each is byte-identical to the compile without a site (the two-argument spelling),
    and that equals main's bytes (checked against a `1a726b3e` tree);
  - the A3 program agrees with node, also when it ends in a text that throws; a site in a loop runs its text each
    time.
- **Updated tests.** A pristine site lowers where the A2 label stood:
  - `prepared-eval-refusal`: the top-level literal lowers, and `eval = 0` after it refuses by the A4 name.
  - `literal-eval-source`: the statement site and `void eval("1")` lower; `var v = eval("1")` refuses by the A5 name.
    Non-sites assert no `eval literal:` label. The receipt test reads the call→source map.
  - `eval-source-home-order`: the three site-first rows write `eval` after the site, so they keep their intent with
    the A4 name.
  - `eval-source-admission`: `eval("undeclaredX")` joins and the site lowers; the program now stops in the text
    (`identifier "undeclaredX" is not in scope`).
- **Mutation.** 17 mutations, each reverted alone; each turns at least one A4 test red:
  - the two conditions and the A5 position check;
  - `delete`;
  - the five escape rules (`instanceof`, static member, call/`new` callee, tagged template, `.call`/`.apply`), the
    alias rule, the eval escape and parameter initializers;
  - the widened walk, `=== false`, and `ownThisEscapes` in the flag;
  - the fallback and the emitted call.
- **Census**, 118 A0 files. Main is the tree at `1a726b3e`, head is `23ff7ea4`; files compared by `compare.mjs` (A3's
  rule). Command:
  `npx tsx scripts/ir-census/prepared-census.mts --files .tmp/q118.txt --out <fresh> --harness <h> --jobs 3`
  (`--tree <main tree>` for main).

  | harness | pass | fail | compile error | earlier | same | same position, other label | later |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  | main, both | 0 | 0 | 118 | | | | |
  | real | 12 | 1 | 105 | 0 | 43 | 62 | 13 |
  | stand-in | 12 | 1 | 105 | 0 | 41 | 64 | 13 |

  - Same position, other label: 59 expression sites now read `eval literal: its completion value needs #7363 A5`
    (was `direct call to "eval" has no exact AST-site plan`).
  - Real harness: 2 sites lowered, and the program now stops at script-level `this` on the same init line (`.call` /
    `.apply` on a closure); stand-in: 4.
  - `cptn-thrw-prim`: the site lowered, and the program now stops at a dynamic `+`.
  - Later: the 12 pass, and `15.3.5.4_2-12gs` compiles but fails at run time ("unreachable"). Its text calls
    `gNonStrict`, whose `.caller` read is an abort body. The plan predicted this.
- **Acceptance.** The 12 files pass with the real harness on `23ff7ea4`: `prepared-census.mts --files twelve.txt --out
  <fresh> --harness real --jobs 3`, 12 × `pass`. That is the expected yield of 12; the static-SyntaxError arm (+3) is
  not built here.
- **Bytes.** Ordinary pipeline, 100-file sample × default and standalone: identical to main. The `delete` change
  moves no `Object`-statics claim on the sample.
- **Fail sets.** No failures on either side: `issue-7363-*` and `test262-prepared-entry*` (274 tests here, 136 on
  main, which lacks four of the 7363 files), and the `issue-7354-{c2,o1,f1,fa}*` files (165 each side).
- **Gates.** loc, func (also with `LOC_GATE_BASE` = `1a726b3e`), coercion, oracle, dead exports, typecheck, biome
  lint, prettier, import cycles, IR layering, and the compiler-boundary inventory against `origin/main` all pass.
  Grant: from-ast +27 (above).

### Review RV7502 (2026-11-26, head `cfcee6c6`): APPROVE, five findings

1. The orphaned JSDoc in `source-dynamic-contracts.ts`: `receiverBindings` now sits above the `typeof X` doc, which
   is again directly on `absentGlobal`.
2. The A4/A5 gate demotes in lowering, then the adapter compiles again: sized (about 60–80 lines and a census) and
   put to the coordinator; not in this commit.
3. The adapter's third copy of the compile gates: one exported `sourceFailsCompileGates(source, ast, options)` in
   `compiler.ts` (non-tolerated syntax error, hard TypeScript error, ES early error) replaces it.
   `isHardTypeScriptDiagnostic` and `TOLERATED_SYNTAX_CODES` are private again. The compiler's own entry gates keep
   their per-entry policies (the single-source one reads every diagnostic; the multi-source one only the entry's,
   and none semantic under `allowJs`), so they do not call it.
4. "Not scanned" read as "proved": the finding was a real gap, not a nit. With no function value, a sloppy plain
   call still gives `this` the global object: `function f(){ return this } f().eval = 1; eval("1");` lowered its
   site, held only by the run-time trap in sloppy `dyn.current_this` (#7503). The flag is now judged from the code's
   own strictness (`functionCodeStrict !== true` and `readsAmbientThisGlobal`) over every source, whether or not
   functions are values. Pinned (two plain-call rows); reverting to `ambientThisStrict === false` turns both red.
   An object-literal method is misjudged strict by `isStrictContext`; that row is #7503's.
5. `EvalDeclarationNames` is gone (the same edit as #7439's).

Re-measured: the 12 acceptance files pass with the real harness
(`npx tsx scripts/ir-census/prepared-census.mts --files twelve.txt --out <fresh> --harness real --jobs 3`); the
7363, Prepared-entry and `issue-7354-{c2,o1,f1,fa}*` files pass (293 and 165 tests).

#### RV7502 finding 2 (2026-11-27, base `f6ae7432`)

The A4/A5 gate moves from lowering to admission, so a site refuses at select and is never claimed and withdrawn.

- **`discardsValue(call)`** (`eval-literal.ts`): through parentheses, the call is the expression of an expression
  statement (a label included), the operand of `void`, or the left operand of a comma. Each is a place where from-ast
  passes `statementPosition = true` (`lowerDiscardedExpression`: the statement walkers, the `void` arm, both comma
  arms). from-ast's other statement positions are excluded: a comma's right operand and a conditional's arm hand their
  value on. A for head's expressions are values in from-ast (`lowerForInitializer`, `lowerForUpdateExpr`), and the
  incrementor's comma list is split clause by clause before `lowerDiscardedExpression` sees it, so
  `for (…; …; eval("1"), i++)` is not discarded. That keeps the one decisive property: every admitted site is lowered
  in statement position.
- **Admission** (`literalEvalSiteRefusal(call, contracts)`, called from one loop in `prepareIrProgramSources` right
  after `programDynamicContracts`): not `discardsValue` → A5; else the contracts' `isPristineBuiltinGlobal` (the same
  memoized predicate) not true, or `ambientThisMayBeGlobal` → A4. The refusal is an `IrUnsupportedError` with the new
  code `literal-eval-site-unsupported` at stage `select`, owned by the entry's init, with the old label text, so every
  pin and census label is unchanged. `ambientThisMayBeGlobal` moved from the resolver to a field of the contracts: no
  lowering asks it any more.
- **Lowering**: `lowerLiteralEvalCall(init, cx)` only emits the call; its `statementPosition` parameter and its gate are
  gone. lowerCall stays at 306 lines.
- **Adapter**: `withLiteralEvalSources` returns the with-texts failure as-is when its code is
  `literal-eval-site-unsupported`. The second compile runs only for any other failure (a text the IR cannot lower).
  Cost: an A4/A5 refusal compiles once instead of twice.
- **A visible change**: admission sees every site, also one lowering never reaches. `var v; do { break; v =
  eval("1"); } while (false);` compiled on `f6ae7432` (the second compile, without texts, never lowered the dead
  site) and now refuses by A5. So do `0, eval("1");` and `c ? eval("1") : 0;`, which from-ast lowered in statement
  position. All three are pinned.
- **Annex B HTML-like comments** (lead's item): TypeScript has no B.1.1, so `eval("o.p <!--o.p")` parsed as
  `o.p < !(--o.p)` and made a source. `hasHtmlLikeComment(text)` (`src/frontend/eval/script.ts`, shared with #7487)
  is true for `<!--` anywhere or a line that begins with `-->` after white space and comments. It is conservative
  (a string or comment occurrence counts too), and `textRunsAsScript` asks it, so such a text makes no source and
  its site keeps slice 1's label.
- **Pins** (`issue-7363-eval-a4.test.ts`, 57 tests): six `discardsValue` forms lower and run; six value-used forms
  refuse by A5 (`var v =`, comma right, an argument, a condition, a conditional's arm, an incrementor clause); the A4
  refusal is one compile (a pass-through spy on `runPreparedIrPipelinePresentation` counts 1; the two fallback rows
  count 2) and has code `literal-eval-site-unsupported` at `select`; the dead-code site; the three HTML texts make no
  source and refuse by slice 1's label; the control `1 < !--y`; four `hasHtmlLikeComment` shapes.
- **Mutation**: 15, each reverted alone, each red: the expression-statement, `void` and comma-left arms, the
  parenthesis walk, left-operand-only, the incrementor exclusion, the A5 condition, the pristine condition, the
  ambient-`this` condition, the admission call, the adapter's early return, the `<!--` test, the `-->` test, the
  comment-end prefix, and the site predicate's HTML check.
- **Census.** 12 acceptance files, real harness: 12 pass. 118 A0 files: real and stand-in each 12 pass, 1 fail, 105
  compile errors, as on `cfcee6c6`. Against `f6ae7432` with both harnesses, no file passes or fails differently. 15 (real) and 13 (stand-in) compile
  errors stop earlier, at the admission refusal, where lowering used to reach a later stop first:
  - 13 now read A5: 4 `identifier "String" is not in scope`, 3 `direct call to "eval" has no exact AST-site plan`
    (`cptn-nrml-expr-obj`, `cptn-nrml-expr-prim`, `typeof/syntax`), 2 `unknown class "RegExp"`, 2 dynamic `+`
    (`S15.10.4.1_A5_T3`, `cptn-thrw-prim`), 1 `.indexOf` on string, 1 heterogeneous array sink (`S12.6.3_A5`).
  - 2 (real only) now read A4 instead of `identifier "globalThis" is not in scope`:
    `S15.3.4.3_A3_T9` and `S15.3.4.4_A3_T9`. Their related site discards its value but the A4 proof fails for the
    program; lowering used to stop at the runtime shim's `globalThis` read first.

### Review RV-PR7502 round 2 (2026-11-27, head `c7b9f256`): one blocker, fixed

- **Block: a dead-code site refused programs that main compiles.** Admission saw every site, so
  `var v; do { break; v = eval("1"); } while (false);` refused by the A5 label, and the same dead site beside an
  escaping sloppy `this` by A4's.
  - A5: `discardsValue` joins the site predicate (`literalEvalText`), so a site whose value is used makes no source
    and refuses exactly as on main (`direct call to "eval" has no exact AST-site plan` where it is reached). The A5
    label is gone.
  - A4: its select-time refusal now falls back to the compile without texts like every other failure, so a dead site
    compiles as on main; a reached one still answers by A4's name when main's compile refuses too (pinned: two
    compiles). The early return by code is gone.
  - Both dead-code programs are pinned to compile and run.
- **Optional, taken: `discardsValue` recurses.** A comma's right operand and a conditional's arm are discarded when
  their own expression is (`0, eval("1");`, `c ? eval("1") : 0;`, `void (c ? 0 : eval("1"));` lower and run, as on
  `cfcee6c6`); a used one and a conditional's condition make no source. The for-incrementor clause stays excluded.
  Four mutations (site predicate, comma recursion, conditional arm, condition exclusion) each turn a pin red.
- **Measured** on this head, `npx tsx scripts/ir-census/prepared-census.mts --files <list> --out <fresh> --harness
  <h> --jobs 3`: the 12 acceptance files pass (real harness). The 118 files: 13 pass, 105 compile errors, 0 fail, in
  both harnesses (was 12 / 105 / 1). `built-ins/Function/15.3.5.4_2-12gs.js` passes now: its value-using site makes
  no source. The 72 files at the A5 label now stop where they stopped before A5 existed; the other 45 are unchanged.

