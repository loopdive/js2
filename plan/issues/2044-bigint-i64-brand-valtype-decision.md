---
id: 2044
title: "architect decision: BigInt value representation — i64-bigint-brand ValType vs TS-type-driven boxing (gates #1644 slices, implicated in #2039 i64 ABI bucket)"
status: blocked
blocked_by: [2167]
sprint: 65
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: planning
area: codegen, ir
language_feature: bigint
goal: core-semantics
related: [1644, 1349, 2039, 1852]
origin: "Standing gate recorded since sprint 50: #1349/#1644 BigInt slices are blocked on an architect ratifying the i64-bigint-brand ValType design; the 2026-06-10 standalone gap review surfaced ~230 async-generator invalid-Wasm rows with `call[0] expected i64, found extern.convert_any` (#2039), which sit on the same representation boundary."
---

# #2044 — BigInt representation decision (i64-bigint-brand)

## Problem

BigInt values currently ride as externref (host-boxed) while native `i64`
numeric code uses raw i64 — and the type system cannot tell a "BigInt-shaped"
value from either neighbor. Consequences:

- Typed paths emit `f64.add` on externref BigInt operands → `illegal_cast`
  (#1644's core bucket; `built-ins/BigInt` pass rate stuck at 39%).
- `BigInt(x)`, `asIntN`/`asUintN`, mixed-operand TypeError semantics
  (`1n + 1` must throw) have no brand to dispatch on.
- Boxing *all* i64→externref as BigInt would break native i64 numeric code
  (the `type i64 = number` annotation feature), so the distinction must be
  carried in the type system, not guessed at coercion sites.
- The #2039 standalone bucket (`call[0] expected type i64, found
  extern.convert_any` in async-generator destructuring, ~230 tests) sits on
  this same i64↔externref ABI boundary — diagnose whether it is the same
  representation confusion or an unrelated async-gen ABI bug, and record the
  answer here either way.

## Decision to ratify (from #1644's analysis)

Choose and specify one:

- **(a) `bigint`-branded ValType** — `{kind: "i64", bigint: true}` threaded
  through type inference and **every coercion site** (`coerceType`,
  `__typeof`, truthiness, arithmetic dispatch, boxing round-trips). Honest
  and explicit; the cost is the cross-cutting thread through
  `src/codegen/type-coercion.ts` and the IR ValType union.
- **(b) TS-type-driven boxing decisions** — use `ctx.checker` at call sites
  to decide boxing; `coerceType` keeps seeing plain ValType. Cheaper to
  introduce, but pushes brand knowledge to call sites and risks divergence
  (the exact pattern that produced the #2039-style mismatches).

Constraints the ratified design must satisfy:

- GC/host mode and standalone mode lower **identically** at this boundary
  (the #1644 "ratify once, both modes" invariant).
- Native `i64` annotation code keeps raw-i64 performance (no boxing).
- `typeof 1n === "bigint"`, mixed-arithmetic TypeError, and `asIntN/asUintN`
  wrap semantics are all expressible via the brand.
- Standalone mode has a pure-Wasm story (i64 pair / struct for >64-bit
  values is out of scope; document the supported range honestly).

Deliverable: `## Implementation Plan` in this issue with the chosen
representation, the list of consultation sites (boxing, `__typeof`,
truthiness, arithmetic, equality/`isSameValue`), and re-sized #1644 slices.

## Why model: fable

One-shot, expensive-to-reverse representation decision that ripples through
every coercion site and both backends — the same class of decision as #1852
(per-backend value representation), with which it must stay consistent.

## Acceptance criteria

- A ratified representation design recorded here; #1644 unblocked with
  re-sized slices referencing it.
- The #2039 `i64`/`extern.convert_any` async-gen bucket is attributed (same
  root cause or explicitly ruled out), with the evidence cited.
- No regression in native-i64 benchmark code paths
  (`benchmarks/` numeric suites) under the chosen design.
