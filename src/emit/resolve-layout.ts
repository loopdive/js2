// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// ---------------------------------------------------------------------------
// resolveLayout — the single handle→final-index authority (#1916 / #2710).
//
// CONTRACT (the #1899-ratified end state)
// ---------------------------------------
// Instructions and module records reference functions / globals / types through
// stable handles (`FuncHandle` / `GlobalHandle` / `TypeHandle`, src/ir/types.ts).
// A concrete module index is assigned in exactly ONE place — here — and read in
// exactly one phase: serialization (src/emit/binary.ts), the only point that
// sees the FINAL index space (post every late import, post DCE). Nothing
// upstream of emit may interpret a handle as a position.
//
// WHY (the bug class this retires)
// --------------------------------
// The WasmGC backend historically baked *live* indices into instruction streams
// mid-compile; every late import (`addUnionImports`, `addStringImports`,
// `ensureLateImport`) then had to chase the +N shift into every body and ~40
// side-channel caches (`shiftLateImportIndices`, `reconcileNativeStrFinalizeShift`,
// two hand-rolled inline shifters), and DCE's remove-and-renumber had to remap
// them again. At least 7 numbered regressions trace to that design (#618, #1109,
// #1384, #1525b, #1666, #1677, #2191, #2193, #2918…). #1899's implementation
// notes prove the dual lesson that fixes the design:
//   - identity must ride IN the instruction (a handle), because a numeric index
//     is ambiguous across shifts — any idx-keyed repair map is unsound;
//   - the only sound resolution point is AFTER all churn, i.e. emit time.
//
// MIGRATION PHASE — IDENTITY (#2710 slice 2, landed under #1916 S1)
// -----------------------------------------------------------------
// In the current phase handles are still *numerically equal* to live indices
// (the existing shifters keep them current, exactly as before). `resolveLayout`
// is therefore the identity map, and wiring it through `binary.ts` is provably
// byte-identical (see `scripts/prove-emit-identity.mjs`). The value of this
// slice is the SEAM: every serialization of a func/global reference now flows
// through `ModuleLayout`, so the later flip — minting stable, never-renumbered
// handles at registration and computing the real permutation here — changes
// one function instead of fourteen encode sites.
//
// FLIP PRECONDITIONS (do NOT make this non-identity before these hold):
//   1. Every positional read (`mod.functions[idx - numImportFuncs]`,
//      `idx - numImportFuncs` arithmetic, `mod.globals[idx]`) is converted to a
//      registry/layout-keyed lookup (#1916 S2 / #2710 slice 3).
//   2. Registration sites mint handles from a monotonic counter (never reused),
//      and the shifters are deleted in the same change — a body-walking shifter
//      mutating stable handles would corrupt them (#1916 S3 / #2710 slice 4).
//   3. The canonical ordering reproduces today's final layout exactly (imports
//      in declaration order first, then live defined entries in array order
//      post-DCE) so the flip stays byte-identical.
// ---------------------------------------------------------------------------

import type { FuncHandle, GlobalHandle, TypeHandle, WasmModule } from "../ir/types.js";

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

/**
 * Normalize a function handle to the CURRENT absolute function index. The one
 * primitive every mid-compile/mod-only pass (stack-balance, fixups, wat, the
 * func-space chokepoints) uses to interpret a possibly-stable handle. For a
 * live-regime handle this is the identity. For a stable handle it resolves
 * ordinal → position via `mod.funcOrdinalToPosition` and offsets by the
 * CURRENT import count (recomputed from `mod` — never a cached value, since
 * dead-elim removes imports without updating caches).
 * Throws on an unrecorded ordinal: that means a producer minted a handle but
 * never pushed its function — a loud producer bug, never silent wrong code.
 */
export function absoluteFuncIndex(mod: WasmModule, h: FuncHandle): number {
  if (h < STABLE_FUNC_BASE) return h;
  let numImportFuncs = 0;
  for (const imp of mod.imports) if (imp.desc.kind === "func") numImportFuncs++;
  return absoluteFuncIndexCached(mod, numImportFuncs, h);
}

/**
 * `absoluteFuncIndex` with the func-import count precomputed by the caller —
 * for hot loops (emit, stack-balance, fixups) that already maintain the count.
 * The caller's count MUST be derived from the CURRENT `mod.imports` (or, on
 * the codegen-context path, be `ctx.numImportFuncs`, which the add/remove
 * passes keep in lockstep).
 */
export function absoluteFuncIndexCached(mod: WasmModule, numImportFuncs: number, h: FuncHandle): number {
  // (#3009) A baked funcIdx of `undefined` / NaN is NOT a stable-handle producer
  // bug: it is the strict `--no-host-imports` degrade path leaking. `addImport`
  // dropped an `env` host import (pushing a `degrade` diagnostic) but a producer
  // baked the dropped import's now-`undefined` index into a helper body — e.g.
  // console.log's native-string extern bridge `__str_to_extern` calling the
  // dropped `__str_from_mem`/`__str_to_mem`/`__str_extern_len`. Resolving it via
  // the stable-handle path below yields `funcOrdinalToPosition[NaN]` → the opaque
  // "stable handle undefined (ordinal NaN)" crash. Detect it here and throw a
  // clean, actionable leak diagnostic that names the dropped-and-coupled import(s)
  // (recorded on `mod.strictDroppedHostImports`). The `generate*` try/catch
  // prefixes `Codegen error:` and flips `result.success` to false, so the
  // degraded binary is never handed to a consumer.
  if (h === undefined || h === null || Number.isNaN(h as unknown as number)) {
    const dropped = mod.strictDroppedHostImports;
    const coupling =
      dropped && dropped.length > 0
        ? ` Under --no-host-imports / standalone strict mode the strict gate dropped these host import(s), one of which was baked into a compiled helper body rather than degrading cleanly: ${dropped
            .map((d) => `${d.module}.${d.name}`)
            .join(
              ", ",
            )}. This feature has no Wasm-native standalone path yet — provide one, or keep the feature off the strict path (see the preceding host-import degrade diagnostics; #2961/#3009).`
        : ` No dropped host imports were recorded, so this is a codegen producer bug: a call/ref instr was emitted with an undefined function target.`;
    throw new Error(
      `absoluteFuncIndex: unresolved call target (funcIdx=${String(h)}) baked into a compiled function body — the call has no resolvable function index.${coupling}`,
    );
  }
  if (h < STABLE_FUNC_BASE) return h;
  const pos = mod.funcOrdinalToPosition[h - STABLE_FUNC_BASE];
  // undefined = never minted; NaN = minted but never pushed (the
  // `mintDefinedFunc` reservation sentinel). Both are producer bugs that must
  // fail loudly here, never flow into an emitted index.
  if (pos === undefined || Number.isNaN(pos)) {
    throw new Error(`absoluteFuncIndex: stable handle ${h} (ordinal ${h - STABLE_FUNC_BASE}) has no recorded position`);
  }
  return numImportFuncs + pos;
}

/**
 * The resolved final layout of one module's index spaces. `binary.ts` (and,
 * at flip time, `wat.ts` / `object.ts`) dereference every handle through this
 * — never through arithmetic on the handle value.
 */
export interface ModuleLayout {
  /** Final function-index-space position for a function handle. */
  func(h: FuncHandle): number;
  /** Final global-index-space position for a global handle. */
  global(h: GlobalHandle): number;
  /** Final type-index-space position for a type handle. */
  type(h: TypeHandle): number;
}

/**
 * Compute the handle→final-index maps for a module whose registration and
 * churn (late imports, DCE) have fully settled. Called at the top of emit —
 * downstream of `ctx.indexSpaceFrozen = true` in `generateModule`, the point
 * both finalize arms guarantee no further import can be added.
 *
 * Live-regime handles == live indices by construction (the shifters keep them
 * current), so they resolve as the identity. Stable-regime handles resolve
 * through `absoluteFuncIndex`, which at this post-churn point IS the final
 * index (import count settled, positions settled).
 */
export function resolveLayout(mod: WasmModule): ModuleLayout {
  let numImportFuncs = 0;
  for (const imp of mod.imports) if (imp.desc.kind === "func") numImportFuncs++;
  return {
    func: (h: FuncHandle): number => absoluteFuncIndexCached(mod, numImportFuncs, h),
    global: (h: GlobalHandle): number => h,
    type: (h: TypeHandle): number => h,
  };
}
