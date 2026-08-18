---
id: 3632
title: "folded eval body skips Script early errors — strict-mode reserved words and stray break/continue silently compile"
status: done
completed: 2026-07-28
sprint: 78
goal: es5
priority: medium
horizon: m
feasibility: medium
---

# The folded eval path does not run the eval Script's early errors

## Problem

`tryStaticEvalInline` parses the constant eval string with
`ts.createSourceFile(..., ScriptKind.JS)` and rejects only on
`parseDiagnostics`. TypeScript's parser reports **syntactic** diagnostics; it
does **not** report the ECMAScript **early errors** that an eval Script must
raise before evaluating anything:

- strict-mode early errors when the body has a `"use strict"` prologue —
  `var public = 1`, `var implements`, assignment to `eval`/`arguments`,
  duplicate parameter names, octal literals;
- `break` / `continue` with no enclosing iteration or labelled statement
  (an eval body is its own Script — a `break` inside it can never bind to a
  loop in the _caller_).

Because the splice skips them, the body compiles and runs, and the expected
`SyntaxError` never arrives.

**The important part: on this axis the folded path is _less_ correct than the
dynamic path it is meant to replace.** `__extern_eval` routes to a real host
eval that does enforce the early errors. So the constant-folding fast path is a
correctness _regression_ against its own fallback here — which is why widening
the folder's reach without also giving it an early-error pass would make things
worse, not better.

## Probe (current HEAD, host mode, `tests/probe-eval-mvp.test.ts` — gitignored)

| probe                                   | got      | spec          | verdict  |
| --------------------------------------- | -------- | ------------- | -------- |
| `eval("'use strict'; var public = 1;")` | no throw | `SyntaxError` | **FAIL** |
| `eval("break;")`                        | no throw | `SyntaxError` | **FAIL** |

Re-run against unmodified `origin/main` (`3a262054c6`).

## Measured denominator

Baseline: `test262-current.jsonl` fetched 2026-07-25 18:21. Population =
ES5-classified (post-#3626 classifier), `eval`-dependent, host lane: 775 tests,
**484 not passing**. Of those, the failures reporting a _missing_ `SyntaxError`
and reaching a body the folder accepts:

| family                                                     | tests | signature                                           |
| ---------------------------------------------------------- | ----- | --------------------------------------------------- |
| `language/directive-prologue/10.1.1-{5,8,14,30,31,32}-s`   | 6     | `Expected a SyntaxError…` / `public is not defined` |
| `language/statements/variable/12.2.1-{7,8,18,19}-s`        | 4     | `Expected a SyntaxError to be thrown…`              |
| `language/eval-code/{direct,indirect}/parse-failure-{3,4}` | 4     | `break`/`continue` must throw `SyntaxError`         |
| `language/statements/{break/S12.8_A7,continue/S12.7_A7}`   | 2     | `break`/`continue` within eval inside an iteration  |

**16 ES5 tests measured** — a floor, not a flip prediction: a test whose first
assertion is the missing `SyntaxError` may have further assertions behind it.
Corpus-wide was not measured.

Additionally **21 standalone-lane** failures report
`Expected a SyntaxError but got a undefined` (standalone baseline, same date),
consistent with the same missing early-error pass in the folded path — the
folded path is the _only_ path in standalone mode.

## Implementation direction

Add an early-error validation walk over the parsed eval `SourceFile` between the
`parseDiagnostics` check and `allNodesInlineSupported`, returning `undefined`
(fall through to the dynamic path) is **not** sufficient in standalone mode
where there is no dynamic path — so the walk should instead emit a
`SyntaxError` **throw** at the eval call site. Minimum ruleset:

1. `bodyIsStrict` (already computed at
   `src/codegen/expressions/eval-inline.ts`, `evalBodyHasUseStrictDirective`)
   ⇒ reject strict reserved words as binding identifiers
   (`implements interface let package private protected public static yield`),
   assignment to `eval`/`arguments`, and octal literals.
2. `break` / `continue` with no enclosing iteration/labelled statement **inside
   the eval Script** ⇒ `SyntaxError`. The eval body is a fresh Script; the
   caller's loops are not in scope for it.

## Acceptance criteria

- `eval("'use strict'; var public = 1;")` and `eval("break;")` both throw `SyntaxError`.
- The 16 tests listed above pass in the host lane.
- `tests/issue-2923-eval-const-broaden.test.ts` still green (no `__extern_eval` leak in the standalone folded modules).

## Not covered here

Full strict-mode semantics inside eval (`this` binding, var-environment
isolation), direct eval with a runtime string (#3630), standalone eval (#1066).
