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

## Triage (2026-09-06, on the #5247 branch) — NOT resolved, but now DIAGNOSED

#5247 unwraps an escaping throw at the export boundary, so this issue's
`WebAssembly.Exception` is now readable. Both probes still throw; the wrapper
was hiding two DIFFERENT real failures, neither of which is the export
boundary.

Single-module lane, polyfill + probes in one compile with `const Temporal = qi;`
(the #5243 binding rule), fresh `JS2WASM_TEMPORAL_CACHE`, measured on
`issue-5247-uncaught-throw-export-boundary`:

```
Duration.from({hours: 25})                      → "PT25H"      (correct)
Duration.from({hours: 1}).add({hours: 2})       → "PT3H"       (correct)
Duration.from({hours: 25}).total({unit:"hours"})
    THREW SyntaxError: Cannot convert 817405952,3352 to a BigInt
Duration.from({hours: 25}).round({largestUnit:"days"})
    THREW RangeError: roundingIncrement must be at least 1 and at most 1e9, not 0
```

So the two rows are NOT one defect:

- **`total()` — a BigInt conversion fed a malformed operand.** The argument
  `817405952,3352` is two numbers joined by a comma: a compiled value reached
  `BigInt(...)` after being stringified as a LIST, i.e. an array/tuple-shaped
  carrier where the polyfill's balancing arithmetic expects a single numeric.
  That points at the `i64`/BigInt marshalling of a multi-value or
  array-shaped intermediate, not at `total` itself.
- **`round()` — an options-bag read answered 0 where the polyfill defaults 1.**
  `roundingIncrement` is `undefined` in the probe, so the polyfill's default of
  `1` did not survive; a missing property read that answers `0` instead of
  `undefined` defeats a `??`/`||` default. That is the options-bag MOP surface
  the Direction listed as a candidate, and it is independent of the `total()`
  arithmetic.

Both need their own reduction. This issue stays open; what #5247 changed is
that the payload is now legible, so the next attempt starts from these two
messages rather than from an opaque wrapper.

## Notes

- Found by dev-5244 (PR #5360 "Reported, NOT fixed"), recorded so it is not
  rediscovered. Blocks full Duration-family conformance, not the #4628
  criterion-2 runner wiring.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
