---
id: 3578
title: "Relocate ref→f64 ToPrimitive dispatch into coercion-engine.ts (lazy-registry) + Stage C #2108 seal"
status: ready
sprint: current
model: opus
created: 2026-07-24
priority: medium
feasibility: hard
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: correctness
horizon: xl
depends_on: [1917]
---
# #3578 — Relocate ref→f64 ToPrimitive dispatch to the coercion engine (#1917 Stage B/C remainder)

The last refinement of #1917 (one coercion engine). #1917's core landed long ago
(single `coercionPlan` ValType table + 4-site delegation + the
`coercion-engine.ts` `emitToString`/`emitToNumber`/`emitToBoolean`/`emitStrictEq`/
`emitLooseEq` engine + the #2108 drift gate). #1917 Stage A (PR #3562) banked the
`guardedRefCastInstrs` dedup (−106 lines, byte-neutral). This issue owns the one
remaining structural piece: getting the ~440-line ref→f64 ToNumber/ToPrimitive
dispatch OUT of the `coerceType` god-file and INTO the #2108-sanctioned
`coercion-engine.ts`, then flipping the #2108 seal (Stage C).

## Why this is its own (XL, high-risk) issue — the measured Stage B finding (sdev-1917, 2026-07-24)

The byte-neutral EXTRACTION of the block is proven feasible: I lifted
`coerceType`'s inline ref→f64 dispatch (lines ~2333–2772) into a dedicated
`emitRefToNumberPrimitive(ctx, fctx, from, to, toPrimitiveHint)` and verified
**0 Wasm-byte-SHA diffs across 62 both-lane binaries** (example corpus + 12
ToPrimitive exercisers: valueOf / @@toPrimitive / class valueOf / nested valueOf /
obj→NaN / toString-fallback / relational / two-operand / wrapper), all 24 snippet
outputs byte-identical on gc+standalone, tsc clean. So the *logic* moves cleanly.

But a **same-file** extraction is structurally self-defeating and must NOT land:
1. **LOC ratchet (#3102) FAILS**: a module-local wrapper GROWS `type-coercion.ts`
   by ~+34 (signature/doc/brace overhead) even though `coerceType` shrinks
   ~1440→~1000 lines. Granting a `loc-budget-allow` to GROW the very god-file
   #1917 exists to shrink is contradictory.
2. **#2108 count unchanged**: the coercion vocabulary stays in the file.

The value only materializes by moving the dispatch OUT into `coercion-engine.ts`
(drains ~440–630 LOC from the god-file AND advances the seal). That relocation is
blocked by a **bidirectional module-init cycle**: `coercion-engine.ts` already
`import { coerceType, tryStructToString } from "./type-coercion.js"` (line ~53);
the reverse import needed for the move is the exact TDZ hazard the
`type-coercion.ts` line-~2660 comment and #3324 (boolToStringEmitter TDZ) avoid.

## Implementation plan

1. **Break the cycle with the lazy-emitter-registry pattern that already exists**
   in `coercion-engine.ts` (~line 691 — the string helpers `emitBoolToString` /
   `emitNativeStringRefFromExternref` are bound by `string-ops.ts` at module load
   via `registerStringHelperEmitters` precisely to avoid this cycle). Model the
   ToPrimitive relocation on it: define the dispatch in `coercion-engine.ts`; have
   `type-coercion.ts` register the few things it must call back (or move those too
   — see 2).
2. **Relocate the dispatch + its 4 non-exported helper deps** into
   `coercion-engine.ts`: `emitRefToNumberPrimitive` (~440 lines), plus
   `emitToPrimitiveHostCall` (~10), `toPrimitiveHostCallInstrs` (~25),
   `tryToStringFallback` (~190), `pushStringHint` (~10). Lazily bind / import what
   THEY need back from `type-coercion.ts` — note `coercion-engine.ts` already has
   `coerceType` + `tryStructToString`; `pushDefaultValue` is exported.
   Watch the `ctx.__insideValueOfCoercion` re-entrancy flag (#1989) and the
   `ctx.currentThisGlobalIdx` shift discipline (#2078/#2679) — both live inside the
   moved block; do not cache shiftable indices across sub-compilation.
3. **Make `coerceType` a thin façade** delegating the ref→f64 arm to the engine
   (do NOT touch coerceType's ~100 callers — architect report 03 §6).
4. **Stage C — seal the #2108 gate** for the drained tokens: ratchet
   `coercion-sites-baseline.json` down (`pnpm run check:coercion-sites --
   --update-on-decrease`) and, per §5.2, tighten the gate from "growth fails" to
   "any nonzero count outside the engine fails" for the now-migrated tokens.

## Gating (mandatory — this is the single riskiest coercion path)

- both-lane (gc host + standalone) Wasm-byte-SHA diff over `playground/examples/`
  + the ToPrimitive exercisers = 0 diffs (harness recipe in #1917's Stage B notes);
- full equivalence suite + a host test262 slice as the regression floor;
- `tsc --noEmit`, prettier, `check:ir-fallbacks`, LOC ratchet (must now go DOWN),
  #2108 ratchet (must go DOWN);
- broad merge_group validation (standalone floor watch — this touches the
  `Cannot convert object to primitive` bucket, #2503/#2160);
- **report the measured baseline+delta before landing** (per the #1917 discipline);
  a byte-diff is only acceptable if justified as the intended NaN-vs-unbox
  provenance policy moving into the engine — never absorb an unexplained flip.

## Notes carried from #1917

- **Criterion #2 is SUPERSEDED/ratified, NOT in scope here.** The ref→f64 split —
  bare GC object-ref ToNumber → NaN (§7.1.4) vs a ref carrying a boxed number →
  unbox — is deliberate provenance-dependent policy. Do NOT equalize those rows.
- A local `emitRefToNumberPrimitive` proof-of-feasibility extraction was validated
  byte-neutral but intentionally NOT landed (LOC-ratchet trap above). The relocation
  here supersedes it.
