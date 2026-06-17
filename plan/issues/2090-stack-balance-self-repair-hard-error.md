---
id: 2090
title: "stack-balance self-repair must not invent values — null patch becomes a hard compile error"
status: done
sprint: 63
created: 2026-06-11
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/dev-b
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: compiler
language_feature: compiler-internals
goal: correctness
related: [2089]
origin: "2026-06-11 analysis program (report 04 §2a gap); stub 08-B5"
---

# #2090 — the repair pass masks the bugs it exists to catch

## Problem

The stack-repair pass patches unknown stack-type mismatches with a "safe
default" null value — masking the producing bug TWICE (once at the
producer, once in the pass that should have flagged it). Any module that
reaches this code has a real codegen bug that now ships as a silent null.

## Root cause

`src/codegen/stack-balance.ts:812`. Report 04 §2a marks it an uncovered
gap; §5 Phase 1 concludes there is no legitimate trigger.

## Fix direction

Convert to a structured hard compile error (with the producing function +
instruction context in the message). Can fold into #2089 Phase 1 or land
standalone.

## Acceptance criteria

- The null-patch arm throws a structured CE; full equivalence suite +
  playground examples still compile (proving no legitimate trigger)

## Dupe check

No issue covers the repair pass. New (analysis program).

## Resolution (2026-06-16, dev-b)

`src/codegen/stack-balance.ts` `fixBranch` had two arms that patched a missing
stack slot of **unrecoverable** type with an invented `ref.null.extern` "safe
default" (the `default:` case for an unknown valtype kind, and the
type-indexed/multi-value `else`). Those masked the producing codegen bug as a
silent null. The **typed-zero** arms (i32/i64/f64/f32/externref/ref → push that
type's zero) are legitimate and untouched — they fill a *known*-type slot.

- A module-scoped `inventedValueSites` collector + `currentDiagFunc` (set per
  function in `stackBalance`'s loop) records any hit on the two unknown-type
  arms with the function name + detail. `stackBalance` drains it into
  `mod.codegenErrors` as a structured hard compile error ("refuses to invent a
  value … would mask a producing codegen bug"), which `compiler.ts` surfaces as
  a failed compile (#1868 channel). A placeholder is still pushed so the pass
  finishes its walk; the recorded error fails the compile regardless.

**Acceptance:**
- [x] The unknown-type null-patch arms now produce a structured CE
- [x] Playground examples all compile clean (`pnpm run check:ir-fallbacks` OK —
  no #2090 trigger), proving no legitimate trigger on the example corpus; the
  full equivalence suite runs green in CI (sharded). The legitimate typed-zero
  arms are unaffected.

Tests: `tests/issue-2090.test.ts` — drives the type-indexed unknown arm via a
hand-built module (asserts the #2090 structured error) and confirms the
known-type (i32) arm does NOT error.
