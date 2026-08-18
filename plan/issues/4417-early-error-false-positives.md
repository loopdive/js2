---
id: 4417
title: "Three ES early-error checks reject valid TypeScript — 130 false positives across our own source"
status: done
sprint: 78
created: 2026-08-14
updated: 2026-08-18
completed: 2026-08-14
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: compiler
goal: correctness
# +21 lines in node-checks.ts, all of it the comment explaining WHY the arrow
# span starts after the return type and skips past the closing paren. The
# executable change is 4 lines. The comment is the part that stops someone
# "simplifying" it back to `node.parameters.end` and re-breaking 593 files.
loc-budget-allow:
  - src/compiler/early-errors/node-checks.ts
func-budget-allow:
  - src/compiler/early-errors/node-checks.ts::runNodeChecks
---

## Problem

Three checks in `src/compiler/early-errors/` reject valid TypeScript. Measured
across js2wasm's own `src/**` (768 files): **130 hard errors, in exactly these
three classes, every one a false positive on Prettier-formatted code.**

| class                                                   | sites | files | blocks (transitively, of 768) |
| ------------------------------------------------------- | ----: | ----: | ----------------------------: |
| `Arrow function parameters and '=>' must be on same line` |    71 |    43 |                       **593** |
| `Invalid left-hand side in postfix operation`             |    53 |     7 |                           485 |
| `Invalid left-hand side in assignment`                    |     9 |     4 |                           485 |

They were the first wall a whole-program self-compile hit: `compileFiles("src/index.ts")`
resolved and type-checked all 730 files in 4.6 s, then failed at the
early-error gate (`src/compiler.ts:920`) after 19 s. Codegen never ran.

### 1. Arrow ASI — measured from the wrong position

```ts
const f = (
  a: number,
  b: number,
) => a + b; // ← was a SyntaxError
```

The ES rule is `ArrowParameters [no LineTerminator here] => ConciseBody`. The
check measured from `node.parameters.end`, which sits **before the closing
paren** — so every parameter list wrapped across lines contained a newline in
the measured span. A multi-line return type annotation tripped it too.

### 2 & 3. Non-null assertion on an assignment target

```ts
o.n!++; // ← was "Invalid left-hand side in postfix operation"
o.n! = 1; // ← was "Invalid left-hand side in assignment"
```

`isInvalidAssignmentTarget` unwrapped `ParenthesizedExpression` but not
`ts.NonNullExpression`, so `arr[i]!` was never recognised as an element access.
`!` is a **type-level** assertion that erases at emit — these are ordinary
property/element assignments. Our own `codegen/statements/control-flow.ts` has
16 instances of `fctx.breakStack[i]!++`.

## Fix

**Arrow:** start the span after the return type when present, then skip past
the last `)` — the closing paren, and any trailing comma and newlines before
it, are inside `ArrowParameters`. A single unparenthesized parameter has no
paren, so the whole gap is still tested and `a\n=> a` remains an error.

**Non-null:** add `ts.isNonNullExpression` to the unwrap loop — placed
**after** the destructuring test, not before, so `({}) = 1` stays the
SyntaxError it is (§13.15.1: a CoverParenthesizedExpression cannot be refined
to an AssignmentPattern).

## Result

Early-error scan over all 768 `src/**` files:

| | before | after |
| --- | ---: | ---: |
| hard errors in these three classes | **130** | **0** |

And the gate now passes: `compileFiles("src/index.ts")` previously **returned
at 19 s** with 130 errors; it now **runs past 420 s without returning** — it is
in codegen, which is the known super-linear cost, not the gate.

The remaining 1,648 diagnostics are all one pre-existing class,
`Cannot access 'X' before initialization`, reported as warnings. They block
nothing today, but if any reflect a real TDZ mis-analysis they become
correctness bugs the moment codegen runs over this corpus.

## Verification

`tests/issue-4417-early-error-false-positives.test.ts` — 13 tests pinning
**both directions**, because a fix that stops the false positive by letting the
real SyntaxError through is not a fix:

- accepts: multi-line params, multi-line params + return type, `o.n!++`,
  `a[0]!++`, `o.n! = v`, `(x) = 1`, `({a, b} = …)`
- still rejects: `(a, b)\n=> …`, `a\n=> a`, `(a): number\n=> a`, `1 = 2`,
  `1++`, `({}) = 1`, `([]) = 1`, `({})++`

## Note — two genuine errors that DO leak, pre-existing

`g() = 1` and `g()++` are accepted, on `origin/main` as well as here. Assignment
to a CallExpression is an early error per §13.15.1
(`IsValidSimpleAssignmentTarget` is false for a call). Out of scope for this
change — the predicate returns `true` for calls, so the leak is at a call site,
not in the predicate — but worth its own issue.
