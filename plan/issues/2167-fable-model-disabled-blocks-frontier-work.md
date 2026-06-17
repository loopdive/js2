---
id: 2167
title: "Fable model disabled — frontier-reasoning work blocked"
status: in-progress
sprint: 63
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: external
reasoning_effort: low
task_type: infra
area: process
goal: process
---

# Fable model disabled — frontier-reasoning work blocked

## Problem

**As of 2026-06-15 the Fable model is no longer available.** Sprint 62 was
originally planned as the "last Fable sprint," front-loading frontier-grade
reasoning work (architecture specs, value-representation migrations, identity
doctrines, keystone silent-wrong-answer mechanisms). With Fable gone, that
plan is void (see `plan/issues/sprints/62.md`, rescheduled to standalone
catch-up).

Most former `model: fable` issues fall back to **Opus** cleanly and proceed.
But a subset is flagged `reasoning_effort: max` + `feasibility: hard` —
representation migrations and cross-cutting identity/effect/ABI work where a
wrong call is silently wrong-code and hard to detect. For these, **Opus is
judged to have no realistic chance of doing the work properly**, so they are
**blocked on this issue** rather than dispatched and botched.

## Blocked issues (depend on this)

`reasoning_effort: max`, Fable-only — kept `model: fable`, `status: blocked`,
`blocked_by: 2167`:

- #1916 — symbolic function references in WasmGC codegen (identity migration)
- #1930 — TypeOracle single type-query boundary
- #1985 — stale-proof index cells (shift-walker `{idx}` handles)
- #2044 — BigInt i64-brand ValType architect decision
- #2134 — IR effect model (classify/enforce ordered emission)
- #2135 — single IR capability predicate (selector ⇄ builder)
- #2138 — IR-first compile-once inversion
- #2140 — stack-balance fixBranchType coerce-or-throw keystone
- #2141 — retire tag-5 box-the-externref ABI
- #2039 — standalone invalid-Wasm residual bucket

Issues judged **Opus-doable** and intentionally NOT blocked: #1712, #1917
(coercion engine — the sprint-62 catch-up engine lane), #2029.

## Resolution

Close (`done`) when Fable access is restored; at that point the dependent
issues unblock (`blocked_by` cleared, `status` → `ready`) and route back to
`model: fable` dispatch. Until then they stay parked — no Opus attempt.

## Notes

Recorded by stakeholder direction 2026-06-15. Process/tracking issue, not a
code change.
