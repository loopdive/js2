---
id: 2041
title: "standalone: built-ins/Temporal — 544 host-pass tests die with opaque runtime null-deref instead of loud refusal"
status: ready
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: temporal
goal: standalone-mode
related: [1888, 1910]
test262_bucket: standalone-temporal
test262_count: 544
es_edition: n/a
origin: "2026-06-10 standalone-vs-host baseline diff: 544 Temporal gap rows; 165 are `dereferencing a null pointer [in test()]`, the rest split between ToPrimitive and missing-TypeError assertion fails."
---

# #2041 — standalone Temporal bucket: opaque null-derefs

## Problem

544 `built-ins/Temporal/*` tests pass in JS-host mode (where Temporal is
backed by the host implementation/polyfill) but fail in standalone. The
failure modes are bad diagnostics, not honest gaps:

| Count | Mode |
| ---: | --- |
| 165 | `dereferencing a null pointer [in test()]` — Wasm trap, aborts the test, unclassifiable |
| ~22 | `Cannot convert object to primitive value` (ToPrimitive, overlaps #1910) |
| ~350 | runtime assertion fails: `assert.throws(TypeError, () => instance.subtract({}), …)`, `assert.throws(RangeError, …)` — abrupt-completion paths return normally or trap |

Spread across `ZonedDateTime` (109), `PlainDateTime` (91), `PlainDate` (71),
`PlainTime` (68), `Instant` (62), `PlainYearMonth` (62), `Duration` (60), …

## Why this matters even though Temporal is out of scope

A pure-Wasm Temporal implementation is NOT being requested here (that would
be a huge feature). The bug is that standalone mode **silently produces a
broken binary** for Temporal-using programs: the compile succeeds, then the
program traps with a null deref at runtime. This violates the #1888 dual-mode
invariant (uncertainty ⇒ loud `Codegen error:` refusal at compile time) and
pollutes the standalone baseline with 165 opaque `null_deref` rows that mask
real regressions in those directories.

## Root cause in compiler (to confirm)

`Temporal.*` namespace reads in standalone presumably resolve to a null/missing
builtin slot instead of hitting the `__get_builtin` refusal gate that other
unsupported builtins use (compare: `Proxy`/`Reflect.construct` refuse with a
named `Phase C` message). Constructor calls like `new Temporal.PlainDate(...)`
then operate on a null struct → trap at first member access.

## Suggested fix

1. Add `Temporal` (the whole namespace) to the standalone refusal list:
   `Codegen error: Temporal is not supported in --target standalone (#2041)`
   — same mechanism as the Proxy/Reflect Phase C refusals.
2. Reclassify: the standalone report classifier should bucket these rows under
   `standalone-temporal` so they stop appearing as anonymous `null_deref` /
   ToPrimitive rows.
3. (Optional, later) If/when a Wasm-native Temporal core is wanted, file a
   separate feature issue; this issue is only the fail-loud + classification
   slice.

## Acceptance criteria

- Compiling any `Temporal.*` use under `--target standalone` yields a named
  `Codegen error:` refusal, never a binary that traps with null deref.
- 0 `dereferencing a null pointer` rows under `built-ins/Temporal/` in the
  standalone baseline.
- Rows are classified `standalone-temporal` in the rebuilt report.
- JS-host mode behavior unchanged (Temporal keeps passing there).
