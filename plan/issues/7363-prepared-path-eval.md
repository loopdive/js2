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
