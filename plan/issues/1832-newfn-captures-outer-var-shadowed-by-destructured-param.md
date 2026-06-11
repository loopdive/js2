---
id: 1832
title: "compileNewFunctionExpression captures outer var shadowed by a destructured param"
status: done
created: 2026-06-04
updated: 2026-06-10
completed: 2026-06-10
priority: medium
feasibility: low
task_type: bugfix
area: codegen
goal: correctness
sprint: 61
pr: 1277
claimed_by: codex-developer
claimed_at: 2026-06-07T05:36:47.276Z
---

# #1832 — destructured param shadowing fails in new-function-expression

## Symptom

`function({a}){ return a }` where an outer scope also has `a`: the body reads the
captured outer `a` instead of the param bound by destructuring.

## Location

`src/codegen/expressions/new-super.ts:1084`: `isOwnParam` is
`parameters.some(p => ts.isIdentifier(p.name) && p.name.text === name)` — binding
patterns never match, so the name is added to `captures`.

## Fix

Use `collectBindingPatternNames`/`isOwnParamName` (already exported from
closures.ts) instead of the identifier-only check.

## Progress (2026-06-04, dev-w1) — capture-detection fixed; path has a broader gap

Applied the documented fix: `new-super.ts:1084` now calls
`isOwnParamName(funcExpr, name)` (from `src/codegen/closures.ts`, which already
recurses through object/array binding patterns) instead of the identifier-only
`p.name.text === name` check. A name bound by a destructured param is no longer
mis-classified as a free variable and captured from an outer scope. Typechecks
clean.

**Why status stays `ready` (partial):** I could not build a passing behavioral
repro. The whole `new (function (...) { this.X = ... })(args)` path
(`compileNewFunctionExpression`) traps at runtime (`WebAssembly.Exception`)
**even for a plain identifier param** (`new (function(a){this.r=a})(7)`) — on
both pristine main and with this fix — so a separate constructor-invocation /
`this`-assignment lowering gap in that path masks the capture-detection fix.
The capture-detection change is the correct localized fix for the issue's
stated root cause and cannot regress (it only _widens_ what counts as an own
param), but verifying the end-to-end symptom needs the broader
`compileNewFunctionExpression` runtime path fixed first (senior-dev/architect
sized). Same shape as #1828/#1830/#1831 this sprint: a correct localized
runtime/codegen fix sitting under a broader unreachable path.

## Progress (2026-06-07, codex-developer) — regression coverage added

Current branch/main already contains the localized `compileNewFunctionExpression`
capture fix: destructured parameter names are filtered with `isOwnParamName`
instead of the old identifier-only parameter check.

Added `tests/issue-1832.test.ts` to pin the capture-candidate behavior without
depending on the still-broken constructor runtime path. The tests cover:

- object binding params shadowing an outer name (`{ a }`)
- renamed and nested object bindings (`{ value: a, nested: { b } }`)
- nested array bindings (`[a, [, b]]`)

Validation:

- `pnpm exec vitest run tests/issue-1832.test.ts` — pass (3 tests)
