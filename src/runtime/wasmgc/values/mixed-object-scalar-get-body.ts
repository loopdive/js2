// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { invokerBodyCoordinate } from "./create-list-from-array-like-body.js";

/** Get's 0/1 statuses carry language undefined/value. Other statuses are unsupported
 * families or corrupt links, never a missing property or a language TypeError.
 * This boundary deliberately traps until those object families are implemented.
 */
export function buildMixedObjectScalarGetDefinition(get: FuncHandle): { locals: LocalDef[]; body: Instr[] } {
  invokerBodyCoordinate(get, "get");
  return {
    locals: [{ name: "$value", type: { kind: "externref" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: get },
      { op: "local.set", index: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.gt_u" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "local.get", index: 3 },
    ],
  };
}
