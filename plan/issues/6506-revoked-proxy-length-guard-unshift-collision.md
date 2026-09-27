---
id: 6506
title: "A revoked proxy reached via LengthOfArrayLike does not throw — two competing body.unshift()s onto __extern_length collide"
status: ready
sprint: current
created: 2026-09-18
updated: 2026-09-18
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: ttraenkler/fable-es2015
model: opus
related: [6494, 2547]
---

# The revoked-bit guard on `__extern_length` cannot be a naive front guard

§10.5 makes **every** internal method of a revoked proxy throw. `Array.prototype.map.call(revokedProxy, f)`
performs LengthOfArrayLike first, so it must throw — it does not.

## Why the obvious fix is reverted rather than merely absent

#6494 landed exactly that guard: `body.unshift(ref.test $Proxy → if revoked → throw)`
onto `__extern_length`. It worked, its probes were green, every ratchet gate
passed, and the PR-level checks were green — and it **regressed 444 rows** in the
`merge_group` re-validation (net −439, 35,829 → 35,390; 427 `assertion_fail`),
which auto-parked the PR (#2547).

**Root cause: `src/codegen/ta-dyn-mop.ts` (~L1045) already does
`lenFn.body.unshift(...)` on `__extern_length`**, prepending a TypedArray
dyn-view arm that computes the live in-bounds element count. Its own comment
requires that arm to sit **ahead of** the `$__vec_base` arm, because
`$__ta_dyn_view` subtypes `$__vec_base`. A second, independent `unshift` onto the
same function body collides with it, and `%TypedArray%.prototype.set` then
misreads its length — surfacing as `RangeError: offset is out of bounds`.

Reproduced and isolated: removing **only** that guard loop flips
`TypedArray/prototype/set/array-arg-set-values-in-order.js` and
`array-arg-src-values-are-not-cached.js` from fail back to pass, with the three
rows #6494 actually gained still passing.

**This is the second instance of the same hazard in one PR.** #6494 had already
found that `__extern_get_idx` "cannot take a naive front guard", because
`fillExternGetIdxVecArms` locates its splice point by that function's
3-instruction preamble shape. That guard was dropped; the identical `unshift` on
`__extern_length` was kept without checking whether the same dependency existed.
It did.

## What a correct fix has to do

Not another `unshift`. The revoked check has to be composed with the existing
arm structure — either inserted by the same pass that owns
`__extern_length`'s prologue (so the ordering is explicit and single-owner), or
placed after the TA dyn-view arm has had its say, or folded into the dispatch
the arms already route through.

**Any fix must be validated against `%TypedArray%.prototype.set` specifically,
not just against a revoked-proxy probe.** A probe that reads a length stays
green while the arm-spliced paths break — that is exactly how this shipped.

## Acceptance

1. `Array.prototype.map.call(revokedProxy, f)` throws a TypeError.
2. `TypedArray/prototype/set/array-arg-set-values-in-order.js` and
   `array-arg-src-values-are-not-cached.js` still pass, and the full
   `built-ins/TypedArray/prototype/set` directory is unchanged.
3. Measured on both a merge-base tree and the branch, **zero rows lost** — and
   because the failure mode here is invisible to scoped probes, the control set
   must include `built-ins/TypedArray` and `built-ins/Array/prototype`.
4. The known-gap pin in `tests/issue-6494-proxy-reflect-must-throw.test.ts`
   flips from asserting `0` (does not throw) back to `1`; it was deliberately
   written to fail loudly when this lands.
