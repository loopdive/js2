// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Vec-property miss only: an own undefined value has already returned.
 * The shared Context owns the prototype and its native method identities. */
export function sharedArrayPrototypeRead(ctx: CodegenContext, receiverLocal = 0): Instr[] {
  const linked = ctx.standaloneGlobalThisImport;
  if (!linked?.arrayPrototype || !linked.get) return [];
  const prototype = ctx.funcMap.get(linked.arrayPrototype);
  const get = ctx.funcMap.get(linked.get);
  const isArray = ctx.funcMap.get("__extern_is_array");
  if (prototype === undefined || get === undefined || isArray === undefined) {
    throw new Error("Shared Array prototype dependencies were not reserved");
  }
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: isArray },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "call", funcIdx: prototype },
        { op: "local.get", index: 1 },
        { op: "local.get", index: receiverLocal },
        { op: "call", funcIdx: get },
        { op: "return" },
      ],
    },
  ];
}
