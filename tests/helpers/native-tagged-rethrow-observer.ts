// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../src/wasm/model/instructions.js";
import type { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";

/** Observe the native tag payload without replacing the caught exception. */
export function reserveTaggedRethrowObserver(tx: PhysicalModuleReservations, key: string) {
  const handlerType = tx.internFunctionType([], [{ kind: "externref" }, { kind: "ref", typeIdx: -23 }], key);
  return (body: Instr[], tagIdx: number, payloadGlobal: number, paramCount: number) => ({
    locals: [{ name: "caughtException", type: { kind: "ref_null", typeIdx: -23 } }] as LocalDef[],
    body: [
      {
        op: "block",
        blockType: { kind: "val", type: { kind: "externref" } },
        body: [
          {
            op: "block",
            blockType: { kind: "type", typeIdx: handlerType },
            body: [
              {
                op: "try_table",
                blockType: { kind: "val", type: { kind: "externref" } },
                body: structuredClone(body),
                catches: [{ kind: "catch_ref", tagIdx, depth: 0 }],
              },
              { op: "br", depth: 1 },
            ],
          },
          { op: "local.set", index: paramCount },
          { op: "global.set", index: payloadGlobal },
          { op: "local.get", index: paramCount },
          { op: "ref.as_non_null" },
          { op: "throw_ref" },
        ],
      },
    ] as Instr[],
  });
}
