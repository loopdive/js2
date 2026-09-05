// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Build the sparse-hole guard used by the vector descriptor reader. */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { holeTestInstrs } from "./array-holes.js";
import { f64HoleTestInstrs } from "./vec-f64-hole-presence.js";
import type { OverlayCarrier } from "./vec-overlay-carriers.js";

/**
 * Return a fresh `__vec_gopd` miss arm for every active sparse carrier.
 *
 * The f64 and externref representations use different marker tests.  A
 * descriptor in the overlay wins over either marker because an accessor can
 * intentionally leave the physical slot untouched while creating an own
 * property.
 */
export function buildVecGopdHoleBail(
  ctx: CodegenContext,
  carriers: readonly OverlayCarrier[],
  inheritedSetHolePresenceActive: boolean,
  bailMiss: () => Instr[],
): Instr[] {
  const f64HolePresenceActive = ctx.f64HoleMarkerEmitted === true;
  if (!inheritedSetHolePresenceActive && !f64HolePresenceActive) return [];
  const arms: Instr[] = [];
  for (const carrier of carriers) {
    const f64Carrier = carrier.kind === "f64";
    if (!f64Carrier && carrier.kind !== "externref") continue;
    if (f64Carrier && !f64HolePresenceActive) continue;
    if (!f64Carrier && !inheritedSetHolePresenceActive) continue;
    arms.push(
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: carrier.vecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: carrier.vecTypeIdx },
          { op: "struct.get", typeIdx: carrier.vecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 4 },
          { op: "array.get", typeIdx: carrier.arrTypeIdx },
          ...(f64Carrier ? f64HoleTestInstrs() : holeTestInstrs(ctx)),
          { op: "if", blockType: { kind: "empty" }, then: bailMiss() },
        ],
      },
    );
  }
  return arms;
}
