---
id: 1937
title: "Linear backend: break/continue are never compiled (silent infinite loops); dispatchers need default-arm diagnostics"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
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

## Source

Compiler quality review 2026-06. Direct child of #1858; extends #1868/#1838.
