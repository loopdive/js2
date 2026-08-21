// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import {
  asBlockId,
  asValueId,
  irVal,
  type IrFunction,
  type IrInstr,
  type IrLowerResolver,
  type IrType,
} from "../src/ir/index.js";
import { lowerIrFunctionToWasm } from "../src/ir/lower.js";
import type { Instr } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3523-nested-stackification");
const I32: IrType = irVal({ kind: "i32" });
const F64: IrType = irVal({ kind: "f64" });
const EXTERNREF: IrType = irVal({ kind: "externref" });
const STRING: IrType = { kind: "string" };
const EXTERNREF_VAL = { kind: "externref" } as const;

const resolver: IrLowerResolver = {
  resolveFunc: (ref) => (ref.name === "first" ? 7 : ref.name === "second" ? 8 : 9),
  resolveGlobal: () => {
    throw new Error("nested-stackification fixture does not use globals");
  },
  resolveType: () => {
    throw new Error("nested-stackification fixture does not use named types");
  },
  internFuncType: () => 0,
  resolveString: () => EXTERNREF_VAL,
};

function binary(id: number, op: "f64.add" | "f64.mul" | "f64.sub", lhs: number, rhs: number): IrInstr {
  return {
    kind: "binary",
    op,
    lhs: asValueId(lhs),
    rhs: asValueId(rhs),
    result: asValueId(id),
    resultType: F64,
  };
}

function constant(id: number, value: number): IrInstr {
  return {
    kind: "const",
    value: { kind: "f64", value },
    result: asValueId(id),
    resultType: F64,
  };
}

function call(id: number | null, target: "first" | "second", args: number | readonly number[]): IrInstr {
  return {
    kind: "call",
    target: irRuntimeFuncRef(target),
    args: (typeof args === "number" ? [args] : args).map(asValueId),
    result: id === null ? null : asValueId(id),
    resultType: id === null ? null : F64,
  };
}

function conditionalFunction(
  then: readonly IrInstr[],
  thenValue: number,
  elseValue: number,
  valueCount: number,
): IrFunction {
  return {
    ...identities.next("stackify"),
    params: [
      { value: asValueId(0), type: I32, name: "cond" },
      { value: asValueId(1), type: F64, name: "a" },
      { value: asValueId(2), type: F64, name: "b" },
    ],
    resultTypes: [F64],
    exported: true,
    valueCount,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "if",
            cond: asValueId(0),
            then,
            thenValue: asValueId(thenValue),
            else: [constant(elseValue, 0)],
            elseValue: asValueId(elseValue),
            result: asValueId(valueCount - 1),
            resultType: F64,
          },
        ],
        terminator: { kind: "return", values: [asValueId(valueCount - 1)] },
      },
    ],
  };
}

function lowered(fn: IrFunction): { readonly locals: number; readonly body: readonly Instr[] } {
  const result = lowerIrFunctionToWasm(fn, resolver).func;
  return { locals: result.locals.length, body: result.body };
}

function loweredFunction(fn: IrFunction) {
  return lowerIrFunctionToWasm(fn, resolver).func;
}

function thenBody(body: readonly Instr[]): readonly Instr[] {
  const branch = body.find((instruction) => instruction.op === "if");
  if (!branch || branch.op !== "if") throw new Error("fixture did not lower to a Wasm if");
  return branch.then;
}

describe("#3523 generic nested-region stackification", () => {
  it("keeps a pure single-use tree in one nested Wasm stack expression", () => {
    const result = lowered(
      conditionalFunction([binary(3, "f64.add", 1, 2), constant(4, 2), binary(5, "f64.mul", 3, 4)], 5, 6, 8),
    );

    expect(result.locals).toBe(0);
    expect(thenBody(result.body)).toEqual([
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "f64.add" },
      { op: "f64.const", value: 2 },
      { op: "f64.mul" },
    ]);
  });

  it("keeps one effectful result on-stack across pure work to its sole consumer", () => {
    const result = lowered(
      conditionalFunction(
        [call(3, "first", 1), constant(4, 2), binary(5, "f64.add", 1, 4), call(null, "second", [3, 5]), constant(6, 0)],
        6,
        7,
        9,
      ),
    );

    expect(result.locals).toBe(0);
    expect(thenBody(result.body)).toEqual([
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: 7 },
      { op: "local.get", index: 1 },
      { op: "f64.const", value: 2 },
      { op: "f64.add" },
      { op: "call", funcIdx: 8 },
      { op: "f64.const", value: 0 },
    ]);
  });

  it("keeps one effectful result on-stack through a single-use pure consumer chain", () => {
    const result = lowered(
      conditionalFunction(
        [call(3, "first", 1), constant(4, 2), binary(5, "f64.add", 3, 4), call(null, "second", 5), constant(6, 0)],
        6,
        7,
        9,
      ),
    );

    expect(result.locals).toBe(0);
    expect(thenBody(result.body)).toEqual([
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: 7 },
      { op: "f64.const", value: 2 },
      { op: "f64.add" },
      { op: "call", funcIdx: 8 },
      { op: "f64.const", value: 0 },
    ]);
  });

  it("materializes an effectful result when another effect intervenes", () => {
    const result = lowered(
      conditionalFunction(
        [call(3, "first", 1), call(null, "second", 2), call(null, "second", 3), constant(4, 0)],
        4,
        5,
        7,
      ),
    );

    expect(result.locals).toBe(1);
    expect(thenBody(result.body)).toEqual([
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: 7 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: 8 },
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: 8 },
      { op: "f64.const", value: 0 },
    ]);
  });

  it("materializes a multi-use effectful result", () => {
    const result = lowered(conditionalFunction([call(3, "first", 1), binary(4, "f64.add", 3, 3)], 4, 5, 7));

    expect(result.locals).toBe(1);
    expect(thenBody(result.body)).toEqual([
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: 7 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 3 },
      { op: "f64.add" },
    ]);
  });
});

describe("#4577 native-string slot-read stackification", () => {
  it("keeps independent string slot reads on-stack until one in-place consumer", () => {
    const fn: IrFunction = {
      ...identities.next("independentStringSlots"),
      params: [{ value: asValueId(0), type: I32, name: "cond" }],
      resultTypes: [F64],
      exported: true,
      valueCount: 6,
      slots: [
        { index: 0, name: "left", type: EXTERNREF_VAL },
        { index: 1, name: "right", type: EXTERNREF_VAL },
      ],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "if",
              cond: asValueId(0),
              then: [
                { kind: "slot.read", slotIndex: 0, result: asValueId(1), resultType: STRING },
                { kind: "slot.read", slotIndex: 1, result: asValueId(2), resultType: STRING },
                call(null, "second", [1, 2]),
                constant(3, 0),
              ],
              thenValue: asValueId(3),
              else: [constant(4, 0)],
              elseValue: asValueId(4),
              result: asValueId(5),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [asValueId(5)] },
        },
      ],
    };

    const result = loweredFunction(fn);
    expect(result.locals.map(({ name }) => name)).toEqual(["$slot_left", "$slot_right"]);
    expect(thenBody(result.body)).toEqual([
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: 8 },
      { op: "f64.const", value: 0 },
    ]);
  });

  it("keeps a string slot snapshot materialized across a conflicting write", () => {
    const fn: IrFunction = {
      ...identities.next("conflictingStringSlotWrite"),
      params: [
        { value: asValueId(0), type: I32, name: "cond" },
        { value: asValueId(1), type: STRING, name: "replacement" },
      ],
      resultTypes: [F64],
      exported: true,
      valueCount: 6,
      slots: [{ index: 0, name: "value", type: EXTERNREF_VAL }],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "if",
              cond: asValueId(0),
              then: [
                { kind: "slot.read", slotIndex: 0, result: asValueId(2), resultType: STRING },
                { kind: "slot.write", slotIndex: 0, value: asValueId(1), result: null, resultType: null },
                call(null, "second", 2),
                constant(3, 0),
              ],
              thenValue: asValueId(3),
              else: [constant(4, 0)],
              elseValue: asValueId(4),
              result: asValueId(5),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [asValueId(5)] },
        },
      ],
    };

    const result = loweredFunction(fn);
    expect(result.locals.map(({ name }) => name)).toEqual(["$ir2", "$slot_value"]);
    expect(thenBody(result.body)).toEqual([
      { op: "local.get", index: 3 },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 1 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: 8 },
      { op: "f64.const", value: 0 },
    ]);
  });

  it("keeps a string slot snapshot materialized across an intervening call", () => {
    const fn: IrFunction = {
      ...identities.next("stringSlotAcrossCall"),
      params: [{ value: asValueId(0), type: I32, name: "cond" }],
      resultTypes: [F64],
      exported: true,
      valueCount: 5,
      slots: [{ index: 0, name: "value", type: EXTERNREF_VAL }],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "if",
              cond: asValueId(0),
              then: [
                { kind: "slot.read", slotIndex: 0, result: asValueId(1), resultType: STRING },
                call(null, "first", []),
                call(null, "second", 1),
                constant(2, 0),
              ],
              thenValue: asValueId(2),
              else: [constant(3, 0)],
              elseValue: asValueId(3),
              result: asValueId(4),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [asValueId(4)] },
        },
      ],
    };

    const result = loweredFunction(fn);
    expect(result.locals.map(({ name }) => name)).toEqual(["$ir1", "$slot_value"]);
    expect(thenBody(result.body)).toEqual([
      { op: "local.get", index: 2 },
      { op: "local.set", index: 1 },
      { op: "call", funcIdx: 7 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: 8 },
      { op: "f64.const", value: 0 },
    ]);
  });

  it("recognizes a pure string-read chain consumed at the end of an if arm", () => {
    const fn: IrFunction = {
      ...identities.next("stringArmCarrier"),
      params: [{ value: asValueId(0), type: I32, name: "cond" }],
      resultTypes: [EXTERNREF],
      exported: true,
      valueCount: 5,
      slots: [{ index: 0, name: "value", type: EXTERNREF_VAL }],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "if",
              cond: asValueId(0),
              then: [
                { kind: "slot.read", slotIndex: 0, result: asValueId(1), resultType: STRING },
                {
                  kind: "coerce.to_externref",
                  value: asValueId(1),
                  result: asValueId(2),
                  resultType: EXTERNREF,
                },
              ],
              thenValue: asValueId(2),
              else: [
                {
                  kind: "const",
                  value: { kind: "null", ty: EXTERNREF },
                  result: asValueId(3),
                  resultType: EXTERNREF,
                },
              ],
              elseValue: asValueId(3),
              result: asValueId(4),
              resultType: EXTERNREF,
            },
          ],
          terminator: { kind: "return", values: [asValueId(4)] },
        },
      ],
    };

    const result = loweredFunction(fn);
    expect(result.locals.map(({ name }) => name)).toEqual(["$slot_value"]);
    expect(thenBody(result.body)).toEqual([{ op: "local.get", index: 1 }]);
  });
});
