// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * ES5.1 §15.4.4.20 / ES2024 §23.1.3.7 element-access discipline for the typed
 * `arr.filter(cb)` vec loop.
 *
 * The dense WasmGC kernel that `compileArrayFilter` emits caches `data` and
 * `length` once and reads `data[i]` with a raw `array.get`. Three spec clauses
 * the cache breaks:
 *
 *  1. **`len` is captured once** (step 3) but **`HasProperty(O, Pk)` is
 *     re-evaluated per index** (step 5.b). A callback that shrinks `.length`
 *     makes every trailing index ABSENT, so those indices must be skipped —
 *     `15.4.4.20-9-4`.
 *  2. **`Get(O, Pk)` runs fresh, immediately before the callback** (step
 *     5.b.i). A callback that reallocates the backing (a push / an OOB index
 *     write) must be observed by later iterations.
 *  3. An index whose property is an **accessor** installed by
 *     `Object.defineProperty(arr, "2", { get })` lives in the #3251 vec-overlay
 *     companion, not in the backing array — the raw `array.get` cannot see it,
 *     and `arr.length` may legitimately exceed the physical backing
 *     (`15.4.4.20-9-c-i-10/12/14`).
 *
 * Two builders live here:
 *
 * - {@link liveDensePresence} — always applied. Refreshes `data` from the
 *   receiver vec and yields the LIVE presence predicate
 *   `i < vec.length && i < array.len(data)`. For an unmutated array this is
 *   exactly the condition the cached loop bound already guaranteed, so the
 *   observable result is unchanged; only a length/backing mutation performed by
 *   the callback changes the answer — which is the point.
 * - {@link overlayFilterAccess} — applied only under the #4159 route gate
 *   (`--target standalone` + the `vecAccessorDescriptorDirty` pre-scan flag,
 *   clear for approximately every real program). Swaps raw backing access for
 *   the overlay-aware chokepoints `__extern_has_idx` / `__extern_get_idx`, the
 *   same pair the dynamic lane already uses, so the typed and dynamic lanes
 *   agree on accessor indices.
 */

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { overlayRouteActive } from "./typed-lane-overlay-route.js";

/** The subset of the HOF loop locals these builders need. */
export interface FilterLoopView {
  vecTmp: number;
  dataTmp: number;
  logicalLenTmp: number;
  iTmp: number;
  getOp: "array.get_u" | "array.get_s" | "array.get";
}

/**
 * Refresh `data` from the receiver vec and leave the live presence predicate on
 * the stack. Stack: `[] → [i32]`.
 */
function liveDensePresence(loop: FilterLoopView, vecTypeIdx: number): Instr[] {
  return [
    // data = vec.data — a callback that grew the array replaced the backing.
    { op: "local.get", index: loop.vecTmp },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: loop.dataTmp },
    // present = i < vec.length && i < array.len(data)
    { op: "local.get", index: loop.vecTmp },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: loop.iTmp },
    { op: "i32.gt_s" },
    { op: "local.get", index: loop.dataTmp },
    { op: "array.len" },
    { op: "local.get", index: loop.iTmp },
    { op: "i32.gt_s" },
    { op: "i32.and" },
  ];
}

/** Overlay-routed element access for one filter loop. */
export interface OverlayFilterAccess {
  /** `[] → [i32]`: 1 iff `HasProperty(O, ToString(i))`. */
  hasIdx: Instr[];
  /** `[] → []`: stores the fresh `Get(O, ToString(i))` into the element local. */
  loadElem: Instr[];
}

/**
 * Build the overlay-aware per-index access pair, or `null` when the route is
 * inactive / a chokepoint is unavailable / the element representation cannot
 * round-trip through `externref`. `null` means NOTHING was emitted and the
 * caller keeps its dense lowering.
 *
 * Emits a receiver-to-`externref` snapshot into `fctx.body`, so it must be
 * called while the caller still owns `fctx.body` (before the loop body is
 * assembled).
 */
export function overlayFilterAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  loop: FilterLoopView,
  elemType: ValType,
  elemLocal: number,
): OverlayFilterAccess | null {
  if (!overlayRouteActive(ctx)) return null;
  if (elemType.kind !== "f64" && elemType.kind !== "externref") return null;
  // (#2001) A module with array-literal elisions keeps the `$Hole` dense route:
  // `__extern_has_idx`'s vec arm answers on `i < length` alone, so it would
  // report a `$Hole` slot as PRESENT and leak the sentinel through
  // `__extern_get_idx`. Holes and accessor descriptors together are rare; the
  // dense route is the conservative answer for that intersection.
  if (ctx.usesArrayHoles && elemType.kind === "externref") return null;

  const hasIdxFn = ensureLateImport(
    ctx,
    "__extern_has_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "i32" }],
  );
  const getIdxFn = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  const unboxFn =
    elemType.kind === "f64" ? ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]) : 0;
  flushLateImportShifts(ctx, fctx);
  if (hasIdxFn === undefined || getIdxFn === undefined || unboxFn === undefined) return null;

  const recvLocal = allocLocal(fctx, `__arr_flt_ovr_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.get", index: loop.vecTmp });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  const idxArg: Instr[] = [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: loop.iTmp },
    { op: "f64.convert_i32_s" },
  ];
  return {
    hasIdx: [...idxArg, { op: "call", funcIdx: hasIdxFn }],
    loadElem: [
      ...idxArg,
      { op: "call", funcIdx: getIdxFn },
      ...(elemType.kind === "f64" ? ([{ op: "call", funcIdx: unboxFn }] satisfies Instr[]) : []),
      { op: "local.set", index: elemLocal },
    ],
  };
}

/**
 * Gate `inner` (which must leave exactly one `i32` and contain no `br` targeting
 * the enclosing loop/block — filter's body satisfies both) on an already-built
 * presence predicate. Absent indices yield flag `0`, so the caller's `if`
 * neither runs the callback nor appends to the result.
 */
function gateOnPresenceFlag(presence: Instr[], inner: Instr[]): Instr[] {
  return [
    ...presence,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: inner,
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/**
 * The whole per-iteration "is index k selected?" stage of `compileArrayFilter`:
 * the captured-`len` exit branch (§23.1.3.7 step 3 — `len` is read ONCE) plus
 * the live per-index presence gate (step 5.b) wrapped around a fresh element
 * read (step 5.b.i) and the caller's callback+truthiness sequence.
 *
 * `withDenseElem` receives the dense `elem = data[i]` load and returns the full
 * dense inner sequence (so the caller keeps ownership of its `$Hole` gate);
 * under the overlay route the dense load is replaced wholesale and
 * `withDenseElem` is not consulted — the overlay's `hasIdx` already answers
 * HasProperty for holes, accessors and beyond-backing indices alike.
 *
 * Stack: `[] → [i32]` (the "selected" flag), with a `br_if 1` escape on
 * loop exhaustion.
 */
export function filterSelectStage(
  loop: FilterLoopView,
  vecTypeIdx: number,
  arrTypeIdx: number,
  boundTmp: number,
  elemLocal: number,
  overlay: OverlayFilterAccess | null,
  callAndCheck: Instr[],
  holeGate: (inner: Instr[]) => Instr[],
): Instr[] {
  const exit: Instr[] = [
    { op: "local.get", index: loop.iTmp },
    { op: "local.get", index: boundTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
  ];
  // The overlay's `hasIdx` already answers HasProperty for absent, accessor and
  // beyond-backing indices, so the caller's `$Hole` gate — which would re-read
  // `data[i]` and OOB-trap past the physical backing — is deliberately skipped.
  if (overlay) {
    return [...exit, ...gateOnPresenceFlag(overlay.hasIdx, [...overlay.loadElem, ...callAndCheck])];
  }
  const denseElem: Instr[] = [
    { op: "local.get", index: loop.dataTmp },
    { op: "local.get", index: loop.iTmp },
    { op: loop.getOp, typeIdx: arrTypeIdx },
    { op: "local.set", index: elemLocal },
  ];
  return [
    ...exit,
    ...gateOnPresenceFlag(liveDensePresence(loop, vecTypeIdx), [...denseElem, ...holeGate(callAndCheck)]),
  ];
}
