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
# 2026-11-19 (review RV7310 M1): the realm-eval proof is one resolver predicate. from-ast +4 lines: the
# `isRealmEval` hook on the resolver contract and the Prepared refusal, which now asks it (lowerCall +2). The
# proof lives in src/frontend/eval/realm-eval.ts; program-source +2 (its import and one spread line beside the
# Number plan's), which is also the one new ir->frontend edge.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/program-source.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerCall
import-cycles-allow:
  - ir->frontend: 9 # 2026-11-19 (#7363): program-source asks the realm-eval proof, like the Number plan's
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
