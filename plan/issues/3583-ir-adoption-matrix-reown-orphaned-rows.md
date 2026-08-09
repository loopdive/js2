---
id: 3583
title: "IR adoption matrix: re-own the 28 orphaned mixed/direct-only rows (tracking issues closed or wont-fix)"
status: ready
sprint: current
created: 2026-07-24
updated: 2026-07-24
priority: medium
horizon: m
feasibility: medium
task_type: chore
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
related: [1131, 2952, 2949, 3518, 3522, 1373b]
origin: "2026-07-24 Fable IR-migration review (plan/agent-context/fable-ir-review-2026-07-24.md §3) — 28 of 34 non-ir-owned, non-deferred adoption-matrix rows have no live owning issue"
---

# #3583 — Re-own the orphaned IR adoption-matrix rows

## Problem

`plan/log/ir-adoption.md` is the source of truth for which AST node kinds the
IR owns, and every `mixed`/`direct-only` row is supposed to be a migration
TODO with a tracking issue. As of main @ `7652f0337` (2026-07-24), **28 of
the 34 non-ir-owned, non-deferred rows have no live owner**:

1. **13 rows track #1131 — which is `wont-fix`** (closed 2026-06-12 as the
   superseded middle-end SSA plan): `ExpressionStatement`, `ForStatement`,
   `ForOfStatement`, `TryStatement`, `NullKeyword`, `BinaryExpression`
   (`%`, `**`, `in`, `instanceof` all still throw), `PrefixUnaryExpression`,
   `ElementAccessExpression`, `ObjectLiteralExpression`, `SpreadElement`,
   `FunctionExpression`, `ArrowFunction`, `YieldExpression`.
2. **12 rows track issues that are `done`** while the row is still only
   `mixed`: `VariableStatement` (#1372), `ClassDeclaration` / `ThisKeyword` /
   `NewExpression` / `MethodDeclaration` (#1370), `TemplateExpression` /
   `PropertyAccessExpression` (#1374), `ArrayLiteralExpression` (#1804),
   `CallExpression` (#1371), `ConstructorDeclaration` /
   `GetAccessorDeclaration` / `SetAccessorDeclaration` (#3000).
3. **3 rows have no tracking reference at all**: `AsExpression` /
   `TypeAssertion`, `NonNullExpression` (both listed direct-only despite
   being type-erased pass-throughs — likely near-trivial adoptions),
   `EnumDeclaration` ("(future)").

Rows that DO have live owners and are NOT in scope here: `SwitchStatement` /
`LabeledStatement` / `ForInStatement` / `BreakStatement` /
`ContinueStatement` / `DoStatement` (#2952, ready), `AwaitExpression`
(#1373b, in-progress), `FunctionDeclaration` (#1376, the claim unit itself).

Why it matters: R9 of epic #3518 (the fail-closed IR-only flip) implicitly
requires every one of these rows to reach `ir-owned` or an _acceptable_
typed-Unsupported. Ownerless rows mean unscheduled critical-path work that
the corpus-zero ratchet cannot see (the playground corpus barely exercises
these shapes).

## Acceptance criteria

- [ ] Every `mixed`/`direct-only` row in `plan/log/ir-adoption.md` has a
      Tracking reference to an issue whose status is `ready`/`in-progress`/
      `blocked` (not `done`, not `wont-fix`), or is explicitly re-tagged
      `deferred` with a rationale.
- [ ] Class-family rows (`ClassDeclaration`, `MethodDeclaration`,
      `ConstructorDeclaration`, accessors, `ThisKeyword`, `NewExpression`)
      are re-homed under #3522 (R3) or a dedicated residual issue naming the
      remaining lowering gaps (computed/generator/abstract names, static
      super, subclass-of-builtin).
- [ ] The expression-lowering residue (group 1 above) is triaged into
      per-family owning issues (allocated via `claim-issue.mjs --allocate`)
      or folded into #2949/#2952 scope where the blocker genuinely overlaps.
- [ ] `AsExpression`/`TypeAssertion` and `NonNullExpression` get either a
      cheap adoption PR (pass-through in `from-ast.ts` — verify the selector
      currently rejects them at all) or a corrected matrix row if they are
      already transparently handled.
- [ ] `EnumDeclaration` gets an explicit decision: adopt (const-folding in
      IR) or `deferred` with rationale.
- [ ] `scripts/gen-ir-adoption.mjs` curated data updated; `pnpm run
    gen:ir-adoption` regenerated; `--check` green.

## Notes

- This is triage/ownership work first; actual lowering work should land as
  the newly-allocated child issues, sized separately.
- Cross-reference: the 2026-07-24 review also recommends #3518's R9 row gain
  an explicit "coverage closure" dependency so this class of gap cannot go
  unscheduled again.
