// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irDynamic, type IrType, type IrTypeRef } from "../src/ir/nodes.js";
import {
  preparedInstructionSupport,
  type PreparedDynamicInstructionSupportEvidence,
} from "../src/ir/prepared-instruction-support.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("6979-identity-box");
function fixture() {
  const identity = identities.next("box");
  const operandType: IrType = { kind: "extern", className: "api.Date" };
  const builder = new IrFunctionBuilder(identity, [irDynamic()]);
  const value = builder.addParam("value", operandType);
  builder.openBlock();
  const result = builder.emitBox(value, irDynamic());
  builder.terminate({ kind: "return", values: [result] });
  const fn = builder.finish();
  const box = fn.blocks[0]!.instrs[0]!;
  // This unit test exercises matching, not ABI binding validation. Integration
  // tests separately require a genuinely sealed component and zero AST bodies.
  const dynamicCarrierRef = {} as IrTypeRef;
  const support: PreparedDynamicInstructionSupportEvidence = { dynamicCarrierRef, instructionCallables: new Map() };
  const types = new Map([[value, operandType]]);
  const observe = (instruction = box, owner = identity.unitId) =>
    preparedInstructionSupport(instruction, owner, types, undefined, {
      dynamicInstructionSupport: new Map([[identity.unitId, support]]),
    }).hasPreparedSupport;
  return { box, operandType, support, types, observe };
}

describe("#6979 explicit empty boxing support", () => {
  it("never treats a missing or empty callable list as identity evidence", () => {
    const f = fixture();
    expect(f.observe()).toBe(false);
    (f.support.instructionCallables as Map<typeof f.box, readonly never[]>).set(f.box, []);
    expect(f.observe()).toBe(false);
  });

  it("accepts only the exact instruction, operand type object and externref carrier", () => {
    const f = fixture();
    const evidence = { operandType: f.operandType, carrier: { kind: "externref" as const } };
    Object.assign(f.support, { identityBoxes: new Map([[f.box, evidence]]) });
    expect(f.observe()).toBe(true);
    expect(f.observe({ ...f.box })).toBe(false);
    f.types.set((f.box as Extract<typeof f.box, { kind: "box" }>).value, { ...f.operandType });
    expect(f.observe()).toBe(false);
  });

  it("rejects a non-externref carrier even with an exact instruction match", () => {
    const f = fixture();
    Object.assign(f.support, {
      identityBoxes: new Map([[f.box, { operandType: f.operandType, carrier: { kind: "f64" } }]]),
    });
    expect(f.observe()).toBe(false);
  });
});
