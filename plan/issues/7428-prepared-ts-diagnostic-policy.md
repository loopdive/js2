---
id: 7428
title: "The Prepared front door and its test262 lane apply the ordinary compiler's diagnostic policy"
status: in-review
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: ir, compiler, test262
goal: ir-full-coverage
depends_on: []
related: [7354, 1927]
# 2026-11-19: src/compiler.ts +12, `singleSourceHasHardTypeErrors`, the single-source
# compiler's type gate, extracted from compileSourceSync and now asked by the strict
# Prepared entry too, in place of the presentation's blanket refusal of every
# error-severity diagnostic (src/compiler/ir-program-presentation.ts -2). The gate sits
# beside isHardTypeScriptDiagnostic, which it wraps; moving it out would split the one
# rule across two modules.
loc-budget-allow:
  - src/compiler.ts
---

# #7428: the Prepared front door and its test262 lane apply the ordinary compiler's diagnostic policy

## Problem

Two rules on the Prepared path (front door `wholeProgram: { kind: "prepared-program-required" }`) were
stricter than the ordinary compiler's, with no reason recorded:

1. **Compiler.** The ordinary single-source compile refuses a program only on a parser error or a hard TypeScript
   diagnostic (`HARD_TS_DIAG_CODES`, `isHardTypeScriptDiagnostic`); every other TypeScript error is reported and
   tolerated (#1927). The Prepared presentation (`src/compiler/ir-program-presentation.ts`) instead refused every
   error-severity diagnostic ("analyzed frontend errors cannot become prepared artifacts"). So
   `function f(){} if (f.p !== undefined) throw 1; f.p = 1;` (TS2565, which the ordinary compiler compiles) never
   reached the IR, and a single-source allowJs request got its TS2322 refusal from that gap rather than from the
   single-source rule.
2. **test262 worker.** `scripts/test262-worker.mjs` scored a Prepared result with any entry in `errors`, warnings
   included, as `compile_error`, while the ordinary lane refuses only an unsuccessful result or an error-severity
   entry. `observePreparedExecutionJobResult` (`scripts/test262-prepared-request.mjs`) had the same any-entry rule,
   so a warning would also have voided the execution report.

## Fix

1. `singleSourceHasHardTypeErrors` (`src/compiler.ts`) is the single-source type gate. `compileSourceSync` and
   `runPreparedIrPipelinePresentation` both ask it; the Prepared pipeline asks it after the early-error pass, so
   `class let {}` (TS1213, hard and an early error) keeps its certified early rejection. The test262 Prepared entry
   passes `multiAst: null` for a single-source request, as the ordinary single-source compile does; a multi-source
   request keeps `collectMultiDiagnostics`' graph rule. The presentation's blanket refusal is deleted.
2. `compileResultHasErrors` (`scripts/test262-prepared-request.mjs`) is the ordinary lane's predicate, moved out of
   the worker so that the worker's ordinary refusal, its Prepared refusal, its `preparedCompilationSucceeded`
   bookkeeping and the execution report all ask the same rule. The worker's lenient #2912 warning arm (a negative
   test passed on a warning's error type) stays ordinary-lane only: the Prepared lane certifies a compile-time
   negative only through its owned frontend failure.

## Acceptance

- A tolerated TypeScript error (TS2678) no longer refuses a Prepared compile; a hard one (TS2322, allowJs
  single-source) still does, as `output-failed` without a frontend certification; `class let {}` stays an early
  rejection (`tests/test262-prepared-entry.test.ts`).
- The worker refuses a Prepared result only on `compileResultHasErrors`; a warning-only result yields an execution
  report (`tests/issue-7428-prepared-ts-diagnostics.test.ts`).
- No duplicate predicate: each rule has one definition and every caller asks it.

## Measured (2026-11-19)

Census: `scripts/ir-census/prepared-census.mts` from `origin/claude/es5-census-1119`, with the worker's
original-harness options, on 200 files drawn at random (`shuf`, fixed seed) from the 923 files of
`plan/log/es5-ir-only-census-2026-11-19-lists/new-on-a-plain-function-this-instanceof.tsv`.

| Tree                                         | Harness  | pass | compile_error | other | rows that differ |
| -------------------------------------------- | -------- | ---: | ------------: | ----: | ---------------: |
| origin/main 89e4748241                       | real     |    0 |           200 |     0 |                  |
| this branch                                  | real     |    0 |           200 |     0 |                0 |
| origin/main 89e4748241                       | stand-in |    0 |           200 |     0 |                  |
| this branch                                  | stand-in |    0 |           200 |     0 |                0 |
| claude/7354-c-strict b3f68b03~1 / b3f68b03   | real     |  0/0 |       200/200 |   0/0 |                0 |

Yield 0. Two reasons, both measured:

- **An earlier wall stops every file.** With the real harness, 190/200 stop in `assert.js` (on main
  `dyn.typeof has no Prepared intrinsic`; on the slice C stack `ToPrimitive of an object`), 9 at
  `unknown class "Test262Error"` in `isConstructor.js`/`assertRelativeDateMs.js`, 1 in the test. Behind a stand-in
  harness, 119 stop at `unknown class "Test262Error"` in the test body and 59 at `'this' reference outside an
  instance method body`.
- **The worker passes `skipSemanticDiagnostics: true`**, so TypeScript's semantic diagnostics (TS2350, TS2683,
  TS2565, …) are never produced in the test262 lane. No sampled row carried a TypeScript diagnostic or a warning on
  either tree. The test262 lane's benefit therefore waits on those walls and is limited to warnings the compiler
  itself reports; the compiler change matters to callers that keep semantic diagnostics.
