---
id: 4625
title: "standalone: string-literal element-access callee `x[\"toString\"]()` never reaches the property-access dispatch — normalize onto the fixed route; unblocks property-accessors S11.2.1_A3_T1/_T2 remaining checks"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: member-access
goal: standalone-gap
related: [4619, 4481]
origin: "dev-4619 R1 (2026-08-23): base AND after both throw 'Cannot access property on null or undefined' — a static-key ElementAccess callee has its own dispatch chain that never reaches the route #4619 fixed. Blast radius wanted its own issue."
---

# #4625 — element-access callee normalization

## Problem (measured by dev-4619)

`x["toString"]()` (string-literal key, callee position) throws
`TypeError: Cannot access property on null or undefined` on shapes where
the property-access spelling `x.toString()` now works (#4619's
wrapper-proto dispatch). A static-key `ElementAccessExpression` callee is
lowered by its own dispatch chain (`src/codegen/expressions/
call-tail-dispatch.ts`) which never consults the property-access route
that #4619 (and #4481/#2175 before it) taught about wrapper receivers and
singleton-carried proto-method values.

This is the whole of what still blocks
`language/expressions/property-accessors/S11.2.1_A3_T1.js` (CHECK#2/#4)
and `_T2.js` (CHECK#3/#4) — both rows' first checks pass since #4619.
Pinned `it.fails` in tests/issue-4619.test.ts (R1).

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   the two rows + the R1 pins on current campaign HEAD.
2. Normalization point: early in the call lowering, rewrite a callee of
   shape `ElementAccess(expr, StringLiteral k)` where `k` is a valid
   identifier-shaped key onto the same code path as
   `PropertyAccess(expr, k)` — ONE canonical entry, not a parallel
   re-implementation inside call-tail-dispatch.ts. Find where
   `call-tail-dispatch.ts` branches on callee kind and route, don't copy.
   Non-identifier keys (`x["a b"]()`) keep the element chain.
3. Mind the blast radius: element-access callees on arrays/vecs and
   computed-key numeric shapes must be byte-stable — the normalization
   must be conditioned on a STATIC string key only. Lane byte-identity
   check on host/gc for a probe set that exercises numeric element calls.
4. A/B: the two acceptance rows + #4619's R1 pins flip to positive +
   scoped `language/expressions/property-accessors` (21 files) and a
   `built-ins/{Boolean,Number}/prototype` re-sweep, zero regressions,
   own runs both arms.
5. Pins: tests/issue-4625.test.ts; flip #4619's R1 `it.fails` pins in the
   same change (the pin's design).
