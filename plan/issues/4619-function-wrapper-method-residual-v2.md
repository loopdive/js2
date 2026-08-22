---
id: 4619
title: "ES5 standalone: built-ins/Function residual v2 + wrapper-method value calls — Function.prototype.toString, apply/call TypeErrors, bind surface (~35 rows)"
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
language_feature: function-methods
goal: standalone-gap
related: [4483, 4442, 4481, 4518]
origin: "2026-08-16 residual map at 97.26% (222 failing). built-ins/Function 26 + Boolean 2 + Number 2 + ~4 String rows blocked on Function.prototype.toString + wrapper-method value calls."
---

# #4619 — Function residual v2 + wrapper-method value calls

## Problem (measured 2026-08-16, baseline at 7,893/8,115)

- **A — `Function.prototype.toString` not implemented** (explicit TypeError
  "not yet implemented in --target standalone"): blocks ≥2 String rows
  (`function-code` sources concatenated), `addition/S11.6.1_A2.2_T3`
  (`f1 + 1 === f1.toString() + 1`), and Function-bucket rows. A §20.2.3.5
  NativeFunction-shaped render (`"function <name>() { [native code] }"` is
  spec-legal for everything without source) may clear most.
- **B — apply/call TypeErrors still missing (5)**: "Expected a TypeError"
  rows that survived #4483 — re-measure which shapes (likely non-callable
  receiver via VALUE call `Function.prototype.apply.call(...)` or
  arguments-object argArray edge).
- **C — bound-function surface (2)**: `obj.touched` rows — #4483 family B,
  untaken.
- **D — wrapper-method VALUE calls "called value is not a function" (~6)**:
  `Boolean.prototype.toString` (S15.6.4.2_A1_T1/T2), `Number.prototype.
  toString` (S15.7.4.2_A1_T01), `property-accessors/S11.2.1_A3_T1/T2`,
  `String "is not a constructor"` — the #4481 identity singletons made
  these READABLE; calling the read value still fails. The call arm for a
  singleton-carried proto method value is the gap (#4481 R4's call-site vs
  call-value non-equivalence, pinned there).
- **E — `Array.prototype.concat` "not yet callable as a value" (2 Array
  rows)** — same class as D, explicit CE-style TypeError.
- **F — null-property TypeErrors at 263:18 (2)** + `obj["shifted"]` rows —
  triage.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   every family live; the baseline lags a fast-moving main.
2. Family D/E first (one mechanism): make the #4481/#2175 singleton values
   CALLABLE through the reflective dispatch — the closure-struct the
   singleton carries needs a call arm in calls.ts's callable-value路径
   (read #4481's R4 pin + `instance-proto-method-identity.ts` + the #4442
   provider-linked call constraint). Likely ONE fix clearing D+E+part of B.
3. Family A: implement `Function.prototype.toString` as §20.2.3.5
   NativeFunction render from the #4437 metadata (name available) —
   `"function " + name + "() { [native code] }"`; user functions with
   known source may defer (record residual). Wire as native proto method +
   value singleton.
4. B/C: re-measure post-D; fix what remains per #4483's family records.
5. Verify: scoped sweeps built-ins/{Function,Boolean,Number} +
   property-accessors before/after (own runs); fn-family pins
   (4436/4437/4440/4442/4456/4460/4464/4483) green; ≥18 of ~35 flip, zero
   regressions.
