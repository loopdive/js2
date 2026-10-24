// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef, FuncHandle } from "../../../wasm/model/instructions.js";

/** Returns (IsCallable(then), then); primitive resolutions never perform Get. */
export function buildCommonPromiseThenLookup(
  get: FuncHandle,
  isPrimitive: FuncHandle,
  isCallable: FuncHandle,
  undefinedValue: FuncHandle,
  thenKey: readonly Instr[],
): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [{ name: "then", type: { kind: "externref" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isPrimitive },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "call", funcIdx: undefinedValue }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      ...thenKey,
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: get },
      { op: "local.tee", index: 1 },
      { op: "call", funcIdx: isCallable },
      { op: "local.get", index: 1 },
    ],
  };
}
