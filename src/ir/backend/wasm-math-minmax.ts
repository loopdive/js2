// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../types.js";

/** Two reusable f64 locals for exact binary Math.min/Math.max expansion. */
export interface WasmMathMinMaxScratch {
  readonly left: number;
  readonly right: number;
}

export type WasmMathMinMaxOperation = "f64.max" | "f64.min";

/**
 * Consume two f64s and leave the exact binary Math.min/Math.max result.
 *
 * Prepared intrinsic arguments arrive as [left, right]. Store both before
 * branching so source-order evaluation is already complete, then explicitly
 * propagate either NaN before relying on Wasm's signed-zero-aware min/max op.
 */
export function emitWasmMathMinMax(
  out: Instr[],
  scratch: WasmMathMinMaxScratch,
  operation: WasmMathMinMaxOperation,
): void {
  out.push(
    { op: "local.set", index: scratch.right },
    { op: "local.set", index: scratch.left },
    { op: "local.get", index: scratch.left },
    { op: "local.get", index: scratch.left },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "local.get", index: scratch.left }],
      else: [
        { op: "local.get", index: scratch.right },
        { op: "local.get", index: scratch.right },
        { op: "f64.ne" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [{ op: "local.get", index: scratch.right }],
          else: [
            { op: "local.get", index: scratch.left },
            { op: "local.get", index: scratch.right },
            { op: operation },
          ],
        },
      ],
    },
  );
}
