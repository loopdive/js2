---
id: TO-ALLOCATE
title: "Ordinary pipeline: stop slice work, keep it as a regression guard, count legacy-emitted bodies"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: process
area: ir, process
goal: ir-full-coverage
related: [7354, 7106, 7349, 7350, 7352]
---

# Ordinary pipeline: guard, not goal

Source: `plan/log/ir-migration-strategy-review-2026-11-19.md` (strategy review, 2026-11-19, main `89e47482`). Recommendation R10.

## Problem

- 88 of the 129 non-doc PRs merged 2026-11-01 to 11-19 are ordinary-pipeline IR work; 33 of them moved the CI
  figure `ir_only_pass` by nothing. Only 14 % of their `src` churn is in `from-ast.ts`, the entry the Prepared
  path shares; 16 % is selector code the Prepared path does not run.
- A "zero-legacy" file is not legacy-free: in 8 of 8 probed files legacy also emitted 8 of 9 unit bodies (the IR
  body is patched over), and about 720 of 768 Wasm functions are legacy-emitted helpers (probe 2026-11-19, main
  `89e47482`).
- Seven ordinary-pipeline PRs are open today beside the Prepared lanes and compete for the same CI.

## To decide

- Which ordinary-pipeline work continues: verdict regressions and crashes only, or also from-ast lowering that the
  Prepared path reuses unchanged.
- Whether `ir_only_pass` stays published, and whether a second figure "units where legacy emitted no body" is
  added so the number cannot be read as legacy leaving.
- What happens to open selector-only PRs and to #7349, #7350, #7352 as planned for the ordinary pipeline.

## Acceptance criteria

1. `CLAUDE.md` and `plan/log/ir-adoption.md` state what ordinary-pipeline IR work is still taken.
2. A regression guard on the ES5 zero-legacy file list exists (the 2026-11-14 census found an unflagged loss of 8).
3. Open ordinary-pipeline PRs are each closed, merged or re-scoped with a reason.
