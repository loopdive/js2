---
id: 4620
title: "ES5 standalone: sloppy-this boxing + primitive expando + arguments-object surface — function-code 10.4.3-1-* family, arguments descriptors, callee rows (~30 rows)"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: this-binding
goal: standalone-gap
related: [4489, 4464, 4436]
origin: "2026-08-16 residual map at 97.26%. language/function-code ~10 + language/arguments-object 6 + statements/function residual ~14 share this-binding/arguments-object roots."
---

# #4620 — sloppy-this boxing + arguments-object surface

## Problem (measured 2026-08-16)

- **A — sloppy `this` primitive boxing (`10.4.3-1-10x` family, ~8)**:
  `fn.call(5)` in sloppy mode must box: `(5).x = 'foo'` on the boxed this,
  `typeof this === "object"`, `this == 5` true, `this === 5` false.
  Measured shapes: `(5).x === 5` false rows, `typeof (5).x` expected
  "object" got other, TWO **illegal cast [in __module_init]** rows
  (10.4.3-1-102-s/-102gs — crash class, diagnose FIRST), `eval("typeof
  this")` strict row, `10.4.3-1-83/84-s` "not a function".
- **B — arguments-object property surface (6)**: `length` descriptor must
  be `{writable:true, enumerable:false, configurable:true}` (10.6-6-2,
  10.6-7-1); `typeof arguments[i]` where arg is a function (10.6-13-a-1);
  `S10.6_A5_T3/T4` "arguments object don't exists" (arguments inside
  nested/expression shapes); `Array.isArray(arguments)` false row.
- **C — statements/function residual (~14 non-prototype rows)**:
  `callee === 0` rows (arguments.callee identity), `__instance is not a
  function` (2), `Cannot destructure null` (1), `S13_A2_T2` x==="11",
  function-code S10.2.1_A4_T1/T2 (declaration-instantiation order),
  `S12.9_A5` return-undefined, `S8.1_A2_T2`/`S8.3_A1_T1` void-return
  rows, identifier-resolution scope-chain rows (S10.2.2_A1_T3,
  S11.1.2_A1_T1 "y is not defined").
- **NOT here**: isPrototypeOf rows (→ #4506 fnctor representation).

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   all families live first; crash-class rows (A's illegal casts) FIRST.
2. A: find the sloppy-this substitution site (`helpers/sloppy-this-global.ts`
   — #4489's catalogue documents its §10.4.3 fallback semantics). The boxing
   arm: primitive this → wrapper object with expando storage. The #4489
   undefined-singleton interplay is documented in its issue file — read the
   sloppy-this row of its consumer catalogue before touching.
3. B: arguments-object materialization (`function-expected-argument-count.ts`
   #4436, the `arguments` sections of new-super.ts) — descriptor surface
   goes through whatever gOPD consults; check how #4479's descriptor lane
   stores attributes and reuse.
4. C: triage per-row; declaration-instantiation-order rows may be one
   hoisting fix; scope-chain rows may route to eval-scope machinery
   (decline+record if eval-substrate-walled).
5. Verify: scoped sweeps language/function-code + language/arguments-object
   + language/statements/function before/after (own runs); pins
   4436/4437/4464/4489 green; ≥15 of ~30 flip, zero regressions; residuals
   with owners.
