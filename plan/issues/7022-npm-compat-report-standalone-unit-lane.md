---
id: 7022
title: "npm-compat: publish the #7013 standalone unit-lane numbers as `tests.standalone` per package (report + dashboard), without doubling the refresh job"
status: ready
sprint: current
created: 2026-10-16
updated: 2026-10-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: infra
language_feature: reporting
goal: standalone-gap
related: [7013, 3988]
---

# Report the standalone unit lane in npm-compat

[#7013](./7013-standalone-upstream-unit-lane.md) added an opt-in standalone
lane for every upstream unit suite (`JS2WASM_UPSTREAM_TARGET=standalone`), but
`benchmarks/results/npm-compat.json` `tests.passed/total` remain JS-host
numbers. #7013 deliberately did not wire the lane into the report:

- `npm-compat-refresh.yml` already takes ≈24 min, longer than the interval
  between merges (#3988's livelock lesson). Running every suite a second time
  in the same job roughly doubles it.
- The dashboard (`website/npm-compat.html`) and the generator's per-package
  record shape both need a new field, which is a schema change, not a
  one-liner.

## Implementation Plan

1. Generator: add `--unit-lanes js-host,standalone` to
   `scripts/generate-npm-compat-report.mjs`. For each upstream-suite package,
   when `standalone` is requested, re-invoke the suite's `runHarness` with
   `process.env.JS2WASM_UPSTREAM_TARGET = "standalone"` (each harness reads the
   lane at call time) and record
   `tests.standalone = { passed, total, filesWithoutResult, hostImportFiles,
   topFailure }` from the returned report (`report.summary` + the
   `compile.details[].hostImports` / `runtimeError` fields #7013 records).
   `total` must be the same native-admitted denominator as the JS-host lane.
2. Keep the default refresh at `js-host` only; run `standalone` in a separate
   matrix job of `npm-compat-refresh.yml` (or a nightly cron) so the promoted
   artifact's freshness rule (`generatedAt`) still applies per lane.
3. Dashboard: show `standalone p/t` beside the JS-host count on each package
   card; absent field → "not measured".
4. Pre-promote check: refuse a standalone block whose `total` differs from the
   JS-host `total` (the denominators are by construction identical).

## Acceptance

npm-compat.json carries `tests.standalone` for every upstream-suite package;
the JS-host `tests` numbers and the refresh job's critical path are unchanged.
