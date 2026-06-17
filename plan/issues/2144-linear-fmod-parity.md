---
id: 2144
title: "linear %: replace naive trunc-formula with the #2056 fmod helper (cross-backend parity)"
status: done
sprint: 63
created: 2026-06-12
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/dev-b
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

## Resolution (2026-06-16, dev-b)

- **`src/codegen-linear/runtime.ts`** — new `addFmodRuntime(mod)` + `FMOD_FN`
  export. Pushes a `__fmod` runtime func `(f64 a, f64 b) -> f64` implementing
  the exact binary long-division remainder (same algorithm as the WasmGC
  `src/codegen/fmod.ts`, #2056): special-cases b==0/|a|==Inf/NaN/|b|==Inf, then
  `t=y·2^k` alignment + subtract-down loop, `copysign(x, a)` for the dividend
  sign. All intermediates stay ≤ |a| so nothing overflows and every step is an
  exact f64 op (zero ULP drift).
- **`src/codegen-linear/index.ts`** — `addFmodRuntime(mod)` wired into both
  `generateLinearModule` and `generateLinearMultiModule` (after the other
  `add*Runtime` calls); the `PercentToken` arm now emits a single
  `call __fmod` (operands already on the stack in `(a,b)` order) instead of the
  naive `a - trunc(a/b)*b`. `fixupFuncIndices` patches the call like any other
  runtime-func call.

Verified vs Node on the linear backend (runtime operands, no constant folding):
`1e308 % 1e-308` → `3.498…e-309` ✓ (was `-Infinity`), `7 % Infinity` → `7` ✓
(was `NaN`), `1e16 % 0.0001` and `123456789.123 % 0.001` ✓ (no longer collapse),
plus the sign/zero/NaN edge set — 18/18 match.

Tests: extended `tests/issue-1974.test.ts` with a `#2144 __fmod parity` block
(extreme ratio, Infinity divisor, round-collapse, sign-of-dividend, `x % 0`
→ NaN). 19/19 pass.

**Acceptance:**
- [x] `1e308 % 1e-308` and `7 % Infinity` match Node on the linear backend
- [x] #1974's regression guard extended to cover these cases
