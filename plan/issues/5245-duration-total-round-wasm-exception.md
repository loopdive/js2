---
id: 5245
title: "Temporal.Duration total()/round() throw WebAssembly.Exception single-module — survives the #5243/#5244 arithmetic fixes"
status: ready
sprint: current
priority: medium
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5245 — `Duration.total()` / `round()` throw `WebAssembly.Exception`

## Problem

Single-module (polyfill + probe in one compile, `const Temporal = qi;`
binding):

- `Temporal.Duration.from({hours: 25}).total({unit: "hours"})` throws a
  `WebAssembly.Exception`
- `Temporal.Duration.from({hours: 25}).round({largestUnit: "days"})` — same

Measured by dev-5244 (PR #5360) on BOTH sides of its fixes, unchanged — so
this is not the `__argc` ladder gap, not the `__sset_` guard trap, and not
#5243's record nulling. The rest of the arithmetic family
(`from`/`add`/`subtract`/`until`/`since`/`with`) is correct on that branch.
Not triaged; the exception's payload was not decoded.

## Direction

Probe on top of PR #5360's branch (`issue-5244-ctor-mirror-arg-loss`). First
decode the exception (compile with the throw-payload surface from the #5226
family if needed, or log at `__throw` sites); `total`/`round` are the
polyfill's balancing paths, so plausible families: i64/f64 arithmetic in unit
conversion, `Math.*` lowering, or a missing MOP surface on the options bag.
Reduce non-Temporal at the general site.

## Acceptance criteria

1. Both probes answer correctly (`25` hours; a rounded duration) with a
   non-Temporal reduction failing on base.
2. No regressions in the issue-5221…5244 family; equivalence gate at
   baseline; gates green.

## Notes

- Found by dev-5244 (PR #5360 "Reported, NOT fixed"), recorded so it is not
  rediscovered. Blocks full Duration-family conformance, not the #4628
  criterion-2 runner wiring.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
