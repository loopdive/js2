// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Early getter arms consume the same one-shot receiver as the ordinary body.
 * Clear the bit before invoking an accessor so nested reads cannot inherit it. */
export function consumeReflectGetReceiver(ctx: CodegenContext, targetLocal = 0): Instr[] {
  const active = ctx.mod.globals.findIndex((global) => global.name === "__reflect_get_receiver_active");
  const receiver = ctx.mod.globals.findIndex((global) => global.name === "__reflect_get_receiver_value");
  if (active < 0 || receiver < 0) throw new Error("Getter arm requires Reflect receiver state");
  return [
    { op: "global.get", index: ctx.numImportGlobals + active },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "i32.const", value: 0 },
        { op: "global.set", index: ctx.numImportGlobals + active },
        { op: "global.get", index: ctx.numImportGlobals + receiver },
      ],
      else: [{ op: "local.get", index: targetLocal }],
    },
  ];
}
