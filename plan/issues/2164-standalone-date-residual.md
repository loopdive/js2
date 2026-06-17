---
id: 2164
title: "Standalone Date conformance residual (~234 tests)"
status: in-progress
sprint: 63
created: 2026-06-15
updated: 2026-06-16
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: date
goal: standalone-mode
parent: 1343
---

# Standalone Date conformance residual

## Problem

Date prototype formatters landed in #1343 (`done`, sprint 50). The
host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows **234
tests pass in host mode but fail standalone**, attributed to Date semantics
— currently **untracked**.

## Evidence

- Gap category: `built-ins/Date` 235; `(none)`-leak compile errors (219)
  dominate — standalone codegen gaps in Date construction/formatting/coercion.

## Acceptance criteria

- Standalone pass count for `built-ins/Date` rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1343. Part of sprint-62 standalone catch-up (rank 10 by gap
impact).

---

## Slice 1 (2026-06-16) — `Date.now()` / `new Date()` no-arg host-import leak

**Landed.** Triage showed most Date functionality already works standalone
(explicit-timestamp ctor, getTime, UTC components, setters, toISOString,
multi-arg ctor, NaN, Date.UTC). The dominant *foundational* failure: `Date.now()`
and `new Date()` (no args) emitted the `env::__date_now` host import
**unconditionally** in non-WASI mode — under `--target standalone` (no JS host,
no WASI clock) that import is unsatisfiable, so every module calling `Date.now()`
or `new Date()` (commonly in test setup) failed to instantiate, taking unrelated
Date assertions down with it.

**Fix** (`expressions/calls.ts` Date.now/performance.now; `expressions/new-super.ts`
`new Date()`): pure standalone has no wall-clock source, so emit the Unix epoch
(`f64.const 0` / `i64.const 0`) directly — deterministic, no import leak, module
instantiates. WASI still uses its clock; host mode unchanged (gated on
`ctx.standalone === true`). Test: `tests/issue-2164.test.ts` — Date.now()/new
Date()/performance.now() instantiate, mixed setup+explicit-timestamp works,
explicit dates unaffected (5/5). Host date-basic equiv unchanged (12/12).

### Remaining slices (issue stays open)

- **`Date.parse(str)`** returns 0 standalone (`Date.parse("2000-01-01")` → 0)
  — the date-string parser isn't wired standalone. Medium slice.
- Real current-time semantics standalone are intentionally NOT provided (no
  clock source); only the instantiate-blocking leak is fixed here. Tests
  asserting a non-zero *current* time stay failing by design.
