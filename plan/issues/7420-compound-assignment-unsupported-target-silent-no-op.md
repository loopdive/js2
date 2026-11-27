---
id: 7420
title: "An unsupported compound-assignment target compiles to a silent no-op (`compileCompoundAssignment`'s error is discarded)"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7394, 7307]
---

# #7420 — an unsupported compound-assignment target becomes `f64.const 0; drop`

## Problem

Found while fixing #7394; RV7335 asked for it to be filed separately. In round 2 of that review it was a real trap: a
target the codegen could not lower compiled to a no-op instead of failing the compile.

When `compileCompoundAssignment` (`src/codegen/expressions/operator-assignment.ts`, ~L1874) meets a target it cannot
lower, it reports `"Compound assignment only supported for simple identifiers"` and returns `null`. Yet `compile()`
returns `success: true` with no diagnostic. The statement emits `f64.const 0; drop`, so `x op= y` silently does
nothing.

Before #7394, a parenthesised or type-wrapped target (`(x) += 1`, `(x as number) += 1`, `(s!) += "cd"`) reached this
arm, and the program ran with the update missing (traced while fixing #7394). #7394 peels every wrapper, so no target
the early-error pass admits reaches the arm today. Any future unsupported target would be just as silent.

## Cause (to confirm)

Some caller between the statement compiler and `compileCompoundAssignment` drops the reported error. It may be a
speculative attempt that rolls back the diagnostics but keeps the emitted default value, or an expression-statement
path that ignores a `null` result.

## Acceptance criteria

- A compound assignment whose target the codegen cannot lower fails the compile with a diagnostic, on gc and
  standalone.
- Find where the diagnostic is dropped and fix it there. Do not add a second report at the call site.
- A test pins the failure. It reaches the arm through a target the early-error pass admits, or, if none remains,
  through a unit test of the caller.
