---
id: 5173
title: "Runner still classifies Temporal as proposal/official:false — ES2026 (17th ed.) shipped it on 2026-06-30"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: test262-runner, ci
language_feature: temporal
goal: spec-completeness
es_edition: es2026
related: [4628, 661]
---

# #5173 — Temporal is ES2026, not a proposal; reclassify it in the runner

## Problem

Temporal reached Stage 4 at the March 2026 TC39 meeting and Ecma's General
Assembly approved **ECMA-262, 17th edition (ES2026) on 2026-06-30** with
Temporal in it — the edition's largest addition. Upstream test262 moved the
`Temporal` feature flag into the **"Standard language features"** section of
`features.txt` accordingly.

This repo's runner still says otherwise, in two places
(`tests/test262-runner.ts`):

- `PROPOSAL_FEATURES` (~L219): `["Temporal", "proposal feature: Temporal"]`
- `classifyTestScope` (~L263-264): the path-based rule
  `relPath.includes("built-ins/Temporal/")` →
  `{ scope: "proposal", official: false, ... }`

## What this distorts (and what it does NOT)

**Conformance counts are not wrong** — CI shard runs set
`TEST262_INCLUDE_PROPOSALS=1` (`test262-sharded.yml:877`,
`test262-differential.yml`, `refresh-baseline.yml:276`,
`test262-canary.yml:128`), so all ~4,611 Temporal tests run and are counted in
the overall baseline.

What IS wrong is the **official-edition accounting**: `official: false`
excludes the whole Temporal bucket from `official_summary` /
`official_pass` / `official_total` (`scripts/build-test262-report.mjs:1137-1146`,
`scripts/sync-conformance-numbers.mjs:116-122`,
`scripts/check-standalone-highwater.mjs:122,172`). Those numbers now claim
conformance against "official ECMAScript" while silently omitting ~4,611
tests of the published current edition.

Also fragile: any run WITHOUT `TEST262_INCLUDE_PROPOSALS=1`
(`workflow_dispatch` without the flag, ad-hoc local runs) silently skips a
published-edition feature.

## The fix

1. Remove `Temporal` from `PROPOSAL_FEATURES` and delete the
   `built-ins/Temporal/` path rule in `classifyTestScope`, so Temporal
   classifies as ordinary standard scope (`official: true`), like any other
   `built-ins/` path. Tag it `es_edition`-wise wherever the runner records
   editions.
2. **Regenerate `scripts/runner-bundle.mjs`** with the repo's build tooling
   (it embeds a copy of `classifyTestScope`, ~L62682) — never hand-edit the
   bundle.
3. **Handle the official-number drop deliberately — this is the load-bearing
   step.** Flipping ~4,611 tests with only ~200 passes into the official
   bucket drops the headline official conformance percentage by several
   points in one commit. Before pushing, enumerate every consumer that
   gates or floors on official numbers — `check-standalone-highwater.mjs`,
   baseline-floor checks, `sync-conformance-numbers.mjs`, dashboard
   badges/landing summaries — and reseed/adjust each floor in the SAME PR
   with the reason recorded, so the reclassification cannot read as a
   regression and trip a guard or park in the merge queue.
4. Audit for other now-stale entries while there: `import-defer` and
   `source-phase-imports` remain in `PROPOSAL_FEATURES` — verify their
   current TC39 stage against upstream `features.txt` (both were still in
   the proposals section as of the 2026-08-10 tip) and leave them if still
   proposals; record the check either way.

## Acceptance criteria

1. `classifyTestScope` returns `official: true` / standard scope for
   `built-ins/Temporal/**`, in both the runner and the regenerated bundle.
2. Temporal tests run regardless of `TEST262_INCLUDE_PROPOSALS`.
3. Official-summary consumers are updated in the same PR; the expected
   before/after official pass/total is stated in the PR body, with no
   guard tripping in the merge queue (or the specific reseeds called out).
4. The es_edition accounting (if any per-edition breakdown exists) attributes
   Temporal to ES2026.

## Notes

Found during #4628 (Temporal runtime-object work): the 2,206
`Temporal is not defined` failures are conformance gaps against the
published current edition, not a proposal — this issue makes the repo's
own metrics say so.
