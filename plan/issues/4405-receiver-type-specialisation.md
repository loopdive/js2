---
id: 4405
title: "receiver-type specialisation: prove `this` per prototype-method family, emit guard-free typed variants"
status: ready
sprint: current
created: 2026-08-14
priority: high
horizon: xl
feasibility: hard
task_type: perf
area: codegen
related: [4157, 4406]
---

# #4405 — receiver-type specialisation: prove, don't guess

## Problem

#4157 entry 39's paired-profile decomposition: after the tuned-11 flip,
**~3.2× of the remaining ~5.7× gap to Node lives INSIDE compiled function
bodies**, not in helper calls. The worst offenders are acorn's prototype
methods — `pp.next` **19.5×** slower than V8's compiled version,
`pp$5.parseSubscript` **9.9×**, `finishNodeAt` **9.0×**, `pp.skipSpace`
6.2× — while functions with already-direct shapes (`pp$2.finishNode`,
`stringToNumber`) sit at **1.0× parity**. The gap is concentrated, not
uniform: it is the per-operand re-resolution, guard diamonds, and boxed
traffic that dynamic `this` forces on every member access.

The compiler already has the proven-path tier (`__typed_this` closure
variants exist where `this` is derivable today; `ELIDE_PROVEN_NONNULL_TYPEERROR`
elides on proof; guard-reuse drops provably-redundant checks). What's missing
is the WHOLE-PROGRAM step: for the `pp.foo = function(){...}` prototype-method
idiom, prove the receiver's constructor family closed-world and emit a fully
typed variant with raw `struct.get`/`struct.set` — **no guard, no fallback** —
plus the dynamic original for unproven call paths.

## Why proof, not more ICs (project-lead direction, 2026-08-13)

A monomorphic guard is nearly free at runtime but is a control-flow diamond
the optimizer cannot fold across — defect C existed because of exactly that.
Proof buys code size AND unblocks downstream optimization, and where it
succeeds it subsumes the (default-OFF) site-IC guards of
`JS2WASM_SET_MEMBER_IC` / `JS2WASM_CALL_DISPATCH_IC` (#4491).

## Shape of the work

1. **Closed-world receiver inference**: for each fnctor/constructor family,
   collect every prototype-method assignment and every construction site;
   prove per method that all reachable receivers are the family's struct
   (no expando writes to the accessed props, no `delete`, no setter, no
   escaping alias that widens the type).
2. **Typed variant emission**: clone the method body with `this` bound to the
   proven struct type; member reads/writes lower to direct field ops; numeric
   fields stay f64/i32 end-to-end.
3. **Call-site routing**: call paths whose receiver provenance is proven route
   to the typed variant; everything else keeps the dynamic original.
4. Flag-gated (`JS2WASM_RECEIVER_SPEC`, default OFF), byte-identical off,
   poison probe, exec-census + per-function profile deltas on the acorn lane
   (targets: `pp.next` and `parseSubscript` self-time, entry 39's table as
   the before).

## Acceptance criteria

- `pp.next`'s wasm/node self-time ratio drops materially below 19.5× with the
  flag on (measured by entry-39's paired-profile method).
- Checksum 422; equivalence suites green scoped; flag-off byte-identical.
- An architect spec (`## Implementation Plan`) lands in this file before
  implementation — the inference's soundness conditions are the hard part.
