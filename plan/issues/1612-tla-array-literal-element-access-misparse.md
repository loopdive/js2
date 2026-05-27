---
id: 1612
title: "parser: top-level-await with array-literal operand misparsed as element access ('should take an argument')"
status: done
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
task_type: bugfix
area: parser
language_feature: top-level-await, array-literals
goal: compiler-correctness
sprint: Backlog
es_edition: es2022
test262_count: 14
---
# #1612 — TLA + array-literal operand misparsed as element access

## Problem

14 test262 tests fail with:

```
An element access expression should take an argument.
```

All are `language/module-code/top-level-await/syntax/*-array-literal` tests:
`await [x]`, `if (await [x])`, `void await [x]`, `export let y = await [x]`,
etc. The parser treats the `[...]` array literal following `await` as a
**member/element-access bracket** on the awaited value rather than a fresh
ArrayLiteral expression, then errors because the bracket is "empty" or
malformed for element access.

## Failing test examples

- `test/language/module-code/top-level-await/syntax/for-await-expr-array-literal.js`
- `test/language/module-code/top-level-await/syntax/if-expr-await-expr-array-literal.js`
- `test/language/module-code/top-level-await/syntax/void-await-expr-array-literal.js`

## Root cause (actual — NOT the compiler parser)

The original hypothesis (parser postfix precedence) is **wrong**. `await []`
compiles cleanly at module scope: `compile("await [];", { module: true })`
and `compile("void await [];\nexport function test(){return 1;}")` both succeed.

The fault is in the **test262 harness**, `tests/test262-runner.ts:wrapTest()`.
It wraps every test body in a *synchronous* `export function test(): number`.
Inside a non-async function, `await` is an ordinary identifier, so
`void await [];` parses as `void (await[])` — element access on the identifier
`await` with empty brackets → "An element access expression should take an
argument."

## Fix

In `wrapTest`, when `meta.features` includes `top-level-await`, emit the test
body at **module top level** (where `await` is a keyword, since the
`export function test` already marks the file as a module) instead of burying
it inside the synchronous `test()`. `test()` becomes a trivial probe of the
harness `__fail` counter. These are syntax-only tests (no assertions), so
running the (inert) await expressions at module init is harmless.

Non-TLA tests are untouched — verified the wrapped output is byte-identical to
`main` for sampled non-TLA tests.

## Result

All 17 `top-level-await/syntax/*-array-literal` tests now compile.
(The 6 `*-obj-literal` syntax tests remain `compile_error` — `void await
{ function() {} }` is a separate obj-literal-after-await parse gap that
predates this fix and is out of scope here.)

Covered by `tests/issue-1612.test.ts`.

## Acceptance criteria

- [x] `await [ ... ]` in module top-level code parses correctly.
- [x] >=10 of the array-literal tests move off `compile_error` (17/17 do).
