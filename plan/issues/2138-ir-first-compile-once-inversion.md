---
id: 2138
title: "IR-first compile-once inversion: selector decides before compileDeclarations (flag-gated investigation)"
status: blocked
blocked_by: [2167]
sprint: 65
created: 2026-06-12
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: compiler
language_feature: compiler-internals
goal: maintainability
related: [1530, 1916, 1927]
origin: "2026-06-12 sprint-62 architecture analysis (pipeline workstream N2)"
---

# #2138 — every IR-claimed function is compiled twice by design

## Problem

Legacy compiles ALL bodies (`src/codegen/index.ts:1174`), then the IR
overlay re-compiles claimed ones and overwrites (`:1308`). Wasted compile
time — and the always-available legacy body is *the mechanism* that makes
silent fallback possible (#1530's root enabler). "Phase out the fallback"
has no destination until the pipeline can skip legacy for claimed
functions.

## Approach

Behind `JS2WASM_IR_FIRST=1`: run `planIrCompilation` before
`compileDeclarations` and skip legacy bodies for claimed functions whose
whole call-graph closure is claimed. Measure test262 delta + compile-time
delta on a full run. File divergences found.

## Acceptance criteria

- Flag exists; default behavior unchanged (byte-identical output without
  the flag).
- One measured test262 + compile-time run recorded in this issue.
- Divergences filed as issues.

## Notes

Fable-routed investigation — the findings shape #1530/#1916-impl
sequencing for sprints 63+. This is the structural endgame the
STRICT_IR_REASONS ratchet feeds into.
