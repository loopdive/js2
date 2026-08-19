---
id: 4115
title: "Bind retirement inventory rows to direct-codegen declarations"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
priority: critical
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: test
area: ir, tooling
language_feature: ir-retirement
goal: ir-full-coverage
lane: ir-retirement-r6
parent: 3518
depends_on: [3792]
related: [3090, 4109, 4113]
files:
  - src/codegen/literals.ts
  - scripts/check-ir-optimization-retirement.mjs
  - tests/issue-3792-ir-optimization-retirement-gate.test.ts
  - plan/log/ir-optimization-retirement-ledger.md
  - plan/issues/4115-ir-optimization-source-inventory-gate.md
loc-budget-allow:
  - src/codegen/literals.ts
---

# #4115 — Bind retirement inventory rows to direct-codegen declarations

## Problem

The optimization retirement ledger validates rows that are present, but it
cannot detect a reachable direct-codegen optimization that is missing from the
ledger. It also accepts a free-form symbol label as long as the containing file
exists. That makes the deletion-time parity gate vacuous for omitted owners and
unable to detect a renamed or removed implementation anchor.

## Scope

- Introduce source inventory v1 using `@irOptimizationOwner` annotations on
  named top-level direct-codegen declarations.
- Derive exact `source::symbol` identities from the TypeScript syntax tree and
  join them one-to-one with ledger IDs and `directOwner` claims.
- Fail on an omitted annotated owner, a dangling ledger anchor, mismatched or
  duplicate identities, malformed annotations, and a zero-owner denominator.
- Add a synthetic unclassified source owner as a positive kill control.
- Source-anchor two existing array pre-sizing decisions without changing their
  runtime behavior.

## Acceptance criteria

- Removing either side of a migrated source/ledger pair fails the checker.
- Renaming a migrated declaration or ledger identity without updating the
  other side fails with the exact identity mismatch.
- A source annotation whose stable ID has no ledger row fails.
- Duplicate IDs and duplicate `source::symbol` identities fail.
- Enabling source inventory v1 with zero annotated owners fails.
- Existing rows not yet migrated to source anchors retain their current schema
  behavior.

## Remaining v2 denominator work

This slice establishes a non-empty, syntax-bound denominator for migrated
rows. It does not discover reachable direct-codegen optimizations that lack an
annotation. Before legacy deletion, #3090 still needs a fresh reachability
classifier that covers every reachable direct-codegen symbol and requires each
one to be classified as semantic-only, IR-owned, shared, or intentionally
unsupported.

## Result

- Source inventory v1 now parses `@irOptimizationOwner` tags attached to real
  top-level declarations and derives each exact `source::symbol` identity from
  the TypeScript syntax tree.
- The checker joins every source anchor to one ledger ID and requires the
  reverse `directOwner.anchor: "source-annotation-v1"` claim. Missing, dangling,
  duplicate, malformed, and mismatched identities fail.
- The source-inventory version marker makes a zero-owner denominator an error.
  Removing the marker cannot silently downgrade the canonical ledger.
- The counted-vector push and dense-vector fill pre-sizing functions are the
  first two source-anchored owners: **2/22 ledger decisions (9.1%)**. Runtime
  behavior is unchanged.
- Synthetic fixtures prove the gate fails when an annotated owner is omitted
  from the ledger and when either side of an existing pair is removed.

## Validation

- `pnpm exec vitest run tests/issue-3792-ir-optimization-retirement-gate.test.ts`
  — 16/16 tests pass, including the omitted-owner kill control and marker
  version/duplication controls.
- `pnpm run check:ir-optimization-retirement` — 22 rows, 11 IR-owned, one
  retirement-ready, and two source-anchored.
- One timed checker run completed in 0.42 seconds wall time.
- `pnpm run typecheck`, `pnpm run check:issues`, focused Biome lint and
  Prettier, and `git diff --check` pass.
