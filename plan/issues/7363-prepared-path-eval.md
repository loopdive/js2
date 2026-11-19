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
loc-budget-allow:
  - src/ir/from-ast.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerCall
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

- One predicate decides whether an `eval` callee is the realm's: `isRealmEval` on the resolver, answered on the
  Prepared path by `prepareRealmEvalResolver` (`src/frontend/eval/realm-eval.ts`, beside the Number plan's proof).
  The symbol must be the lib's alone, and no source may rebind the global binding. Its rebinding rules are
  program-wide and conservative: a top-level declaration named `eval`, any use other than as a callee
  (`evalCalleeCall`, `src/eval-call-shape.ts`), `globalThis`, or an `eval` property name or string.
  - A checker-only test is not enough: the checker reports a script's `var eval = f` as a duplicate and keeps
    resolving the name to the lib (review RV7310 M1).
- `lowerCall`: on the realm's eval, the Prepared resolver has no provider, so the statement refuses by name:
  `ir/from-ast: eval statement has no eval provider in <fn>` (`call-resolution-unsupported`). Any other `eval` is an
  ordinary callee. A resolver with a provider (the ordinary pipeline) keeps its certified-eval branch and invariant
  unchanged.
- Proving program: `tests/issue-7363-prepared-eval-refusal.test.ts`.
  - Literal, in-function, computed and `(0, eval)` statements refuse by name through the strict entry.
  - Each of these stops at its own call gap, never at the eval refusal or the invariant:
    - hoisted top-level and local `var eval`;
    - a hoisted top-level `function eval`;
    - a parameter, a catch binding and a block binding;
    - a later alias, a `globalThis` use, an `.eval` property write, and an `"eval"` string.
  - The ordinary pipeline's invariant still throws when a provider-bearing resolver disagrees.
- Quality criterion: one predicate for "this `eval` is the realm's", asked by slice 1 and by slice 2's direct-eval
  test. The proof follows the Number plan's existing pattern; it is not a second copy of that analysis.

### Slice 2 — direct eval of a string literal as a certified nested program

- The front end parses the literal's program text at compile time: the PerformEval parse (§19.2.1.1) and its static
  early errors.
- The parsed text is lowered as a nested program of the calling function, in the caller's variable environment
  (non-strict) or in its own (strict).
- A literal that is a static SyntaxError lowers to a throw of a SyntaxError.
- Owner: a new `src/ir/eval-literal.ts` beside `from-ast`. `eval-early-errors.ts` and the pure half of
  `eval-script.ts` move to `src/frontend/eval/` and are imported by both pipelines. Legacy's re-exports keep its
  bytes identical.
- Proving program: expression, statement and `var`-declaring literal evals at top level and in a function, each
  checked against node (right answer returns, wrong one throws), plus a static SyntaxError literal.
- Quality criterion: one parse/early-error implementation for both pipelines; `eval-inline.ts` loses its copy of
  the declaration-name walk.

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

- `src/ir/from-ast.ts` `lowerCall` and the resolver contract, `src/frontend/eval/realm-eval.ts`, `evalCalleeCall`;
  the test file above, 15 tests, green. Mutation: deleting any of the six rules of the proof (declaration,
  non-callee use, `globalThis`, property name, string, symbol identity) turns a test red.
- S9's list of the 196 files that crashed (`plan/log/es5-ir-only-census-2026-11-19-lists/crash-eval-owning-predicate.tsv`,
  PR #7308) re-measured on this head with `scripts/ir-census/prepared-census.mts --harness stand-in`: 196 of 196 now
  stop at `ir/from-ast: eval statement has no eval provider` in the test body; none throws.
- Ordinary pipeline bytes identical against `origin/main` on 98 test262 files (70 eval-census files, 28
  Array built-ins) × default and standalone.
- `tests/issue-7106-runtime-eval-a2c-global-eval-arm.test.ts`, `tests/issue-1164-es5-eval-slice.test.ts` and
  `tests/test262-prepared-entry.test.ts` pass.
- Expression-position literal eval still refuses with the generic `direct call to "eval" has no exact AST-site
  plan`. Slice 2 gives it the eval label.


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
