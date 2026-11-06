---
id: 7257
title: "ir-claim-ledger --wrapped: a compiled file with no IR telemetry counts as zero-legacy"
status: ready
sprint: Backlog
created: 2026-11-06
updated: 2026-11-06
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7249, 7240, 6806]
---

# #7257: `--files-json` / `zeroLegacyFiles` and files without telemetry

Found in the #7249 review (PR #7095, comment 6672656287).

In `scripts/ir-claim-ledger.mts` wrapped mode, `irOutcomes ?? []` turns a
successful compile that produced no IR telemetry into a row with zero legacy
units, so it is counted in `zeroLegacyFiles`. The test262 report
(`scripts/build-test262-report.mjs`) counts such a file as **unmeasured**
(`ir_measured` false), not as zero-legacy. At stride 400 nothing changed (all 14
no-telemetry files failed to compile), but the predictor can drift from
`ir_only_pass` on a larger run.

**Fix:** treat "no telemetry" as unmeasured in the ledger too: exclude it from
`zeroLegacyFiles` and the histogram, and report it under `noTelemetry`, the
way raw mode already does. Also move the 4-line legacy-unit rule copied from
`summarizeIrRoute` (`scripts/test262-worker.mjs`) into one shared export, so
the two cannot diverge.
