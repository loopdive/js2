---
id: 5221
title: "Temporal.PlainDate.from(…) traps with a null-pointer deref — polyfill intrinsic / Object.create(proto) machinery, single-module too"
status: ready
sprint: current
priority: high
horizon: l
goal: core-semantics
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5221 — `Temporal.PlainDate.from(…)` null-pointer deref

## Problem

With the #4628 provider wired (PR #5318), `Temporal.PlainDate.from("2020-03-04")`
traps with `RuntimeError: dereferencing a null pointer`. Measured by
dev-temporal-wire to fail IDENTICALLY when the polyfill is compiled as one
module with no provider and no linking — a pre-existing gap in the compiled
polyfill's intrinsic / `Object.create(proto)` machinery, not the provider
seam. This is the biggest conformance blocker left on the Temporal bucket:
`.from(...)` is the entry point most test262 rows use, which is why the
runner was deliberately NOT wired to the provider yet (rows would move from
"not defined" to a null deref with no net gain).

## Direction

Reduce inside the single-module polyfill compile (harness ESM lane):
instrument where the null flows from — likely `Object.create(proto)` /
%Intrinsic% table population in the compiled polyfill. Reduce to a minimal
compiled program before touching codegen/runtime.

## Acceptance criteria

1. `Temporal.PlainDate.from("2020-03-04")` returns a working object,
   single-module AND through the provider; new tests failing on base.
2. Temporal 256-row slice (dev-temporal-wire's deterministic sample) measured
   before/after; report deltas.
3. No regressions in issue-4628 test files + equivalence gate. Gates green.

## Notes

- Found by dev-temporal-wire validating PR #5318. Siblings: #5222 (Now.*
  lost across provider boundary), #5223 (instance toString dispatch).
- Id reserved with a degraded PR scan; manually checked against open PR
  head branches 2026-08-30.
