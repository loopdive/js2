// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { StubEmitter } from "../src/ir/backend/contract-conformance.js";
import { legalityFor } from "../src/ir/backend/contract.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { PorfforTypeConverter } from "../src/ir/backend/porffor/type-converter.js";
import {
  asBlockId,
  asValueId,
  irVal,
  lowerIrFunctionBody,
  verifyIrFunction,
  type IrFunction,
  type IrInstr,
  type IrLowerResolver,
} from "../src/ir/index.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-3288");

const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });
const U32 = { kind: "val", val: { kind: "i32" }, signed: false } as const;
const U64 = { kind: "val", val: { kind: "i64" }, signed: false } as const;

function resolver(onIntern = (): void => {}): IrLowerResolver {
  return {
    resolveFunc: () => 0,
    resolveGlobal: () => 0,
    resolveType: () => 0,
    internFuncType: () => {
      onIntern();
      return 0;
    },
  };
}

function oneBlock(name: string, instrs: readonly IrInstr[], results = [F64]): IrFunction {
  const last = instrs.at(-1);
  return {
    ...irIdentities.next(name),
    params: [],
    resultTypes: results,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: {
          kind: "return",
          values: last?.result === null || last?.result === undefined ? [] : [last.result],
        },
      },
    ],
    exported: false,
    valueCount: instrs.length + 1,
  };
}

describe("#3288 P1 backend-neutral lowering metadata", () => {
  it("returns named Porffor slots without interning a Wasm function type", () => {
    const fn: IrFunction = {
      ...irIdentities.next("porfforSlots"),
      params: [
        { value: asValueId(0), type: F64, name: "left" },
        { value: asValueId(1), type: F64, name: "right" },
      ],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "binary",
              op: "f64.add",
              lhs: asValueId(0),
              rhs: asValueId(1),
              result: asValueId(2),
              resultType: F64,
            },
            {
              kind: "binary",
              op: "f64.mul",
              lhs: asValueId(2),
              rhs: asValueId(2),
              result: asValueId(3),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [asValueId(3)] },
        },
      ],
      exported: true,
      valueCount: 4,
    };
    let internCalls = 0;

    const lowered = lowerIrFunctionBody(
      fn,
      resolver(() => internCalls++),
      new StubEmitter("porffor"),
      new PorfforTypeConverter(),
    );

    expect(lowered.params).toEqual([
      { name: "left", slots: ["f64"] },
      { name: "right", slots: ["f64"] },
    ]);
    expect(lowered.locals).toEqual([{ name: "$ir2", slots: ["f64"] }]);
    expect(lowered.results).toEqual([["f64"]]);
    expect(lowered).not.toHaveProperty("typeIdx");
    expect(internCalls).toBe(0);
  });

  it("converts only the scalar value representations admitted by Porffor P1", () => {
    const types = new PorfforTypeConverter();
    expect(types.convertType(F64)).toEqual(["f64"]);
    expect(types.convertType(I32)).toEqual(["i32"]);
    expect(types.convertType(U32)).toEqual(["u32"]);
    expect(types.convertType(irVal({ kind: "i64" }))).toEqual(["i64"]);
    expect(types.convertType(U64)).toEqual(["u64"]);
    expect(() => types.convertType({ kind: "string" })).toThrow(/porffor backend does not support IR type 'string'/);
  });

  it.each([
    ["u32", U32, { kind: "i32", value: 1 }],
    ["u64", U64, { kind: "i64", value: 1n }],
  ] as const)("preserves %s signedness when an SSA value is materialized as a local", (slot, type, value) => {
    const fn: IrFunction = {
      ...irIdentities.next(`${slot}Local`),
      params: [{ value: asValueId(0), type: I32, name: "condition" }],
      resultTypes: [type],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "const",
              value,
              result: asValueId(1),
              resultType: type,
            },
            {
              kind: "select",
              condition: asValueId(0),
              whenTrue: asValueId(1),
              whenFalse: asValueId(1),
              result: asValueId(2),
              resultType: type,
            },
          ],
          terminator: { kind: "return", values: [asValueId(2)] },
        },
      ],
      exported: false,
      valueCount: 3,
    };

    const lowered = lowerIrFunctionBody(fn, resolver(), new StubEmitter("porffor"), new PorfforTypeConverter());

    expect(verifyIrFunction(fn)).toEqual([]);
    expect(lowered.params).toEqual([{ name: "condition", slots: ["i32"] }]);
    expect(lowered.locals).toEqual([{ name: "$ir1", slots: [slot] }]);
    expect(lowered.results).toEqual([[slot]]);
  });

  it("requires the emitter and TypeConverter to identify the same backend", () => {
    const fn = oneBlock("mismatch", [
      { kind: "const", value: { kind: "f64", value: 1 }, result: asValueId(1), resultType: F64 },
    ]);
    const mismatchedTypes = { backend: "bytecode" as const, convertType: () => ["number"] as const };
    expect(() => lowerIrFunctionBody(fn, resolver(), new StubEmitter("porffor"), mismatchedTypes)).toThrow(
      /backend contract mismatch.*emitter=porffor, type-converter=bytecode/,
    );
  });
});

describe("#3288 P1 Porffor legality", () => {
  it("registers Porffor as the fourth fail-loud legality profile", () => {
    expect(legalityFor("porffor").backend).toBe("porffor");
    const scalar = oneBlock("scalar", [
      { kind: "const", value: { kind: "f64", value: 1 }, result: asValueId(1), resultType: F64 },
    ]);
    expect(verifyIrBackendLegality(scalar, "porffor")).toEqual([]);
  });

  it("keeps rejecting the raw Wasm escape family before emission", () => {
    const instr: IrInstr = {
      kind: "raw.wasm",
      ops: [{ op: "i32.const", value: 1 }],
      stackDelta: 1,
      result: asValueId(1),
      resultType: I32,
    };
    const fn = oneBlock("unsupported", [instr], []);
    const errors = verifyIrBackendLegality(fn, "porffor");
    expect(
      errors.some((error) => /porffor backend does not support IR instruction 'raw\.wasm'/.test(error.message)),
    ).toBe(true);
    expect(() => lowerIrFunctionBody(fn, resolver(), new StubEmitter("porffor"), new PorfforTypeConverter())).toThrow(
      /porffor backend legality failed/,
    );
  });

  it("admits composite JS bitwise lowering through typed emitter operations", () => {
    const binary: IrInstr = {
      kind: "binary",
      op: "js.bitand",
      lhs: asValueId(0),
      rhs: asValueId(1),
      result: asValueId(2),
      resultType: F64,
    };
    const fn: IrFunction = {
      ...oneBlock("bitwise", [binary]),
      params: [
        { value: asValueId(0), type: F64, name: "left" },
        { value: asValueId(1), type: F64, name: "right" },
      ],
      valueCount: 3,
    };
    expect(verifyIrBackendLegality(fn, "porffor")).toEqual([]);

    const lowered = lowerIrFunctionBody(fn, resolver(), new StubEmitter("porffor"), new PorfforTypeConverter());
    expect(lowered.body).toEqual(
      expect.arrayContaining([
        "unary:f64.trunc",
        "scalar.const:f64:4294967296",
        "numeric.convert:i32.trunc_sat_f64_u",
        "i32.bitwise:i32.and",
        "numeric.convert:f64.convert_i32_s",
      ]),
    );
    expect(lowered.body.some((op) => op.startsWith("raw:"))).toBe(false);
  });
});
