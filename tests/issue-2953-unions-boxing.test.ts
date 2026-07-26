// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import type { BackendEmitter } from "../src/ir/backend/emitter.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import {
  asBlockId,
  asValueId,
  irVal,
  lowerIrFunctionToWasm,
  type IrFunction,
  type IrLowerResolver,
  type IrType,
  type IrUnionLowering,
} from "../src/ir/index.js";
import type { Instr, ValType } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-2953-unions-boxing");

const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });
const UNION: IrType = { kind: "union", members: [F64, I32] };
const UNION_TAG_F64 = 17;

const unionLayout: IrUnionLowering = {
  typeIdx: 23,
  tagFieldIdx: 0,
  valFieldIdx: 1,
  tagFor(member: ValType): number {
    if (member.kind === "f64") return UNION_TAG_F64;
    if (member.kind === "i32") return 29;
    throw new Error(`unexpected union member: ${member.kind}`);
  },
};

const resolver: IrLowerResolver = {
  resolveFunc: () => 0,
  resolveGlobal: () => 0,
  resolveType: () => 0,
  internFuncType: () => 0,
  resolveUnion: () => unionLayout,
};

function lowerSingleInstr(
  paramType: IrType,
  resultType: IrType,
  instr: IrFunction["blocks"][number]["instrs"][number],
  emitter?: BackendEmitter<Instr[]>,
): Instr[] {
  const result = asValueId(1);
  const fn: IrFunction = {
    ...irIdentities.next("unionOp"),
    params: [{ value: asValueId(0), type: paramType, name: "value" }],
    resultTypes: [resultType],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [instr],
        terminator: { kind: "return", values: [result] },
      },
    ],
    exported: false,
    valueCount: 2,
  };

  return lowerIrFunctionToWasm(fn, resolver, emitter).func.body;
}

describe("#2953 union lowering WasmGC byte identity", () => {
  it("boxes in tag-field/value-field order", () => {
    const body = lowerSingleInstr(F64, UNION, {
      kind: "box",
      value: asValueId(0),
      toType: UNION,
      result: asValueId(1),
      resultType: UNION,
    });

    expect(body).toEqual([
      { op: "i32.const", value: UNION_TAG_F64 },
      { op: "local.get", index: 0 },
      { op: "struct.new", typeIdx: unionLayout.typeIdx },
      { op: "return" },
    ]);
  });

  it("unboxes from the canonical value field", () => {
    const body = lowerSingleInstr(UNION, F64, {
      kind: "unbox",
      value: asValueId(0),
      tag: { kind: "f64" },
      result: asValueId(1),
      resultType: F64,
    });

    expect(body).toEqual([
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: unionLayout.typeIdx, fieldIdx: unionLayout.valFieldIdx },
      { op: "return" },
    ]);
  });

  it("loads and compares the canonical tag", () => {
    const body = lowerSingleInstr(UNION, I32, {
      kind: "tag.test",
      value: asValueId(0),
      tag: { kind: "f64" },
      result: asValueId(1),
      resultType: I32,
    });

    expect(body).toEqual([
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: unionLayout.typeIdx, fieldIdx: unionLayout.tagFieldIdx },
      { op: "i32.const", value: UNION_TAG_F64 },
      { op: "i32.eq" },
      { op: "return" },
    ]);
  });

  it("lets the backend honor a non-canonical field order without changing tag encoding", () => {
    const reverseLayout: IrUnionLowering = {
      ...unionLayout,
      tagFieldIdx: 1,
      valFieldIdx: 0,
    };
    const out: Instr[] = [];

    new WasmGcEmitter().emitBox(reverseLayout, { kind: "f64" }, [{ op: "local.get", index: 0 }], out);

    expect(out).toEqual([
      { op: "local.get", index: 0 },
      { op: "i32.const", value: UNION_TAG_F64 },
      { op: "struct.new", typeIdx: unionLayout.typeIdx },
    ]);
  });

  it("rejects union boxing loudly on a backend without a union representation", () => {
    expect(() =>
      lowerSingleInstr(
        F64,
        UNION,
        {
          kind: "box",
          value: asValueId(0),
          toType: UNION,
          result: asValueId(1),
          resultType: UNION,
        },
        new LinearEmitter(),
      ),
    ).toThrow(/linear backend legality failed.*box/);
  });
});
