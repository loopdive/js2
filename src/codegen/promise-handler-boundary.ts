// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../wasm/model/instructions.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** Guarded host access to persistent Wasm-owned Promise handler state.
 * -1 means a foreign/non-Promise value, never an unproven false result.
 */
export function exportPromiseHandlerBoundary(
  ctx: CodegenContext,
  promiseTypeIdx: number,
  markRejectedIdx: number,
): void {
  for (const mark of [false, true]) {
    const name = mark ? "__promise_boundary_mark_handled" : "__promise_boundary_has_handler";
    const index = mintDefinedFunc(ctx);
    const receiver = (): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: promiseTypeIdx },
    ];
    const native: Instr[] = mark
      ? [
          ...receiver(),
          { op: "i32.const", value: 1 },
          { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 4 },
          ...(markRejectedIdx >= 0 ? [...receiver(), { op: "call", funcIdx: markRejectedIdx } as Instr] : []),
          { op: "i32.const", value: 1 },
        ]
      : [...receiver(), { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 4 }];
    pushDefinedFunc(ctx, index, {
      name,
      typeIdx: addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], `$${name}_type`),
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: promiseTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: native,
          else: [{ op: "i32.const", value: -1 }],
        },
      ],
      exported: true,
    });
    ctx.mod.exports.push({ name, desc: { kind: "func", index } });
  }
}
