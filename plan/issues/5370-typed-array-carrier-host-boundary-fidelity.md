---
id: 5370
title: "Typed-array carriers are not faithful at the host boundary: `ArrayBuffer.isView()` answers false for a compiled carrier, a host-built typed array loses its brand crossing in, and `new Uint8Array(<host typed array>)` builds an EMPTY carrier"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Three defects found while writing #5362's regression test, all pre-existing
on `main` and none fixed there (#5362 only made `_wrapForHost` honour the
`__register_typed_array` brand on the way *out*):

1. `ArrayBuffer.isView(u8)` from compiled code answers `false` for a compiled
   typed-array carrier (Node: `true`).
2. A host-built typed array **loses its brand crossing in** through
   `__vec_from_extern_<N>`: it arrives as a plain vec, so a later crossing
   out re-emits a plain `Array` — the exact shape that made
   `SubtleCrypto.importKey` reject in #5362.
3. `new Uint8Array(<host typed array>)` builds an **empty** carrier
   (`DataError: Zero-length key is not supported` from the next host call).

hono's remaining `cookie.test.ts` failures (11/35 after #5362) and every
WebCrypto / `TextEncoder` / `Buffer`-adjacent library path cross this
boundary in both directions.

## Acceptance criteria

1. Three probes match Node: `ArrayBuffer.isView(new Uint8Array(3)) === true`
   in compiled code; `f(hostU8)` where `f` is compiled and returns its
   argument to a host `ArrayBuffer.isView` check answers `true` with the
   contents intact; `new Uint8Array(hostU8).length === hostU8.length` with
   equal contents.
2. Regression test under `tests/`, untyped `.js` two-file fixtures, one case
   per defect, failing on the parent and passing with the fix, exact counts
   both ways, anti-vacuity control (a plain array literal is still a plain
   `Array` on both sides).
3. A/B at one HEAD over all 17 suites, per file — hono `cookie.test.ts` is
   expected to move; nothing regresses.
4. Standalone lane status recorded (these are host-boundary defects; the
   standalone lane should be byte-identical).

## Implementation Plan

1. **Measure first, post-#5362.** Run the three probes on current `main`
   (standalone `.mjs`, `compileAndRunUpstreamModule`, untyped `.js`): the
   #5362 fix may already have flipped (1). Record exact results.
2. **(1) `isView`**: find how the call is lowered — a static builtin arm
   answering `false` for a struct (grep `isView` in `src/codegen` and
   `src/runtime.ts`), or a host call whose argument crossed without the
   brand. Fix at the arm that answers.
3. **(2) crossing in**: in `__vec_from_extern_<N>` (host side, `src/runtime.ts`)
   the host knows `ArrayBuffer.isView(src)` and the constructor name → typed
   kind; register the brand (`__register_typed_array`, the kind #5362's
   instrumentation showed as `taKind`) on the produced carrier. Check the
   element copy keeps the element type (Uint8 vs Float64).
4. **(3) `new Uint8Array(hostTA)`**: find the TypedArray constructor lowering
   (grep `Uint8Array` in `src/codegen/typed-array*.ts` / `builtins`) and its
   host-object arm — it likely reads `length` through a route that answers
   `0` for a host typed array. Route it through the crossing-in path from
   step 3 (copy + brand).
5. Regression tests; A/B; one PR. Growth allowances for `src/runtime.ts` in
   this issue's frontmatter with the reason, as #5362 did.

## Dispatch

Model: **opus**. Three located defects in known arms; the only design point
is where the brand is registered on the way in.
