---
id: 7382
title: "Decide how eval and Function() run on the IR-only path"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: design
area: ir, eval
goal: ir-full-coverage
related: [7354, 7106, 7349, 7350, 7352]
---

# Decide `eval` / `Function()` on the IR-only path

Source: `plan/log/ir-migration-strategy-review-2026-11-19.md` (strategy review, 2026-11-19, main `89e47482`). Recommendation R5.

## Problem

1,050 of 8,717 positive ES5 files (12.0 %) use `eval` or `Function(...)` (822 and 202 in test bodies; syntactic
count, 2026-11-19). `with` adds 192. No IR-only path passes 88 % of ES5 without an answer. Today 196 files crash
the Prepared compile with "certified global eval lost an owning predicate" and 96 are refused. The answer shapes the
scope and binding model (script-var homes, closures), so deciding late means rework in the lanes building those now.

## To decide

- The mechanism: compile-time evaluation of constant strings, an in-module interpreter over the IR, a bundled
  compiler, or a declared exclusion from the IR-only figure (and then the ceiling is 88 %).
- What the scope model must expose so the chosen mechanism can read and write caller bindings.
- How many of the 1,050 files pass constant strings (measure first).

## Acceptance criteria

1. A decision record with the measured split (constant vs computed source, direct vs indirect eval).
2. The scope/closure lanes confirm their representation supports it, or the change is filed.
3. The 196 crashes become named refusals until the mechanism lands.
