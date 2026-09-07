// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// ---------------------------------------------------------------------------
// #1916 S3 — the two-regime function handle space.
//
// A FuncHandle value lives in exactly one of two numerically DISJOINT regimes:
//
//   live regime    h < STABLE_FUNC_BASE   h IS the current absolute function
//                                         index; the legacy shifters keep it
//                                         current on every late import.
//   stable regime  h >= STABLE_FUNC_BASE  h = STABLE_FUNC_BASE + ordinal is a
//                                         NEVER-renumbered id minted at
//                                         registration; `mod.funcOrdinalToPosition`
//                                         maps ordinal → position in
//                                         `mod.functions` (recorded at push).
//                                         Shifters and dead-elim's remap skip
//                                         it by construction.
//
// The disjointness is what makes the migration incremental: producers flip to
// stable minting one at a time (each flip byte-identity-provable), while
// unconverted producers keep working exactly as before. This is sound where
// #1899's idx-keyed repair was not, because a number here IS the identity by
// construction — there is never a moment where one value means two functions.
//
// STABLE_FUNC_BASE = 1 << 21: no legitimate live absolute index can reach the
// stable range (largest observed modules: <10k functions), and resolved final
// indices stay far below it (the emit-time `vIdx` bounds-check enforces this).
// ---------------------------------------------------------------------------
export const STABLE_FUNC_BASE = 1 << 21;

/**
 * #1916 S3 — the shift predicate for the LIVE handle regime. A funcIdx is
 * shifted iff it is at/above the insertion point AND below `STABLE_FUNC_BASE`:
 * stable-regime handles are layout-independent ids that NEVER shift —
 * resolution to a concrete index happens once, at emit. Every shifter
 * comparison (`shiftLateImportIndices`, `reconcileNativeStrFinalizeShift`,
 * the inline shifters in codegen/index.ts, the async side-channel walker)
 * must use this predicate, never a bare `>= importsBefore`.
 */
export function inLiveShiftRange(idx: number, importsBefore: number): boolean {
  return idx >= importsBefore && idx < STABLE_FUNC_BASE;
}
