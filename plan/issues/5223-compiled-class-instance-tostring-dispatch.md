---
id: 5223
title: "Compiled-class instance toString / Symbol.toStringTag dispatch not wired — new Temporal.PlainDate(…).toString() returns \"[object Object]\""
status: ready
sprint: current
priority: medium
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5223 — compiled-class instance `toString` dispatch

## Problem

`new Temporal.PlainDate(2020,3,4).toString()` returns `"[object Object]"`
instead of `"2020-03-04"` — the compiled class's prototype `toString` (and
`Symbol.toStringTag`) is not consulted when the instance crosses to the
host / is stringified. Found by dev-temporal-wire validating PR #5318.

## Direction

Related family: #5201/#5202 dispatch exports and the #5318 `.prototype`
dynamic-lane fix. Measure whether the miss is (a) host-side `toString`
resolution on the wrapped instance, or (b) string-coercion paths bypassing
the class dispatch surface. Reduce with a plain user class first
(`class P { toString(){ return "x"; } }` via a dynamic receiver) — if that
also fails, this is general, not Temporal-specific; say so in the PR.

## Acceptance criteria

1. Reduced repro (plain class + Temporal shape) returns the prototype's
   toString result, host lane; new tests failing on base.
2. `String(inst)`, template-literal interpolation, and `"" + inst` measured.
3. No regressions in class-dispatch scoped runs (#5201/#5202 files).
   Gates green.

## Notes

- Siblings #5221/#5222. Id reserved with a degraded PR scan; manually
  checked against open PR head branches 2026-08-30.
