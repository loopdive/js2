---
id: 4522
title: "Inventory and retirement plan for the 13 JS2WASM_IR_* env kill-switches — R9 requires them gone, nobody owns the list"
status: ready
sprint: current
created: 2026-08-16
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: hardening
area: ir, tooling
language_feature: compiler-internals
goal: ir-full-coverage
parent: 3518
related: [3518, 3792]
origin: "tech-lead IR design review 2026-08-16"
---

# #4522 — kill-switch inventory for the R9 flip

## Problem

R9 of #3518 requires all IR/legacy escape hatches and compile-twice switches
removed "from public options, env handling, tests, scripts, and
documentation". Measured 2026-08-16: **13 distinct `JS2WASM_IR_*` env vars**
(~57 references) exist under `src/`:

`JS2WASM_IR_INLINE` (15) · `JS2WASM_IR_FIRST` (10) · `JS2WASM_IR_SHAPE_DIAG`
(7) · `JS2WASM_IR_I…` (4) · `JS2WASM_IR_POSTCLAIM_LOG` (3) ·
`JS2WASM_IR_OWNERSHIP` (3) · `JS2WASM_IR_OBJECT_SHAPES` (3) ·
`JS2WASM_IR_GVN` (3) · `JS2WASM_IR_ESCAPE` (3) · `JS2WASM_IR_ASYNC` (3) ·
`JS2WASM_IR_VERIFY_DOMINANCE_NAIVE` (2) · `JS2WASM_IR_STRING_BUILDER` (2) ·
`JS2WASM_IR_GVN_DEBUG` (1)

These are not one category, and R9 must not delete them uniformly:
diagnostics (`*_DIAG`, `*_LOG`, `*_DEBUG`) and self-checks
(`VERIFY_DOMINANCE_NAIVE` cross-checks the fast dominance algorithm against
the naive one) are healthy and should SURVIVE; feature kill-switches
(`IR_FIRST`, `IR_STRING_BUILDER`, pass toggles) are the R9 debt. Nobody owns
the classification today, and rediscovering it at flip time is exactly the
kind of last-minute audit R9 should not depend on.

## Acceptance criteria

- [ ] A table in this issue (or `plan/log/ir-adoption.md`) classifying every
      `JS2WASM_IR_*` var: keep-as-diagnostic / keep-as-self-check /
      retire-at-R9 (with the retiring issue or R-slice named) /
      retire-now-already-dead.
- [ ] Any var classified retire-now is actually removed in the same PR, with
      grep-zero evidence.
- [ ] A one-line guard is added to the R9 acceptance checklist in #3518
      pointing at this inventory, so the flip consumes it rather than
      re-auditing.
