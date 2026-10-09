// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { planLinearVectorLayout } from "../../ir/analysis/linear-memory-plan.js";
import { irVal } from "../../ir/nodes.js";
import type { Instr } from "../../ir/types.js";

const layout = planLinearVectorLayout(irVal({ kind: "f64" }));
const baseBytes = layout.elementsOffset;
const strideBytes = layout.elementStride;
if (layout.elementStorage !== "f64" || baseBytes !== 16 || strideBytes !== 8) {
  throw new Error("Linear array allocation requires the canonical f64 layout with offset 16 and stride 8.");
}
const maximumCapacity = Math.floor((0xffffffff - baseBytes) / strideBytes);
const maximumCapacityBeforeDoubling = Math.floor(maximumCapacity / 2);

function capacityBoundGuard(capacityLocal: number, maximum: number): Instr[] {
  return [
    { op: "local.get", index: capacityLocal },
    { op: "i32.const", value: maximum },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "unreachable" }],
      else: [],
    },
  ];
}

/** Empty stack in; one exact wasm32 byte request out, or a pre-allocation trap. */
export function checkedArrayAllocationSize(capacityLocal: number): Instr[] {
  return [
    ...capacityBoundGuard(capacityLocal, maximumCapacity),
    { op: "i32.const", value: baseBytes },
    { op: "local.get", index: capacityLocal },
    { op: "i32.const", value: strideBytes },
    { op: "i32.mul" },
    { op: "i32.add" },
  ];
}

/** Empty stack in/out; update the scratch capacity only after checking its double. */
export function checkedArrayCapacityDoubling(capacityLocal: number): Instr[] {
  return [
    ...capacityBoundGuard(capacityLocal, maximumCapacityBeforeDoubling),
    { op: "local.get", index: capacityLocal },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.set", index: capacityLocal },
  ];
}
