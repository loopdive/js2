// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  type IrConst,
  type IrFunction,
  type IrInstr,
  type IrInstrBinary,
  asBlockId,
  asValueId,
} from "../src/ir/core/nodes.js";
import { irVal } from "../src/ir/core/types.js";
import { constantFold } from "../src/ir/passes/constant-fold.js";
import { deadCode } from "../src/ir/passes/dead-code.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("6920-logical-index-constant-fold");
const I32 = irVal({ kind: "i32" });
const F64 = irVal({ kind: "f64" });
const v = asValueId;
function literal(result: number, value: IrConst): IrInstr {
  return {
    kind: "const",
    result: v(result),
    resultType: value.kind === "f64" ? F64 : I32,
    value,
  };
}
function comparison(result = 3): IrInstrBinary {
  return {
    kind: "binary",
    op: "i32.lt_u",
    lhs: v(0),
    rhs: v(1),
    result: v(result),
    resultType: I32,
  };
}
function and(result = 4, lhs = 2, rhs = 3): IrInstr {
  return {
    kind: "binary",
    op: "i32.and",
    lhs: v(lhs),
    rhs: v(rhs),
    result: v(result),
    resultType: I32,
  };
}
function fn(instrs: readonly IrInstr[], result = 4): IrFunction {
  return {
    ...identities.next("run"),
    params: [
      { value: v(0), type: I32, name: "left" },
      { value: v(1), type: I32, name: "right" },
    ],
    resultTypes: [instrs.find((instr) => instr.result === v(result))?.resultType ?? I32],
    exported: true,
    valueCount: 30,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [v(result)] },
      },
    ],
  };
}
const last = (value: IrFunction) => value.blocks[0]!.instrs.at(-1)!;

describe("6920 finite logical-index optimizer dependency", () => {
  it.each([0, 1, -1, -2147483648, 2147483647, 0x80000000, 0xffffffff])(
    "folds signed i32 conversion using actual Wasm bits %s",
    (bits) => {
      const convert: IrInstr = {
        kind: "unary",
        op: "f64.convert_i32_s",
        rand: v(2),
        result: v(4),
        resultType: F64,
      };
      const folded = last(constantFold(fn([literal(2, { kind: "i32", value: bits }), convert])));
      expect(folded).toMatchObject({
        kind: "const",
        result: v(4),
        resultType: F64,
        value: { kind: "f64", value: bits | 0 },
      });
    },
  );

  it.each<IrConst>([
    { kind: "f64", value: 1 },
    { kind: "bool", value: true },
  ])("does not fold wrong input constant kind $kind", (value) => {
    const convert: IrInstr = {
      kind: "unary",
      op: "f64.convert_i32_s",
      rand: v(2),
      result: v(4),
      resultType: F64,
    };
    expect(last(constantFold(fn([literal(2, value), convert])))).toBe(convert);
  });

  it("preserves a dynamic conversion and reference identity", () => {
    const convert: IrInstr = {
      kind: "unary",
      op: "f64.convert_i32_s",
      rand: v(0),
      result: v(4),
      resultType: F64,
    };
    const input = fn([convert]);
    expect(constantFold(input)).toBe(input);
  });

  it.each([false, true])("folds zero AND arbitrary integer in either operand order (%s)", (reverse) => {
    const folded = last(
      constantFold(fn([literal(2, { kind: "bool", value: false }), and(4, reverse ? 0 : 2, reverse ? 2 : 0)])),
    );
    expect(folded).toMatchObject({
      kind: "const",
      value: { kind: "i32", value: 0 },
      result: v(4),
    });
  });

  it.each([false, true])("reproduces only a known comparison at the AND result (%s)", (reverse) => {
    const folded = constantFold(
      fn([literal(2, { kind: "bool", value: true }), comparison(), and(4, reverse ? 3 : 2, reverse ? 2 : 3)]),
    );
    expect(last(folded)).toMatchObject({
      kind: "binary",
      op: "i32.lt_u",
      lhs: v(0),
      rhs: v(1),
      result: v(4),
      resultType: I32,
    });
    const live = deadCode(folded);
    expect(live.blocks[0]!.instrs).toHaveLength(1);
    expect(last(live)).toMatchObject({
      kind: "binary",
      op: "i32.lt_u",
      result: v(4),
    });
  });

  it("does not classify a non-comparison binary or a wrong result carrier as boolean", () => {
    for (const definition of [
      { ...comparison(), op: "i32.add" as const },
      { ...comparison(), resultType: F64 },
    ]) {
      const operation = and();
      expect(last(constantFold(fn([literal(2, { kind: "i32", value: 1 }), definition, operation])))).toBe(operation);
    }
  });

  it("does not alias one AND an arbitrary integer", () => {
    const operation = and(4, 2, 0);
    expect(last(constantFold(fn([literal(2, { kind: "i32", value: 1 }), operation])))).toBe(operation);
  });

  it("does not launder a known f64 operand through zero AND", () => {
    const operation = and(4, 2, 0);
    const input = fn([literal(2, { kind: "i32", value: 0 }), operation]);
    const wrongParameter = { ...input, params: [{ ...input.params[0]!, type: F64 }, input.params[1]!] };
    expect(last(constantFold(wrongParameter))).toBe(operation);
    const wrongConstant = and(4, 2, 3);
    expect(
      last(
        constantFold(fn([literal(2, { kind: "i32", value: 0 }), literal(3, { kind: "f64", value: 9 }), wrongConstant])),
      ),
    ).toBe(wrongConstant);
    const dynamic: IrInstr = { kind: "unary", op: "f64.convert_i32_s", rand: v(0), result: v(3), resultType: F64 };
    expect(last(constantFold(fn([literal(2, { kind: "i32", value: 0 }), dynamic, wrongConstant])))).toBe(wrongConstant);
  });

  it("does not treat a wrong-kind zero as an i32 annihilator", () => {
    const operation = and(4, 2, 0);
    expect(last(constantFold(fn([literal(2, { kind: "f64", value: 0 }), operation])))).toBe(operation);
  });

  it("inherits a dominating comparison into nested buffers", () => {
    const branch: IrInstr = {
      kind: "if",
      cond: v(0),
      then: [and(4)],
      thenValue: v(4),
      else: [],
      elseValue: v(0),
      result: v(5),
      resultType: I32,
    };
    const folded = last(constantFold(fn([literal(2, { kind: "i32", value: 1 }), comparison(), branch], 5)));
    expect(folded.kind).toBe("if");
    if (folded.kind !== "if") throw new Error("missing branch");
    expect(folded.then[0]).toMatchObject({
      kind: "binary",
      op: "i32.lt_u",
      result: v(4),
    });
  });

  it("does not leak a nested comparison to a sibling or following instruction", () => {
    const sibling = and(6);
    const following = and(7);
    const branch: IrInstr = {
      kind: "if",
      cond: v(0),
      then: [comparison()],
      thenValue: v(3),
      else: [sibling],
      elseValue: v(6),
      result: v(5),
      resultType: I32,
    };
    const folded = constantFold(fn([literal(2, { kind: "i32", value: 1 }), branch, following], 7));
    const got = folded.blocks[0]!.instrs[1]!;
    if (got.kind !== "if") throw new Error("missing branch");
    expect(got.else[0]).toBe(sibling);
    expect(last(folded)).toBe(following);
  });

  it("keeps nested i32 operand definitions out of siblings and following code", () => {
    const sibling = and(6, 2, 3);
    const following = and(7, 2, 3);
    const branch: IrInstr = {
      kind: "if",
      cond: v(0),
      then: [comparison()],
      thenValue: v(3),
      else: [sibling],
      elseValue: v(6),
      result: v(5),
      resultType: I32,
    };
    const folded = constantFold(fn([literal(2, { kind: "i32", value: 0 }), branch, following], 7));
    const got = folded.blocks[0]!.instrs[1]!;
    if (got.kind !== "if") throw new Error("missing branch");
    expect(got.else[0]).toBe(sibling);
    expect(last(folded)).toBe(following);
  });

  it("recognizes actual i32 block arguments without inheriting other block definitions", () => {
    const operation = and(4, 2, 3);
    const input = fn([literal(2, { kind: "i32", value: 0 }), operation]);
    const block = { ...input.blocks[0]!, blockArgs: [v(3)], blockArgTypes: [I32] };
    expect(last(constantFold({ ...input, blocks: [block] }))).toMatchObject({
      kind: "const",
      value: { kind: "i32", value: 0 },
    });
  });

  it("does not use a later or different-block comparison as a dominating definition", () => {
    const operation = and();
    expect(
      constantFold(fn([literal(2, { kind: "i32", value: 1 }), operation, comparison()])).blocks[0]!.instrs[1],
    ).toBe(operation);
    const input = fn([literal(2, { kind: "i32", value: 1 }), comparison()]);
    const multiBlock: IrFunction = {
      ...input,
      blocks: [
        ...input.blocks,
        {
          id: asBlockId(1),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [operation],
          terminator: { kind: "return", values: [v(4)] },
        },
      ],
    };
    expect(constantFold(multiBlock).blocks[1]!.instrs[0]).toBe(operation);
  });
});
