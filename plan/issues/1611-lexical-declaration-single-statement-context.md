---
id: 1611
title: "parser: lexical declaration in single-statement context rejected for valid newline-separated cases"
status: done
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
task_type: bugfix
area: parser
language_feature: lexical-declarations, asi
goal: compiler-correctness
sprint: 56
es_edition: multi
test262_count: 16
---
# #1611 — `let`/`const` in single-statement context: valid newline cases rejected

## Problem

16 test262 tests fail with:

```
Lexical declaration cannot appear in a single-statement context
```

The cluster is the `let-identifier-with-newline` / `let-block-with-newline`
family under `for-in`, `for-of`, and `if`. In these tests `let` appears on its
own line and, per ASI, is parsed as an *identifier reference* followed by a
newline — NOT a lexical declaration — so the program is actually valid. The
compiler eagerly classifies the token as a lexical declaration and rejects it.

## Failing test examples

- `test/language/statements/for-in/let-identifier-with-newline.js`
- `test/language/statements/for-of/let-block-with-newline.js`
- `test/language/statements/if/let-block-with-newline.js`

## Root-cause hypothesis

The parser/early-error check treats `let` as a lexical-declaration keyword in
the body of `for`/`if` without applying the ASI / `let [` disambiguation rules
(ECMA-262: `let` followed by a line terminator and then an identifier is an
ExpressionStatement, not a LexicalDeclaration). Refine the single-statement
lexical-declaration early error to respect the newline-based disambiguation.

## Acceptance criteria

- The newline-separated `let` identifier/block cases compile (or correctly
  pass/fail per the test's `negative` expectation).
- >=12 of the 16 tests move off `compile_error`.

## Fix

`src/compiler/validation.ts` — new `isAsiLetExpressionStatement` helper, wired
into both the single-statement-position check and the labeled-statement check.
Per ECMA-262 the ExpressionStatement lookahead restriction is only `let [`
(with **no** `[no LineTerminator here]`), so `let` + LineTerminator +
(identifier | `{`) is an ExpressionStatement (`let` identifier reference)
closed by ASI — valid in single-statement / labeled position. `let [` stays a
lexical declaration even across a newline; `const` is always a reserved word so
it is never relaxed.

## Test Results

Checked all 25 `*with-newline*` test262 files under `language/statements`
(for/for-in/for-of/for-await-of/if/while/do-while/labeled/with): 25/25 now
classify correctly — 17 positive (`let-identifier` / `let-block`) no longer
emit the single-statement/labeled early error, 8 negative (`let-array`) still
correctly error. Regression test: `tests/issue-1611.test.ts` (14 cases, all
pass). `labeled-loops.test.ts` (7 fail) and `issue-202` "var used before
declaration" failures pre-exist on `origin/main` — unrelated to this change.
