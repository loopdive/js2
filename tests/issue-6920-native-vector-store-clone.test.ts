// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { asBlockId, asValueId, type IrFunction } from "../src/ir/core/nodes.js";
import { irVal } from "../src/ir/core/types.js";
import { irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { monomorphize } from "../src/ir/passes/monomorphize.js";
import { verifyIrFunction } from "../src/ir/runtime/verify.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

it("preserves fresh slot declarations in a genuine loop specialization with an unused polymorphic parameter", () => {
  const identities = createTestIrFunctionIdentityFactory("monomorphize-loop-slots"),
    id = asValueId;
  const I32 = irVal({ kind: "i32" }),
    F64 = irVal({ kind: "f64" });
  const callee: IrFunction = {
    ...identities.next("count"),
    params: [{ value: id(0), name: "unused", type: F64 }],
    resultTypes: [I32],
    slots: [{ index: 0, name: "counter", type: { kind: "i32" } }],
    exported: false,
    valueCount: 9,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          { kind: "const", value: { kind: "i32", value: 0 }, result: id(1), resultType: I32 },
          { kind: "slot.write", slotIndex: 0, value: id(1), result: null, resultType: null },
          {
            kind: "while.loop",
            result: null,
            resultType: null,
            cond: [
              { kind: "slot.read", slotIndex: 0, result: id(2), resultType: I32 },
              { kind: "const", value: { kind: "i32", value: 3 }, result: id(3), resultType: I32 },
              { kind: "binary", op: "i32.lt_s", lhs: id(2), rhs: id(3), result: id(4), resultType: I32 },
            ],
            condValue: id(4),
            body: [
              { kind: "slot.read", slotIndex: 0, result: id(5), resultType: I32 },
              { kind: "const", value: { kind: "i32", value: 1 }, result: id(6), resultType: I32 },
              { kind: "binary", op: "i32.add", lhs: id(5), rhs: id(6), result: id(7), resultType: I32 },
              { kind: "slot.write", slotIndex: 0, value: id(7), result: null, resultType: null },
            ],
          },
          { kind: "slot.read", slotIndex: 0, result: id(8), resultType: I32 },
        ],
        terminator: { kind: "return", values: [id(8)] },
      },
    ],
  };
  function caller(integer: boolean): IrFunction {
    return {
      ...identities.next(integer ? "integerCaller" : "numberCaller"),
      params: [],
      resultTypes: [I32],
      exported: false,
      valueCount: 2,
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "const",
              value: integer ? { kind: "i32", value: 1 } : { kind: "f64", value: 1 },
              result: id(0),
              resultType: integer ? I32 : F64,
            },
            { kind: "call", target: irUnitFuncRef(callee), args: [id(0)], result: id(1), resultType: I32 },
          ],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
    };
  }
  const beforeSlots = structuredClone(callee.slots);
  expect(verifyIrFunction(callee)).toEqual([]);
  const result = monomorphize({ functions: [callee, caller(false), caller(true)] });
  expect(result.cloneOrigins.size).toBe(1);
  const clone = result.module.functions.find((fn) => result.cloneOrigins.has(fn.unitId));
  expect(clone).toBeDefined();
  expect(clone!.slots).toEqual(beforeSlots);
  expect(clone!.slots).not.toBe(callee.slots);
  expect(clone!.slots![0]).not.toBe(callee.slots![0]);
  expect(callee.slots).toEqual(beforeSlots);
  expect(verifyIrFunction(clone!)).toEqual([]);
});
