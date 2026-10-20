// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle } from "../../../wasm/model/instructions.js";
import { buildBuiltinFunctionArgument, type BuiltinFunctionDefinition } from "./builtin-function-bodies.js";

export type NativeObjectToObjectOperation = "get-prototype" | "value-of" | "prototype-getter";
/** Fixed catalog Call ABI, not public-source admission or an ownership capability. */
export function buildNativeObjectToObjectDefinition(d: {
  readonly operation: NativeObjectToObjectOperation;
  readonly vectorTypeIdx: number;
  readonly vectorArrayTypeIdx: number;
  readonly undefinedGlobal: number;
  readonly toObject: FuncHandle;
  readonly getPrototypeOf: FuncHandle;
}): BuiltinFunctionDefinition {
  const input =
    d.operation === "get-prototype" ? buildBuiltinFunctionArgument(d, 1, 0) : [{ op: "local.get" as const, index: 0 }];
  const wrapping = [...input, { op: "call" as const, funcIdx: d.toObject }];
  if (d.operation === "value-of") return { locals: [], body: wrapping };
  return {
    locals: [
      { name: "prototype", type: { kind: "externref" } },
      { name: "status", type: { kind: "i32" } },
    ],
    body: [
      ...wrapping,
      { op: "call", funcIdx: d.getPrototypeOf },
      { op: "local.set", index: 2 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.ne" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "local.get", index: 2 },
    ],
  };
}
