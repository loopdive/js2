// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Lazy materialization of a mutable capture's ref cell.
 *
 * Boxing a mutable capture is TWO events that the closure builders emit in two
 * different places: the `struct.new` that FILLS the cell goes to the closure's
 * construction site, while `fctx.localMap.set(name, boxLocal)` re-aims the
 * NAME for the whole rest of the function. When the construction site sits in
 * one arm of an `if` (or any block a path can skip), those two events stop
 * agreeing: every later read/write of the name addresses a cell that the
 * skipping path never created. The access sites already null-guard the cell —
 * but they read the guard as "the value is absent", so a write silently
 * no-ops and a read yields the value type's default (`null` / `NaN`).
 *
 * A null cell does not mean the value is absent. It means the cell was never
 * minted, so the binding's storage is still the ORPHANED pre-box slot the cell
 * would have been minted from. Repairing from that slot at first touch is what
 * makes the nullable cell a sound representation, and it holds regardless of
 * which arm the construction site landed in, which arm order the compiler
 * happened to walk, or what the capture's value type is:
 *
 *   the cell, once minted, is the binding's storage; until then the pre-box
 *   slot is, and the cell is seeded from it on first use.
 *
 * That invariant is why this is not another entry in
 * `canBoxBindingInDominatingParent`'s list of provably-safe eager-box sources.
 * The eager box establishes dominance by MOVING the `struct.new` to a point
 * that dominates the region — which it can only do when it can prove the
 * binding already holds its correct value there AND that no already-emitted
 * code in the region writes the raw slot behind the cell's back. Both proofs
 * fail for ordinary shapes (an uninitialized `let`, a sibling arm that assigns
 * before the closure-bearing arm), and neither proof is needed here: writes
 * emitted before the cell existed went to the pre-box slot, which is exactly
 * what the repair reads.
 *
 * This is the value-cell twin of `pushBoxedTdzFlagRef` (capture-source-slot.ts)
 * and of `pushCaptureCell` (arrow-phases.ts) — both already repair a
 * conditionally-created cell, but only where one closure hands the cell to
 * another. The frame's own reads and writes needed it just as much.
 */
import type { FunctionContext } from "../context/types.js";
import { getLocalType } from "../context/locals.js";
import { valTypesMatch } from "../shared.js";

/**
 * Emit `if (box == null) box = struct.new(rawSlot)` for a boxed capture, so
 * the cell is live before the caller's own null-guarded `struct.get`/
 * `struct.set` runs. Stack-neutral; a no-op unless the frame recorded a
 * pre-box slot for `name` (see `FunctionContext.boxedCaptures.rawLocalIdx`).
 */
export function emitConditionalCaptureBoxRepair(fctx: FunctionContext, name: string, boxLocalIdx: number): void {
  const boxed = fctx.boxedCaptures?.get(name);
  const rawLocalIdx = boxed?.rawLocalIdx;
  if (boxed === undefined || rawLocalIdx === undefined || rawLocalIdx === boxLocalIdx) return;
  // Only a NULLABLE cell local can be unmaterialized. A `(ref $cell)` local was
  // filled in a dominating position and is live on every path already.
  const boxType = getLocalType(fctx, boxLocalIdx);
  if (boxType?.kind !== "ref_null" || boxType.typeIdx !== boxed.refCellTypeIdx) return;
  // The recorded slot must still BE the pre-box binding: block-scope shadowing
  // can retire a slot, and seeding a cell from an unrelated local is worse than
  // the default the caller's guard would have produced.
  const rawType = getLocalType(fctx, rawLocalIdx);
  if (rawType === undefined || !valTypesMatch(rawType, boxed.valType)) return;
  fctx.body.push({ op: "local.get", index: boxLocalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: rawLocalIdx },
      { op: "struct.new", typeIdx: boxed.refCellTypeIdx },
      { op: "local.set", index: boxLocalIdx },
    ],
  });
}
