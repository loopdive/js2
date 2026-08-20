---
id: 4575
title: "Open npm compatibility tests directly in the playground"
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: feature
area: website, playground, npm-compat
language_feature: n/a
goal: npm-library-support
sprint: current
assignee: ttraenkler/codex
horizon: s
related: [3757]
origin: "Preserve the sole unique product slice from stale, conflicted PR #4651 without carrying its superseded capability and chart commits."
files:
  - scripts/generate-npm-compat-report.mjs
  - scripts/lib/npm-compat-playground.mjs
  - tests/dogfood/acorn-official-suite.mjs
  - tests/dogfood/upstream-suite-runner.mjs
  - website/components/npm-compat-chart.js
  - website/playground/index.html
  - website/playground/layout.ts
  - website/playground/main.ts
  - tests/issue-4575-npm-playground-summary.test.ts
  - plan/issues/4575-open-npm-tests-in-playground.md
---

# #4575 — open npm compatibility tests directly in the playground

## Problem

PR #4651 combines 133 files from three historical work streams and is more
than a thousand commits behind `main`. Its host-capability and report-chart
changes have already landed in evolved form, but its npm-test playground
integration remains unique. Rebasing the whole PR would create dozens of
unnecessary conflicts across active IR/runtime files.

## Scope

- Replay only the seven-file npm-test playground change on current `main`.
- Preserve current npm correctness, unavailable-infrastructure, and
  performance fields while adding the per-package `playground` data.
- Emit source paths, per-file status, test counts, diagnostics, and pinned raw
  source URLs from the existing committed dogfood suites.
- Add an npm compatibility tree and `?npm=<package>` deep link to the
  playground without changing compiler/runtime production code.
- Keep the editor language aligned with the selected file extension and make
  the source tab closable without removing the permanent editor pane.
- After the replacement is published, close PR #4651 as superseded by the
  already-landed capability/chart work plus this focused replacement.

## Acceptance criteria

- The npm report generator retains both existing performance metadata and the
  new playground metadata for marked, eslint, react, react-dom, and catalog
  packages.
- Existing correctness annotations, including unavailable infrastructure,
  remain present rather than being replaced by the older checkpoint shape.
- The website exposes one package link and renders package/file status from
  the generated schema; deep links expand the selected package.
- Typecheck, formatting, lint, generator/component syntax checks, and focused
  playground tests pass on current `main`.
- The replacement PR is ready, not draft, and has no production-file overlap
  with the active IR migration branch.

## Handoff

The source commit is `f2e4c16baa21564ea884d1cb1e68f45f41c2d250` from
PR #4651. The only replay conflict is
`scripts/generate-npm-compat-report.mjs`; resolution must keep both current
performance/unavailable-infrastructure fields and the new playground fields.

## Checkpoint result

The seven-file product slice now sits on current `main` without any of
PR #4651's superseded compiler/runtime changes. The generator retains current
correctness, unavailable-infrastructure, performance-row, and history fields
while adding the new per-package playground data. The conflict resolution also
found and fixed one stale summary bug: compile-blocked differential files now
increment `compile_error`, not `skip`, through one shared tested reducer.

The authoritative Marked no-write smoke reports **8/8 compile-error files,
compile_error=8, skip=0, total=8**. A Cookie positive control keeps **63,658 /
63,740** upstream results, **21/21** playground files passing, three performance
rows, and the performance history object in the same generated record.

## Validation

- Focused/regression Vitest: **34/34** tests in **5/5** files.
- JavaScript syntax: **5/5** files.
- Prettier: **10/10** files.
- TypeScript 7 typecheck: pass.
- Biome lint: **4,202** files, exit 0.
- Production playground build: **2,105** modules, exit 0; only existing Vite
  size/dynamic-import/non-module-script warnings remain.
- Issue integrity, optimization ledger, issue ID against `main`, and
  `git diff --check`: pass.
