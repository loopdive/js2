---
id: 2140
title: "stack-balance fixBranchType: coerce-where-possible, throw on impossible (split of #1858-C1)"
status: ready
sprint: 62
created: 2026-06-12
updated: 2026-06-12
priority: critical
feasibility: hard
reasoning_effort: max
model: fable
task_type: bugfix
area: compiler
language_feature: compiler-internals
goal: correctness
related: [1858, 2090, 1917]
origin: "2026-06-12 sprint-62 architecture analysis (quality workstream N2); complete implementation plan already written in #1858's 'C1 implementation notes' tail"
---

# #2140 — the keystone silent-wrong-answer mechanism

## Problem

`src/codegen/stack-balance.ts:709-755` (`fixBranchType`) silently
substitutes `drop; f64.const 0` for externref→f64 (`:725-731`) and ref→f64
(`:738-743`) mismatches, while `callArgCoercionInstrs` correctly calls
`__unbox_number` for the same conversion — so a coercion's runtime value
depends on which syntactic context triggered it. This amplifies every
upstream codegen bug into a silent wrong answer instead of a loud failure.
Distinct from #2090 (the `:812` null-patch site).

## Approach

Verbatim from #1858's "C1 implementation notes": thread
`boxNumberIdx`/`unboxNumberIdx` into `fixBranch`→`fixBranchType`; add
coercion arms first; measure CI test262 delta; then convert impossible arms
to a structured compile error.

## Acceptance criteria

- The `()->f64` + `ref.null.extern` repro returns the boxed value or throws
  at compile time.
- test262 delta measured and net ≥ 0.
- No remaining "lossy but valid" comment in fixBranchType.

## Notes

Fable/senior-routed — measured-rollout judgment required. Coordinates with
#1917 Step 0 (which unifies the same coercion tables); land Step 0 first
so this change writes rows into one table, not a fourth copy.
