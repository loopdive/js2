---
id: 1937
title: "Linear backend: break/continue are never compiled (silent infinite loops); dispatchers need default-arm diagnostics"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen-linear
language_feature: compiler-internals
goal: correctness
---
# #1937 — Linear backend: fail loud; implement break/continue

## Problem

Despite #1868 (surfacing `ctx.errors` to `compiler.ts`), the linear
backend's dispatchers still **fall through silently** on constructs they
don't handle, because neither has a default arm:

- `compileStatement` (`src/codegen-linear/index.ts:519-732`) ends at
  `isThrowStatement` with no else. **`break` and `continue` are never
  compiled** — there is no `ts.isBreakStatement` anywhere in the file, even
  though `breakStack`/`continueStack` are pushed/popped
  (`index.ts:603-611`) and never read. `while (true) { if (x) break; }`
  compiles to an **infinite loop with zero diagnostics**. No `break` test
  exists in `tests/linear-controlflow.test.ts`.
- `compileExpression` (`index.ts:1230-1475`) ends at
  `isObjectLiteralExpression` with no else: `typeof`, `await`, spread,
  tagged templates, regex literals compile to **zero instructions** — a
  stack-arity hole surfacing (at best) as an opaque validator error.
- `throw` lowers to bare `unreachable` (`index.ts:728-731`) — exception
  semantics silently replaced by a trap (contrast try/catch, which #1838
  correctly made a hard error).
- Truthiness is `f64.ne 0` (`index.ts:2158-2166`): `if (NaN)` is truthy.
- Diagnostics that do exist mostly carry `line: 0, column: 0`
  (`index.ts:2355, 2453, 2811`).
- Switch fall-through from a non-empty case body is silently dropped
  (`index.ts:1122-1228`).

## Proposed approach

1. **Implement break/continue** — the depth stacks already exist; emit
   `br $breakDepth` / `br $continueDepth`. Add loop tests incl. labeled-less
   nested loops.
2. Add `else` arms to both dispatchers: push a located `ctx.errors` entry
   ("Unsupported in linear backend: <SyntaxKind>") AND keep the stack
   balanced (or rely on the #1868 success gate — but the diagnostic must
   exist). Same for `throw` (named diagnostic, not silent trap, until real
   exceptions land).
3. Fix truthiness for NaN (`f64.eq self` test) and document the string case.
4. Thread real positions (`getLineAndCharacterOfPosition`) into linear
   diagnostics — the helper exists in the GC backend.
5. Switch: hard error on non-empty-body fall-through until implemented.

## Acceptance criteria

- `break`/`continue` loop tests pass in `tests/linear-controlflow.test.ts`.
- Every unsupported construct yields `success: false` with a located message
  (table-driven test over a list of unsupported snippets).
- `if (NaN)` takes the else branch (test).

## Implementation notes (resolved 2026-06-11)

All in `src/codegen-linear/index.ts`.

**break/continue (`compileBreakContinue` / statement dispatcher).** The depth
stacks already existed but were never read. Each loop lowering pushes the
target label's *interior block depth* onto `breakStack` / `continueStack`; a
`break`/`continue` then emits `br (fctx.blockDepth - target - 1)`. Every
`if`/`block`/`loop`/case-arm increments `fctx.blockDepth` around the
statements it compiles, so the relative `br` depth stays correct no matter how
deeply the statement is nested.

**continue must run the loop's "tail" (incrementor / condition re-test).** A
naive `continue → br loop-head` skips the for-incrementor (infinite loop on the
continued iteration) and the do-while condition re-test. Fix: the loop body is
compiled into an **inner `block`**, so `continue` is `br` out of that inner
block — control then falls through to the incrementor/condition that sits
*after* the inner block but *inside* the loop. Loop nesting is therefore
`block(+1) loop(+2) inner(+3)`; for-of-Map reuses the existing
`if (hash != 0)` then-arm as the continue target (exiting it falls through to
the index bump). Verified: `for(...){if(x)continue;}` and
`do{if(x)continue;}while(...)` terminate and advance correctly.

**switch.** Wrapped the whole cascade-of-`if`s in one `block` that is the
`break` target (pushed onto `breakStack` only — `continue` passes straight
through to the enclosing loop). C-style fall-through out of a *non-empty* case
body cannot be expressed by this cascade (the next case re-tests its condition
instead of running), so `statementTerminates` checks the last statement and a
non-terminating non-empty body is a **hard error** rather than a silent skip.

**NaN truthiness (`emitTruthyCoercion`).** `f64.ne 0` alone made `if (NaN)`
truthy. Per §7.1.2 ToBoolean a Number is false for +0/-0/NaN, so truthiness is
`f64.abs(x) > 0` — abs folds -0 to 0 and `NaN > 0` is false, covering all
three falsy values with no scratch local or operand re-evaluation.

**`%` operator (`compileBinaryExpression`).** The `PercentToken` switch arm
was EMPTY: `a % b` compiled both operands and no operator — the expression's
"result" was just `b` and the leftover `a` corrupted stack arity (found via
the new break/continue tests using `i % 2`). Wasm has no `f64.rem`; lowered
as `a - trunc(a/b) * b` via temp locals (JS sign-of-dividend semantics; known
divergence: `b = ±Infinity` yields NaN instead of `a`). The binary-operator
default arm now also drops both operands and pushes a placeholder alongside
its located diagnostic, so unknown operators fail loud with balanced arity.

**fail-loud default arms.** Both `compileStatement` and `compileExpression`
gained `else` arms that push a located `ctx.errors` entry (the #1868 success
gate then bails with `success:false`). `throw` and labeled break/continue get
named diagnostics instead of a silent `unreachable`/mis-target. Positions come
from `nodeLoc(node)` (`getLineAndCharacterOfPosition`). Type-only statements
(`type`/`interface`/`debugger`/`;`) and type-only expressions
(`as`/`satisfies`/`<T>x`) are erased without a diagnostic.

Tests: `tests/linear-break-continue.test.ts` (new — Map/array for-of + a
table-driven fail-loud sweep) and `tests/linear-controlflow.test.ts`
(extended). No regressions across the existing linear suites.

## Source

Compiler quality review 2026-06. Direct child of #1858; extends #1868/#1838.
