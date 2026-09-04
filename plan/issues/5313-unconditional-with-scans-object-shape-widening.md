---
id: 5313
title: "Two unconditional whole-file `with`-statement walks in object-shape-widening.ts cost 7,838 traversals (40 % of the harness compile-budget drift) on sources containing no `with`"
status: ready
sprint: current
created: 2026-09-04
updated: 2026-09-04
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: fix
area: codegen
goal: ir-full-coverage
related: [5306, 3437, 3433, 3374]
requested_by: ttraenkler/opus-5306
---

# Two full-source walks look for `with` on every compile, `with` or not

Bisecting the #3437 harness compile-work budget for
[#5306](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5306-harness-compile-budget-ceiling-margin-exhausted)
pinned 40 % of the 2026-08-20 → 2026-09-04 drift to a single merge:

| | |
| --- | --- |
| commit | `52b61990fe` (2026-08-26) |
| PR | #4922 `fix(es5): combine standalone conformance gains` |
| measured | 131,169 → **139,007** (+7,838) |
| share of total drift | **39.9 %** of +19,641 |

Per-caller attribution (patch the `forEachChildMeter` in `src/ts-api.ts` to
record caller frames; method in #5306's PR) puts **all** of it in one file:

```
+7838   15661 -> 23499  src/codegen/declarations/object-shape-widening.ts
```

and exactly two new whole-source-file walks, each one full pass over the
3,919-node fixture:

1. `markRealmGlobalWithTargets` — an inner arrow inside
   `collectGrowableObjectLiterals`. It recurses the entire source file, and its
   only payload is `if (ts.isWithStatement(node)) { … }`.
2. `visit` inside the new `collectRedeclaredWithTargetObjects`. It collects
   variable declarations *and* `with` targets, and only ever produces a result
   for symbols that are **both** redeclared and a `with` target
   (`if (declarations.length < 2 || !withTargetSymbols.has(symbol)) continue;`).

Both run unconditionally. The #3437 fixture contains no `with` statement, so
both walks are pure cost on it — and `with` is rare in real input too, so this
is pure cost on almost every compile, not just the fixture.

## Why this is worth fixing rather than banking

This is not the #3433 quadratic class (the walks are O(file), not
O(call-sites × file)), so it will not blow up CI. It is worth fixing because it
is ~7.8 k traversals of budget bought for a feature that fires on a construct
almost no source uses, and because the guard already exists as a pattern:
`src/codegen/source-scan-predicates.ts` has short-circuiting predicates of
exactly this shape (`sourceContainsClass`, `sourceContainsBindingPattern`).

For contrast, the other two commits in the same bisection were assessed and
deliberately **not** filed: PR #5204's `prepareIdentityPreservingStructuralParams`
and `mixedAssignmentFacts` are memoized single passes for genuinely new
analysis, and PR #5336's `sourceNodeWeight` is a `WeakMap`-cached node count.
They cost real budget but buy something on every source. These two buy nothing
unless the source says `with`.

## Acceptance criteria

1. Both walks are gated on a **memoized** "does this source contain a `with`
   statement" predicate, living with the other predicates in
   `src/codegen/source-scan-predicates.ts` (memoized per `ts.SourceFile`, so a
   second consumer is free). A cheap pre-filter on `sourceFile.text` before the
   AST walk is acceptable as long as the AST walk remains the authority.
2. `pnpm run check:harness-compile-budget` measures a drop of about 7,838
   traversals from the #5306 budget of 150,774; bank it with `--update` in the
   same PR (a decrease is the sanctioned write).
3. No `with`-related behaviour changes: the equivalence suite and the
   `with`-covering test262 buckets are unchanged. `with` sources must still get
   both scans — the gate is a skip, not a semantic narrowing.

## Non-goals

- Reworking `collectGrowableObjectLiterals` or the redeclaration analysis
  itself. This is a guard, not a redesign.
- Touching PR #5204's or #5336's passes (see above — measured, accepted).
