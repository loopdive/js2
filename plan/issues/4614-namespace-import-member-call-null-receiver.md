---
id: 4614
title: "namespace-import member calls of compiled sibling modules compile to a null receiver — cookie vitest harness 65/63740"
status: done
completed: 2026-08-22
sprint: current
created: 2026-08-22
updated: 2026-08-22
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: modules
goal: npm-library-support
related: [4530, 4611]
files:
  - src/codegen/expressions/calls.ts
  - src/codegen/type-coercion.ts
loc-budget-allow:
  - src/codegen/expressions/calls.ts
  - src/codegen/type-coercion.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/expressions/calls.ts::tryNamespaceImportMemberCall
  - src/codegen/type-coercion.ts::coerceType
---

# `import * as ns` + `ns.f()` from a compiled sibling module calls null

## Problem

The cookie vitest-harness upstream suite reads 65/63740 locally while the
npm-compat dashboard card is green: the generated spec module binds the
package as `import * as cookie from ".../dist/index.js"` and every test calls
`cookie.parseCookie(...)`. The compiler has no value for a namespace-import
binding of a compiled sibling module — the WAT shows the receiver compiled as
`ref.null extern` and the call lowered to `__extern_method_call(null,
"parseCookie", args)`, which throws `Cannot read properties of null` for every
test. Minimal reduction (fails on origin/main; predates this branch):

```js
// lib.mjs
export function parseCookie(s) { return "p:" + s; }
// main.mts
import * as cookie from './lib.mjs';
export function t1(): string { return cookie.parseCookie("x"); }
```

The npm-compat pipeline avoids the shape (different generated harness), which
is why the dashboard stayed green while every namespace-import consumer breaks.

## Fix (landed with this issue)

`ns.member(...)` where `ns` is a NamespaceImport is statically resolvable per
ESM semantics. `tryNamespaceImportMemberCall` (calls.ts, early in
`compileCallExpression`): resolve the member alias through the checker to its
FunctionDeclaration (with a body — ambient/external modules decline), require
the name in `ctx.funcMap`, and re-enter `compileCallExpression` with a
synthetic call whose callee is the target declaration's own name identifier —
the same lowering as the equivalent named-import call, including the
`arguments`/rest protocol.

Out of scope (unchanged): namespace VALUE reads (`const f = ns.f`,
`Object.keys(ns)`) — those still need a real namespace-object
materialization; no known curated-package test depends on them.

## Acceptance criteria

- [x] Reduction round-trips (`tests/issue-4614-namespace-import-call.test.ts`).
- [x] cookie vitest harness recovers past the dashboard level: **63670/63740**
      (was 65).

## 2026-08-22 second defect (same harness): null ternary arm materialized as an empty vec

After the namespace fix, cookie sat at 77/63740: every `it.each` registration
vanished. `__upstreamEach`'s `const tableRows = cond ? __upstreamTableRows(...)
: null` binds to a vec-typed slot; the externref→vec coercion's cast-fail arm
(`ref.test` answers false for null) ran the inline materializer, which built an
EMPTY VEC from null (`__extern_length(null)` → 0). `tableRows === null` read
false, `tableRows || cases` selected the phantom empty table, zero rows
registered. Fix (type-coercion.ts): the vec cast-fail arm now short-circuits
`ref.is_null` → `ref.null $vec` before materializing — matching the
`__vec_from_extern_<idx>` helper's documented case 1, which the inline arm
never had. cookie: 77 → 63670/63740. Guards green: #2831 materializer, #3244/
#4289/#4428/#4531 carriers, multi-file; the 4 local issue-3368 failures
reproduce identically on pure origin/main (pre-existing local-env).
