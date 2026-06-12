---
id: 2144
title: "linear %: replace naive trunc-formula with the #2056 fmod helper (cross-backend parity)"
status: ready
sprint: 63
created: 2026-06-12
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: compiler
language_feature: arithmetic
goal: correctness
related: [1974, 2056, 1854]
origin: "2026-06-12 sprint-62 architecture analysis (quality workstream N3) — #1974's own acceptance criterion ('inherit #2056's fmod-correctness work') is unmet on main"
---

# #2144 — backends diverge on `%` for extreme ratios

## Problem

`src/codegen-linear/index.ts:2189-2209` (landed via #1937) uses the naive
`a - trunc(a/b)*b` formula that the GC backend explicitly retired in #2056
(`src/codegen/fmod.ts` header documents the failure modes: ULP drift,
collapse-to-0, ±Infinity on extreme ratios). Textbook divergence per
`docs/architecture/codegen-axes.md:111-113`.

## Approach

Emit `fmod.ts`'s long-division remainder as a linear runtime func
(`__fmod`), call it from the PercentToken arm.

## Acceptance criteria

- `1e308 % 1e-308` and `7 % Infinity` match Node on the linear backend.
- #1974's regression guard extended to cover these cases.

## Notes

Routine dev, sprint 63 (after the in-flight linear PRs land). Shows up in
the #1854 differential lane once that exists.
