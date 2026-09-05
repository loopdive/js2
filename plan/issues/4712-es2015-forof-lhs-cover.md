---
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
status: done
priority: high
depends_on: []
es_edition: es2015
language_feature: for-of-assignment-head-cover
task_type: bug
files:
  - src/codegen/statements/loops.ts
  - tests/issue-4712.test.ts
loc-budget-allow:
  - src/codegen/statements/loops.ts
func-budget-allow:
  - src/codegen/statements/loops.ts::compileForOfArray
  - src/codegen/statements/loops.ts::compileForOfDirectIterator
  - src/codegen/statements/loops.ts::compileForOfIterator
---

# Issue 4712 — ES2015 `for-of` assignment-head CoverParenthesizedExpression

## Scope

Close the synchronous ES2015 `for-of` assignment-head rows whose left side is
an assignment expression covered by `CoverParenthesizedExpressionAndArrowParameterList`:

- `test/language/statements/for-of/head-lhs-cover.js`
- `test/language/statements/for-of/head-lhs-async-parens.js`

This slice is limited to synchronous assignment heads and their direct
head-expression controls. It excludes destructuring, lexical TDZ/fresh
bindings, async iteration, Set/Map, and IteratorClose behavior.

## Live current-main baseline (before source edits)

Baseline was run from `upstream/main` at `cd1677bcef59de3d7882125bf8fdce9ff82e714c`
with the initialized Test262 submodule at `b363f29d3c43c626dc852744ad64a0b48a003693`.
The authoritative `runTest262File` runner was invoked directly with absolute
paths for each file; the result below is therefore a fresh compile/run, not a
committed dashboard artifact.

| path | baseline status | exact signature |
| --- | --- | --- |
| `for-of/head-lhs-cover.js` | `fail` | `Test262Error: Expected SameValue(«undefined», «23») to be true; assignment never updates `x` |
| `for-of/head-lhs-async-parens.js` | `fail` | `Test262Error: Expected SameValue(«undefined», «7») to be true; assignment never updates `async` |

The same assignment-write defect is reproduced by the directly related
positive controls `head-lhs-member.js` (`x.y` remains `undefined`) and
`head-lhs-async-dot.js` (`async.x` remains `0`). `head-lhs-async-escaped.js`
currently has the separate compile-time signature `'async' is not allowed as a
left-hand side identifier in for-of` and is excluded from this bounded slice.
Adjacent controls that already pass and must stay green are
`head-expr-no-expr.js`, `head-decl-no-expr.js`, `head-lhs-async-invalid.js`,
`head-lhs-cover-non-asnmt-trgt.js`, `head-lhs-invalid-asnmt-ptrn-ary.js`,
`head-lhs-invalid-asnmt-ptrn-obj.js`, `head-lhs-non-asnmt-trgt.js`,
`head-lhs-let.js`, `head-expr-obj-iterator-method.js`, and
`head-expr-primitive-iterator-method.js`. `head-expr-to-obj.js` remains an
unrelated runtime assertion failure (the expected TypeError is not rendered as
an object) and is not admitted as a control.

The compiler accepts minimal equivalents outside the literal Test262 harness
(`var x; for ((x) of [23]) {}` and `let async; for ((async) of [7]);`), so the
failure is not a parser-wide inability to parse these heads. The current
failure is a missing assignment-target write in the for-of lowering path used
by the complete test body/harness.

## Root-cause hypothesis and bounded plan

1. Reproduce the missing-write result with the literal harness and inspect the
   AST/lowering route for a parenthesized assignment head.
2. Normalize only the CoverParenthesizedExpression wrapper at the synchronous
   `for-of` assignment target boundary, retaining member/identifier semantics
   and existing invalid-target early errors.
3. Route the unwrapped assignment target through the existing array and generic
   iterator write paths; do not broaden this change to destructuring, lexical
   heads, async iteration, collection specialization, or close handling.
4. Add focused regression coverage for the two exact rows and the listed
   positive/negative controls, then compile and run 3–5 representative Test262
   files plus scoped equivalence tests.

Maximum changed source LOC: 180 (tests and this planning artifact are outside
That source LOC budget).

## Acceptance

- Both exact rows pass the authoritative Test262 runner in the synchronous host
  lane, with no `undefined.kind` compile error.
- Positive controls `head-lhs-member.js` and `head-lhs-async-dot.js` pass.
- The adjacent parse/early-error controls listed above remain passing.
- No destructuring, lexical TDZ/fresh-binding, async iteration, Set/Map, or
  IteratorClose behavior changes are introduced.
- Scoped TypeScript/build checks and the focused tests pass from a branch
  rebased only by merging the latest upstream main (no force push or rebase).

## Test Results

Implementation is confined to `src/codegen/statements/loops.ts`: the lowering
now unwraps only parenthesized assignment heads, reuses the existing local for
an unwrapped identifier, and sends member/element targets through
`emitAssignToTarget`. Destructuring and existing declaration paths remain
unchanged. Focused coverage is in `tests/issue-4712.test.ts`.

From the implementation branch, after the live baseline above:

```text
node_modules/.bin/vitest run tests/issue-4712.test.ts --reporter=verbose
14 passed (2 exact rows, 2 member-write controls, 10 adjacent controls)
```

The direct authoritative `runTest262File` invocation produced the same 14/14
passing results. `git diff --check` is clean and the changed compiler source
is 65 lines, below the 180-line budget. A repository-wide `tsc --noEmit`
attempt remains blocked by the existing worktree dependency/type-resolution
environment (many unrelated missing Node globals); it does not affect the
focused compile/run checks or their 14/14 result.
