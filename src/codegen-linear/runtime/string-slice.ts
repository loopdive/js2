// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../ir/types.js";

/**
 * Normalize a signed bound against an unsigned byte length.
 * Distinct i32 locals; overwrites only magnitude scratch and leaves one i32.
 * Each invocation creates fresh instructions, including nested branches.
 */
export function linearStringSliceBoundInstrs(boundLocal: number, lengthLocal: number, magnitudeLocal: number): Instr[] {
  return [
    { op: "local.get", index: boundLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        // Unsigned magnitude preserves INT_MIN as 0x80000000.
        { op: "i32.const", value: 0 },
        { op: "local.get", index: boundLocal },
        { op: "i32.sub" },
        { op: "local.tee", index: magnitudeLocal },
        { op: "local.get", index: lengthLocal },
        { op: "i32.ge_u" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: 0 }],
          else: [
            { op: "local.get", index: lengthLocal },
            { op: "local.get", index: magnitudeLocal },
            { op: "i32.sub" },
          ],
        },
      ],
      else: [
        { op: "local.get", index: boundLocal },
        { op: "local.get", index: lengthLocal },
        { op: "i32.gt_u" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "local.get", index: lengthLocal }],
          else: [{ op: "local.get", index: boundLocal }],
        },
      ],
    },
  ];
}
