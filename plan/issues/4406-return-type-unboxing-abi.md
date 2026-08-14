---
id: 4406
title: "return-type unboxing ABI: i32/f64-returning callee twins so booleans and numbers cross calls unboxed"
status: ready
sprint: current
created: 2026-08-14
priority: high
horizon: xl
feasibility: hard
task_type: perf
area: codegen
related: [4157, 4405]
---

# #4406 — return-type unboxing ABI

## Problem

Cross-function boxed traffic is the residual every intra-body pass hits and
cannot touch. Measured on the acorn self-parse (#4157 entries 42/44 and the
lever-4 rebuild): `__box_boolean` executes **310,279** times even with the
fusion pass on, because the box happens in a CALLEE (`__call_m_eat_1` et al.
return a boxed boolean) and the unbox/truthy-test happens in the CALLER —
lever 4's decline tally names the shape precisely: prev-call=372 sites,
arm-tail-call=104, plus ~965 local-flow sites that ultimately source from
calls. The same story holds for numbers via `__box_number`/`__unbox_number`
(214,677 executed unboxes, entry 39).

## Shape of the work

For a function whose result is provably always a boolean (i32) or number
(f64) — starting with the emitted helper families (`__call_m_*` boolean
returners, predicate closures) and extending to user closures with proven
numeric results:

1. Emit an **unboxed twin** `<fn>__ret_i32` / `<fn>__ret_f64` alongside the
   externref-returning original (or rewrite the original and shim the boxed
   signature, whichever keeps the call-graph patch smaller).
2. Rewrite call sites whose consumer wants the raw value (truthiness tests,
   arithmetic, comparisons) to call the twin directly — the box/unbox pair
   vanishes across the boundary.
3. Provenance: result-type proof comes from the emitters (for helpers, the
   fill knows the result) and from `ctx.oracle` signatures for user code —
   never the raw checker.
4. Flag-gated (`JS2WASM_RET_UNBOX_ABI`, default OFF), byte-identical off,
   poison probe, census verdict on `__box_boolean`/`__unbox_number`.

## Interlock with #4405

Receiver-type specialisation multiplies this: typed method variants want
typed RESULTS too, or every proven-receiver call still round-trips its return
value through a box. Spec the ABI so #4405's variants can adopt it directly.

## Acceptance criteria

- `__box_boolean` executed count drops below 100k on the acorn lane with the
  flag on (from 310,279); `__unbox_number` materially down from 214,677.
- Checksum 422; scoped equivalence green; flag-off byte-identical.
- Architect spec in this file before implementation (the twin-vs-shim
  decision and the call-graph patch strategy are the load-bearing choices).
