---
id: 1453
title: "spec gap: per-iteration fresh let/const binding in for-statements"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: for-statement, let, const, closures
goal: spec-completeness
sprint: 52
related: [1128, 1452]
---
# #1453 — `for (let i = …)` requires a *fresh* binding per iteration

## Problem

Per ECMA-262 §14.7.4.4 (`CreatePerIterationEnvironment` /
`ForBodyEvaluation`), a `for (let X = …; …; …) Body` loop creates a
**new lexical environment per iteration**. Each iteration's body runs
against a freshly-allocated binding for `X` that is *initialized to the
value of the previous iteration's binding*. Closures created inside
the body therefore capture distinct bindings.

`const` declarations in for-loop heads have the same semantics
(`for (const i = …; …; …)` is rare but `for (const X of …)` /
`for-await-of` rely on this).

Today we allocate `i` once and reuse it across iterations, so all
closures share one binding and observe the post-loop value:

```js
let a = [];
for (let i = 0; i < 5; ++i) {
  a.push(() => i);
}
a[0]() === 0;  // expected
// We return 5 for every closure.
```

## Failure count

- `language/statements/let/syntax/let-iteration-variable-is-freshly-allocated-for-each-iteration-{single,multi}-let-binding.js` (2)
- `language/statements/for-of/head-let-fresh-binding-per-iteration.js` (1)
- `language/statements/for-of/head-const-fresh-binding-per-iteration.js` (1)
- `language/statements/for-of/head-await-using-fresh-binding-per-iteration.js` (1)

Plus a long tail of higher-level tests that rely on the semantic
(closure-in-loop patterns in observed test262 failures across
class/elements, generators, etc.). Direct fail count is small (~10),
but the dependency cone is large — many tests in
`statements/let/syntax/` and `statements/for*` indirectly assume
per-iteration freshness.

## Root cause

`src/codegen/statements/loops.ts:compileForStatement` allocates one
local per `let` declaration in the header and reuses it across
iterations. There is no per-iteration "copy then reallocate" step.

Closures created inside the body capture the **single** local slot's
index (via the closure ref-cell mechanism). A re-binding per iteration
would require either:

- Allocating a fresh ref-cell struct per iteration and rewriting the
  closure's capture to point at the new cell (semantics: each
  closure created in iteration N captures the cell for iteration N),
  or
- Marking the binding as "per-iteration" and emitting a fresh
  allocation + initial-value copy at the top of each iteration plus a
  fresh-from-previous copy in the update step.

## Implementation strategy

1. Detect "for-loop with `let`/`const` head bindings that are captured
   by closures inside the loop body" — a closure-scan walk on the
   loop body (`closures.ts` already does similar scans for
   ref-cell capture).
2. For each such captured name, allocate a **per-iteration ref cell**:
   - At loop entry: create cell C₀, store the initializer value.
   - At iteration start: create C_{n+1}, copy C_n's current value into
     it; rebind the closure-capture slot to point at C_{n+1}.
   - At iteration end (update step), the loop's `i++` writes into the
     latest cell.
3. Wire the body's closure captures to dereference the per-iteration
   cell (`closures.ts` already supports ref-cell captures; the change
   is in which cell is captured).
4. Update step (per spec): `CreatePerIterationEnvironment` is only
   required when *some* binding in the head is captured; when no
   closure captures any head binding, we can keep the single-local
   path as an optimisation.

Optimisation: when the body provably does not capture any head
binding via a closure (static analysis on identifier uses inside
`ts.ArrowFunction`/`ts.FunctionExpression`/`ts.ClassExpression`
descendants of `stmt.statement`), skip the per-iteration cell
allocation — the observable semantics are unchanged.

## Acceptance criteria

1. `test/language/statements/let/syntax/let-iteration-variable-is-freshly-allocated-for-each-iteration-single-let-binding.js`
   passes.
2. `test/language/statements/let/syntax/let-iteration-variable-is-freshly-allocated-for-each-iteration-multi-let-binding.js`
   passes.
3. `test/language/statements/for-of/head-let-fresh-binding-per-iteration.js`
   passes.
4. `test/language/statements/for-of/head-const-fresh-binding-per-iteration.js`
   passes.
5. No regression on the existing closure-in-loop tests already passing
   (e.g. `tests/issue-1128*`).
6. Common non-capturing for-loops (the overwhelming majority) compile
   to the same wasm as before — the optimisation step is essential to
   avoid perf regression on benchmark loops.

## Files to inspect

- `src/codegen/statements/loops.ts:compileForStatement` (line 295) and
  `compileForOfStatement` / `compileForOfArray` (line 1719+).
- `src/codegen/closures.ts` — ref-cell capture mechanism (search
  `ref-cell`, `__capture_cell`).
- `src/codegen/statements/tdz.ts` — TDZ flags are per-binding; verify
  per-iteration cells don't break TDZ.
- `tests/issue-1453.test.ts` — closure-in-loop semantic tests.

## Out of scope

- `var` declarations in for-heads — single binding semantics
  (function-scope), unchanged.
- `for-in` heads — already use a different path; verify but don't
  rewrite as part of this issue.
