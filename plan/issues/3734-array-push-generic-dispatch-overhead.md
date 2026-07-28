---
id: 3734
title: "Array.prototype.push on a statically-typed number[] goes through the generic externref __vec_push dispatcher instead of a monomorphic fast path"
status: ready
sprint: Backlog
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: arrays
goal: performance
depends_on: []
related: [3704, 3733]
---
# #3734 — statically-typed `number[]` push routes through the generic `__vec_push` dispatcher

## Context

Discovered while investigating why the landing-page playground benchmark
(`website/playground/examples/benchmarks/array.ts`) shows wasm running
noticeably slower than JS. The benchmark is:

```ts
export function bench_array(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let total = 0;
  for (let i = 0; i < arr.length; i++) total = total + arr[i];
  return total;
}
```

## Findings

Compiled (`-O`, JS-host/GC target) and inspected the `.wat`. Two separate
observations, in order of suspected impact:

### 1. `arr.push(i)` calls the generic, polymorphic `__vec_push` helper

Every `.push()` call site compiles to a call into a single shared
`__vec_push(externref, externref) -> i32` runtime function (see
`src/codegen/array-methods.ts`) that:

1. Boxes the receiver to `externref` (`any.convert_extern`).
2. Runtime-dispatches which concrete vec struct type it is via a
   `ref.test`/`ref.cast` chain (checked at least 3 candidate struct type
   indices in the disassembly — presumably one per distinct element
   representation the module uses).
3. Only THEN does the actual amortized-doubling array-growth logic
   (`array.len` vs length field, conditional `array.new_default` + `array.copy`
   when capacity is exhausted, `array.set`, length-field bump) for whichever
   branch matched.

For `arr: number[]` the element type (`f64`) and the vec's concrete struct
type are **both known statically at the call site** — there's no need to
box to externref or runtime-dispatch at all. A monomorphic fast path could
compile directly to: `struct.get` (data array + length), the same
amortized-doubling growth check, `array.set`, length bump — no boxing, no
`ref.test` chain, likely 1 direct call (or fully inlined) instead of a
generic multi-way dispatch.

The growth strategy itself (`array.new_default` sized via `max(cap*2, cap+1)`
+ `array.copy`) looks correct/amortized-O(1) — this is NOT an accidental
O(n²) push loop. The suspected cost is strictly the per-call polymorphic
dispatch overhead × 10,000 calls.

### 2. The sum loop re-reads `arr.length` (a `struct.get`) every iteration

```
for (let i = 0; i < arr.length; i++) total = total + arr[i];
```

compiles to a `struct.get 4 0` (the length field) on every loop
iteration instead of being loop-invariant-hoisted once before the loop, even
though nothing in the loop body can change `arr`'s length. This is a single
cheap instruction per iteration (not a call), so likely much smaller impact
than #1 — flagged for completeness, lower priority than the push dispatch.

## Suggested approach

1. **Triage first**: measure the two effects independently (e.g. a
   standalone micro-benchmark that isolates just the push loop vs just the
   sum loop) to confirm #1 dominates before investing in it — don't assume
   without measuring.
2. For #1: add a codegen fast path for `.push()` (and likely the sibling
   `.pop()`/direct-index-write cases already handled elsewhere) when the
   receiver's array element type is statically known at the call site,
   bypassing `__vec_push`'s externref-boxing + `ref.test` dispatch chain
   entirely — emit the growth-check + `array.set` + length-bump sequence
   inline (matching the pattern `__vec_push` already implements for its
   matched arm), or a per-element-type monomorphic helper the call site
   dispatches to directly by static type instead of by runtime `ref.test`.
3. For #2 (much smaller / optional): consider a loop-invariant-length-read
   optimization for the common `for (i = 0; i < arr.length; i++)` shape when
   the loop body is provably non-mutating of `arr`'s length — likely a
   peephole/LICM-style pass rather than a special case, and correctness-sensitive
   (must not hoist across any mutation, including via aliasing/closures)
   enough that it may not be worth the risk relative to its small payoff.

## Acceptance criteria

- [ ] Confirm via isolated micro-benchmarks which of the two effects (or
      both) actually dominates the measured slowdown before implementing.
- [ ] `.push()` on a statically-known-element-type array no longer routes
      through externref-boxing + `ref.test` dispatch.
- [ ] Equivalence tests pass, including polymorphic/`any`-typed array push
      call sites (must still work — this is an *additional* fast path, not
      a replacement for the generic dispatcher, which any-typed/mixed arrays
      still need).
- [ ] Re-run the playground benchmark generator and confirm `array.ts`'s
      wasm time improves materially.

## Out of scope

- This issue is analysis + a suggested approach, not a landed fix — the
  push-dispatch fast path is a genuine codegen feature addition (new
  monomorphic emission path + call-site type-based selection), non-trivial
  and regression-risky enough that it should get its own dedicated
  implementation + review pass rather than being rushed alongside #3733's
  narrower ToInt32 fix.
