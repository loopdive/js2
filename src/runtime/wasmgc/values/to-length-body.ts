// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { invokerBodyCoordinate } from "./create-list-from-array-like-body.js";

/** ToLength: one observable ToNumber, then pure clamping without integer narrowing. */
export function buildToLengthDefinition(toNumber: FuncHandle): { locals: LocalDef[]; body: Instr[] } {
  invokerBodyCoordinate(toNumber, "toNumber");
  return {
    locals: [{ name: "$number", type: { kind: "f64" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: toNumber },
      { op: "local.tee", index: 1 },
      { op: "f64.const", value: 0 },
      { op: "f64.gt" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [
          { op: "local.get", index: 1 },
          { op: "f64.trunc" },
          { op: "f64.const", value: 9007199254740991 },
          { op: "f64.min" },
        ],
        else: [{ op: "f64.const", value: 0 }],
      },
    ],
  };
}
