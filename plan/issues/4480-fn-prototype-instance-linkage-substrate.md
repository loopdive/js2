---
id: 4480
title: "standalone substrate: every function owns a real `.prototype` object linked to its instances — the recurring blocker behind F3/#4455-R3/R4/Array-A1 (~25+ rows)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
es_edition: 5
language_feature: function-prototype
goal: standalone-gap
related: [3976, 4464, 4455, 2660, 4437]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. Four independent agent waves hit this same wall and each recorded it as a residual: #4464 F3 (8 files) + F2-residual (7), #4455 R3/R4, S13.2.2_A1/S13.2_A1 isPrototypeOf family."
---

# #4480 — fn.prototype auto-object + instance [[Prototype]] linkage

## Problem

§13.2 steps 16–18: every function gets an own `.prototype` object whose
`constructor` points back, and §13.2.2 [[Construct]] links `new F()`
instances to that object. Standalone has neither: `__func.prototype` answers
undefined/null, `F.prototype.isPrototypeOf(new F())` is false,
`Object.getPrototypeOf(instance) === F.prototype` fails, and reads at `new`
sites typed from the checker leak nulls/NaN (the #4464 F2-residual
signature). Four waves independently filed this as their blocking residual —
it is the highest-leverage single substrate gap in the ES5 bucket
(~25 directly-measured rows; more behind them).

## What already exists (read ALL before designing)

- `emitLazyProtoGet` (class prototypes as singleton `$Object` globals) — the
  CLASS half of this substrate already works; `D.prototype.__proto__`
  chaining is #4455 R4's known gap.
- `closure-prototype-edge.ts` (#2660 M3) — prototype-edge handling for
  closures; the natural home or neighbor for the new carrier.
- `function-instance-meta*.ts` (#4437) — the PROVEN pattern for attaching a
  per-function slot to closure structs (`$fnmeta` nominal brand, sibling
  families, resolver arm). A `.prototype` slot is the same shape: a lazily
  minted `$Object` hanging off the closure.
- `construct-return-value.ts` + `new-super.ts` (#4464) — `new <fnctor>` now
  mints receivers; the linkage point for instance [[Prototype]] is there.
- #3976 (done) installed class elements as own props — its issue file
  documents why the class OBJECT itself is not an `$Object` (the
  `emitDynamicNewFallback` `ref.test` dispatch depends on nominal structs).
  Do not break that; the fn.prototype carrier must coexist.

## Implementation Plan

1. Design doc FIRST (in this issue file, before code): the carrier (a
  `$fnproto` mut ref slot on closure-with-meta families, or a side table
  keyed like #4437's), lazy mint semantics, `constructor` back-ref, and how
  `new F()` receivers get `[[Prototype]] = F.prototype` (the receiver mint in
  `new-super.ts` is the write point; `Object.getPrototypeOf`/`isPrototypeOf`
  are the read points).
2. Slice S1: `.prototype` READ on user function declarations/expressions
   returns a stable lazily-minted `$Object` with `constructor` back-ref
   (S13.2_A1_T1/T2, S13.2_A4 family flip).
3. Slice S2: `new F()` instance linkage — `isPrototypeOf`/`getPrototypeOf`
   answer the minted object (S13.2.2_A1, Array/S15.4.1_A1-style rows).
4. Slice S3: assignment `F.prototype = obj` re-points the slot; instances
   minted AFTER see obj (S13.2.2_A19_T7/T8).
5. Controls: byte-identity on modules that never touch `.prototype`;
   fn-family pins (4436/4437/4440/4442/4456/4460/4464) green; scoped sweeps
   over `language/statements/function` + `built-ins/Function`.
6. This is XL: ship slices as separate commits; S1+S2 alone clear the
   acceptance bar. Record a real design section — the next wave builds on it.

## Acceptance criteria

- ≥15 rows flip across the S13.2 family + isPrototypeOf rows; zero
  regressions; the design section documents the carrier for successors.
