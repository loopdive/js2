// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import type { IrVecLowering, LinearVecLowering } from "../src/ir/backend/handles.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { wasmValueTypeConverter } from "../src/ir/backend/wasm-lowering.js";
import { lowerIrFunctionBody, lowerIrTypeToValType } from "../src/ir/lower-generic.js";
import { asBlockId, asValueId, irVal, irVec, type IrFunction } from "../src/ir/nodes.js";
import { planLinearScalarVectorLayout } from "../src/shared/contracts/linear-memory-layout.js";
import { irSupportTypeRef } from "../src/ir/core/type-references.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-6920-vector-carrier");
const f64 = irVal({ kind: "f64" });
const vector = irVec(f64, false);
const gc: IrVecLowering = {
  vecStructTypeIdx: 7,
  arrayTypeIdx: 4,
  lengthFieldIdx: 0,
  dataFieldIdx: 1,
  elementValType: { kind: "f64" },
};
const linear: LinearVecLowering = {
  elementValType: { kind: "f64" },
  linearMemory: {
    layout: planLinearScalarVectorLayout("f64"),
    allocate: { family: "vector", operation: "allocate", allocationClass: "arena", elementStorage: "f64" },
    initializeElement: {
      family: "vector",
      operation: "initialize-element",
      allocationClass: "arena",
      elementStorage: "f64",
    },
  },
};
function resolver(
  representation: "linear" | "wasmgc",
  handle: IrVecLowering | LinearVecLowering | null,
): IrLowerResolver {
  return {
    vectorRepresentation: representation,
    resolveFunc: () => 0,
    resolveGlobal: () => 0,
    resolveType: () => 0,
    internFuncType: () => 0,
    resolveVecForElement: () => handle,
  };
}
function fixture(): IrFunction {
  return {
    ...identities.next("fixed"),
    params: [],
    resultTypes: [vector],
    exported: false,
    valueCount: 3,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          { kind: "const", result: asValueId(0), resultType: f64, value: { kind: "f64", value: 1.5 } },
          { kind: "const", result: asValueId(1), resultType: f64, value: { kind: "f64", value: -2.25 } },
          {
            kind: "vec.new_fixed",
            result: asValueId(2),
            resultType: vector,
            elementType: f64,
            elements: [asValueId(0), asValueId(1)],
          },
        ],
        terminator: { kind: "return", values: [asValueId(2)] },
      },
    ],
  };
}

describe("vector representation lowering — unit boundary, not source admission", () => {
  it("uses a genuine i32 carrier and scratch with no fabricated GC indices or local repair", () => {
    expect("arrayTypeIdx" in linear).toBe(false);
    expect("vecStructTypeIdx" in linear).toBe(false);
    const r = resolver("linear", linear);
    expect(lowerIrTypeToValType(vector, r, "fixed")).toEqual({ kind: "i32" });
    const fn = fixture();
    const emitter = new LinearEmitter({
      resolveRuntimeOperation: (op) => (op.family === "vector" && op.operation === "allocate" ? 3 : 5),
    });
    const lowered = lowerIrFunctionBody(fn, r, emitter, wasmValueTypeConverter("linear", r, fn.name));
    expect(lowered.results.flat()).toEqual([{ kind: "i32" }]);
    const scratch = lowered.locals.filter((local) => local.name.startsWith("$linear_vec_ptr_"));
    expect(scratch).toHaveLength(1);
    expect(scratch[0].slots).toEqual([{ kind: "i32" }]);
    expect(lowered.locals.flatMap((local) => local.slots).every((type) => type.kind !== "ref_null")).toBe(true);
    const calls = lowered.body.filter((instruction) => instruction.op === "call");
    expect(calls).toEqual([
      { op: "call", funcIdx: 3 },
      { op: "call", funcIdx: 5 },
      { op: "call", funcIdx: 5 },
    ]);
    const length = lowered.body.findIndex((instruction) => instruction.op === "i32.store" && instruction.offset === 8);
    let lastInit = -1;
    lowered.body.forEach((instruction, index) => {
      if (instruction.op === "call" && instruction.funcIdx === 5) lastInit = index;
    });
    expect(length).toBeGreaterThan(lastInit);
    expect(lowered.body[length - 1]).toEqual({ op: "i32.const", value: 2 });
  });
  it("retains GC reference carrier, array scratch and exact construction operation order", () => {
    const r = resolver("wasmgc", gc);
    expect(lowerIrTypeToValType(vector, r, "fixed")).toEqual({ kind: "ref", typeIdx: 7 });
    const fn = fixture();
    const lowered = lowerIrFunctionBody(fn, r, new WasmGcEmitter(r), wasmValueTypeConverter("wasmgc", r, fn.name));
    const scratch = lowered.locals.find((local) => local.name === "$vec_data_4");
    expect(scratch?.slots).toEqual([{ kind: "ref_null", typeIdx: 4 }]);
    expect(lowered.body.filter((op) => ["array.new_fixed", "struct.new"].includes(op.op))).toEqual([
      { op: "array.new_fixed", typeIdx: 4, length: 2 },
      { op: "struct.new", typeIdx: 7 },
    ]);
  });
  it("refuses missing and cross-backend vector handles rather than defaulting to i32 or GC", () => {
    expect(() => lowerIrTypeToValType(vector, resolver("linear", null), "fixed")).toThrow("cannot lower vec");
    expect(() => lowerIrTypeToValType(vector, resolver("linear", gc), "fixed")).toThrow(
      "Linear vector resolver returned a WasmGC handle",
    );
    expect(() => lowerIrTypeToValType(vector, resolver("wasmgc", linear), "fixed")).toThrow(
      "WasmGC vector resolver returned a Linear handle",
    );
  });
  it("rejects persisted GC type-layout authority before resolving slots on native Linear", () => {
    const owner = fixture().unitId;
    const persisted = {
      kind: "vec" as const,
      elementType: f64,
      nullable: false,
      layout: {
        carrierType: irSupportTypeRef(owner, "carrier", "vec"),
        dataType: irSupportTypeRef(owner, "data", "array"),
        lengthFieldIndex: 0,
        dataFieldIndex: 1,
      },
    };
    const r = resolver("linear", linear);
    r.resolveType = () => {
      throw new Error("foreign slot lookup must not occur");
    };
    expect(() => lowerIrTypeToValType(persisted, r, "fixed")).toThrow(
      "persisted WasmGC vector layout cannot enter Linear lowering",
    );
  });
});
