---
id: 1947
title: "End-to-end GC-ref typing — stop externref laundering inside the module; convert at the host boundary only"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-07-27
priority: high
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
---
# #1947 — End-to-end GC-ref typing (externref at the boundary only)

## Problem

The WasmGC backend round-trips its own GC references through externref as a
matter of course (`extern.convert_any` → externref local →
`any.convert_extern` → `ref.test`/`ref.cast`), even for values that never
cross the host boundary. Evidence from the 2026-06 review probes:

- Closure values stored as externref locals (`closures.ts:3673`; see #1946).
- 286 `ref.test` / 275 `any.convert_extern` sites backend-wide.
- The pipeline even has a dedicated repair pass for the pattern:
  `fixupExternConvertAny` runs last because earlier passes "can introduce
  invalid coercions" (`src/codegen/index.ts:1573-1575`).
- Consequence verified by -O3 disassembly: the type laundering blocks
  Binaryen's GC passes (cast removal, devirtualization, const-field
  propagation) — the strongest free optimizations available on WasmGC are
  forfeited before emission.
- Also discarded: `strictNullChecks` non-nullness — every typed param is
  `(ref null $T)` with per-access null-check-throw blocks; a 6-line
  function carried four.

## Proposed approach

Architect spec first (this is a representation decision):

1. **Boundary discipline**: define where externref is *required* (host
   imports/exports, `any`-typed storage, mixed-type containers) and keep
   concrete `(ref $T)` / `(ref null $T)` local/param/field types everywhere
   else. The IR encoding analysis (`ir/analysis/`, encoding classification
   unboxed/boxed/ref) is the natural home for the decision; direct codegen
   consumes it.
2. **Non-null params**: under strictNullChecks, non-optional reference
   params lower to `(ref $T)`; callers guarantee, callees drop the null
   blocks. (Coordinate with #1852's per-backend value representation.)
3. Ratchet `extern.convert_any` count on the playground corpus (the #1095
   mechanics) — each removal is measurable.
4. Re-measure Binaryen -O3 effect after: expect cast removal + devirt to
   start firing (compare instruction counts on the review's probe corpus).

## Evidence update (2026-07-27, from #3673/#3683)

Step 4 of the approach above — "re-measure Binaryen -O3 effect after;
expect cast removal + devirt to start firing" — has now been measured
*incrementally*, and it confirms the thesis of this issue:

| tree | Binaryen `-O3` worth |
| --- | --- |
| before #3683 (round 8-era) | ~0 % (flat; measured twice) |
| after #3683 S2 (typed-`this` twins) | ~5 % |
| after #3683 S3 (direct calls between twins) | **7.1 %** |

Each step that removed externref laundering on ONE path (`this.field`
reads, then twin-to-twin calls) handed Binaryen more to work with,
exactly as predicted. The shipped standalone artifact now enables `-O3`
(#3673 round 30): binary 1,808 KB → 1,216 KB, deep-warm parse 0.70 →
0.62 ms.

`#3685` (generic receiver monomorphization) is the natural continuation
on the *typing* side — it proves arbitrary receivers are concrete struct
instances so their reads/calls stop laundering through externref — while
this issue remains the home for the boundary discipline and the non-null
param half.

## Acceptance criteria

- Probe corpus shows GC refs staying typed across locals/calls within the
  module; externref only at allowlisted boundary ops.
- `fixupExternConvertAny` shrinks toward no-op on the corpus (counted).
- Equivalence + test262 green; benchmark delta reported.

## Source

Compiler quality review 2026-06. Related: #1946, #1852, #1916. Needs
`/architect-spec`.
