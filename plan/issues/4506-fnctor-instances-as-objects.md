---
id: 4506
title: "standalone representation: fnctor instances become $Objects — retire the bespoke $__fnctor_<F> struct population (unlocks #4480 R1/R3/R4, isPrototypeOf, dynamic expando)"
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
language_feature: object-representation
goal: standalone-gap
related: [4480, 3976, 2660, 4464]
origin: "2026-08-15 #4480 S2 finding — the single change that retires its R1/R3/R4 together is shrinking the bespoke-struct population (#3976-style conversion applied to fnctors). Filed per lead decision (option a) closing #4480 at +3."
---

# #4506 — fnctor instances as $Objects

## Problem

`new F()` for a user function lowers to a bespoke `$__fnctor_<F>` WasmGC
struct with typed fields and NO `$proto` slot and NO expando storage. #4480
S2 papered the [[Prototype]] question with a static per-constructor answer,
but the representation wall remains and blocks, measured:

- `F.prototype.isPrototypeOf(i)` — the native walk `ref.test (ref $Object)`
  fails on the bespoke struct (#4480 R4, `it.fails`-pinned, plus the #2660
  escape-gate demotion evidence recorded in native-is-prototype-of.ts).
- Dynamic expando writes/reads on instances; descriptor semantics on
  instances (#4479's lane stops at `$Object` receivers).
- `[[Construct]]`-return and typed-field value-rep rows misattributed to
  #4480 (S13.2.2_A12: `this.id = 0` types the slot f64, later string write
  wrongs it — the #4480 report's read of the residual corpus).
- #4455 R3 (static accessors need the class OBJECT as $Object) is the class
  twin of this fnctor problem.

## Additional blocked rows routed here (from #4484, 2026-08-16)

The missing `{}` -> `Object.prototype` [[Prototype]] edge alone blocks:
`instanceof/S11.8.6_A1`, `A2.4_T1/_T4`, `in/S8.12.6_A2_T1/_T2`,
`types/object/S8.6.2_A1/_A2` — #4484's family-D `in` guard lands but flips
nothing until this edge exists. Object-literal chain linkage is in scope
here alongside the fnctor conversion.

## Direction (read #4480's Design section + #3976's record first)

#3976 already converted CLASS elements to own-property installs while
keeping nominal structs for dispatch — its issue file documents why the
class object is NOT an `$Object` and what depends on `ref.test` dispatch
(`emitDynamicNewFallback`). The fnctor conversion must either:

- (a) mint instances AS `$Object`s (typed fields become property-table
  entries; escape-gate fast paths become an optimization tier for
  non-escaping instances), or
- (b) extend the bespoke structs with `$proto` + expando side-table slots,
  keeping typed fields (halfway; smaller blast radius; leaves gOPD/descriptor
  semantics partial).

Decide by measurement: count modules in the ES≤5 corpus where the bespoke
representation's fast path is actually load-bearing (perf lane exists in
benchmarks/) vs rows blocked by it. Record the decision matrix in this file
before implementing.

## Plan

1. Brief: plan/method/es5-standalone-agent-brief.md. Read #4480 Design,
   #3976 record, #2660 escape gate, new-super.ts receiver mint (#4464).
2. Measure the decision matrix (above).
3. Slice: (S1) representation change behind the escape gate's existing
   classification — non-escaping instances keep structs, escaping ones get
   $Objects; (S2) [[Prototype]] link at mint via the #4480 global; (S3)
   retire #4480's static getPrototypeOf arm in favor of the real field.
4. Full sweep floor: the #4480 823-file scope + built-ins/Object (descriptor
   interplay) + fn-family pins + equivalence per-file loop; byte-identity on
   modules with no `new <fn>` sites.

## Acceptance criteria

- #4480 R4's it.fails pin flips to passing; ≥10 rows across the
  isPrototypeOf/construct-return/value-rep families; zero regressions on the
  #4480 sweep scope; decision matrix recorded.
