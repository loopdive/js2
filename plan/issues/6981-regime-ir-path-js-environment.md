---
id: 6981
title: "Native regime in a JS environment: IR-path Error.message / Map-Set / typeof tags + five direct-path compile failures"
status: in-progress
sprint: current
created: 2026-10-14
updated: 2026-10-14
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
goal: architecture
parent: 5385
related: [6708, 6979]
assignee: ttraenkler/opus-6981-ir
---

# #6981 — Native regime in a JS environment: IR path + direct-path compile failures

## Problem

Flipping the default `semanticProviders` to `native-first` in a JavaScript
environment (slice A of #6708) turns 15 equivalence rows red that are owned
here:

- `ir-slice10-error` (a)–(e): IR-path `Error.message` reads return `""`.
- `ir-slice10-map-set` (d)/(e): "Map/Set IR capability violation".
- `issue-6798`: resolve-stage-catch; string-bool-union; yield-star-return.
- `gradual-typing`: typeof any boolean runtime tag check; typeof any number
  comparison (compile failures).
- `destructuring-require-object-coercible`: `let {} = 5` (compile failure).
- `binding-null-guard`: class method with destructured param.
- `element-assignment-externref`: numeric key assignment on any-typed param.

All reproduce on main with an explicit `{ semanticProviders: "native-first" }`
compiled module read through `wrapCompiledExports`.

## Acceptance criteria

- All 15 rows pass under the regime (verified on slice A's branch).
- `tests/issue-6981-regime-ir-path.test.ts` covers each construct under both
  `semanticProviders: "native-first"` and `target: "standalone"`.
- `node scripts/equivalence-gate.mjs` reports no new regressions; standalone
  output unchanged or improved.
