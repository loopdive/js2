// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { createIrSourceId, createIrUnitId } from "../src/ir/identity.js";
import { irVal, type IrModule, type IrObjectShape, type IrType } from "../src/ir/nodes.js";

const ALLOCATION_POLICY_SOURCE_ID = createIrSourceId({
  kind: "synthetic",
  order: 0,
  sourceKey: "@benchmark/allocation-policy-proof",
});
const allocationPolicyIdentity = (ordinal: number, name: string) => ({
  unitId: createIrUnitId({
    sourceId: ALLOCATION_POLICY_SOURCE_ID,
    lexicalOwnerId: null,
    kind: "synthetic-support",
    ordinal,
  }),
  name,
});

export const ALLOCATION_POLICY_F64: IrType = irVal({ kind: "f64" });
export const ALLOCATION_POLICY_I32: IrType = irVal({ kind: "i32" });
export const ALLOCATION_POLICY_SHAPE: IrObjectShape = {
  fields: [
    { name: "x", type: ALLOCATION_POLICY_F64 },
    { name: "y", type: ALLOCATION_POLICY_F64 },
  ],
};

/** Fixed alias/identity/bounds corpus shared by tests and the measurement run. */
export function buildAllocationPolicyProof(): { readonly module: IrModule; readonly registry: AllocSiteRegistry } {
  const registry = new AllocSiteRegistry();

  const object = new IrFunctionBuilder(
    allocationPolicyIdentity(0, "objectPolicyProof"),
    [ALLOCATION_POLICY_F64],
    true,
    registry,
  );
  const seed = object.addParam("seed", ALLOCATION_POLICY_F64);
  object.openBlock();
  const five = object.emitConst({ kind: "f64", value: 5 }, ALLOCATION_POLICY_F64);
  const first = object.emitObjectNew(ALLOCATION_POLICY_SHAPE, [seed, five]);
  const second = object.emitObjectNew(ALLOCATION_POLICY_SHAPE, [seed, five]);
  const truth = object.emitConst({ kind: "bool", value: true }, ALLOCATION_POLICY_I32);
  const alias = object.emitSelect(truth, first, second, { kind: "object", shape: ALLOCATION_POLICY_SHAPE });
  const nine = object.emitConst({ kind: "f64", value: 9 }, ALLOCATION_POLICY_F64);
  object.emitObjectSet(alias, "x", nine);
  const observed = object.emitObjectGet(first, "x", ALLOCATION_POLICY_F64);
  const sameIdentity = object.emitBinary("i32.eq", first, alias, ALLOCATION_POLICY_I32);
  const distinctIdentity = object.emitBinary("i32.ne", first, second, ALLOCATION_POLICY_I32);
  const sameNumber = object.emitUnary("f64.convert_i32_s", sameIdentity, ALLOCATION_POLICY_F64);
  const distinctNumber = object.emitUnary("f64.convert_i32_s", distinctIdentity, ALLOCATION_POLICY_F64);
  const hundred = object.emitConst({ kind: "f64", value: 100 }, ALLOCATION_POLICY_F64);
  const ten = object.emitConst({ kind: "f64", value: 10 }, ALLOCATION_POLICY_F64);
  const mutationScore = object.emitBinary("f64.mul", observed, hundred, ALLOCATION_POLICY_F64);
  const aliasScore = object.emitBinary("f64.mul", sameNumber, ten, ALLOCATION_POLICY_F64);
  const identityScore = object.emitBinary("f64.add", aliasScore, distinctNumber, ALLOCATION_POLICY_F64);
  const objectResult = object.emitBinary("f64.add", mutationScore, identityScore, ALLOCATION_POLICY_F64);
  object.terminate({ kind: "return", values: [objectResult] });

  const vector = new IrFunctionBuilder(
    allocationPolicyIdentity(1, "vectorPolicyProof"),
    [ALLOCATION_POLICY_F64],
    true,
    registry,
  );
  const index = vector.addParam("index", ALLOCATION_POLICY_I32);
  vector.openBlock();
  const values = [4, 5, 6].map((value) => vector.emitConst({ kind: "f64", value }, ALLOCATION_POLICY_F64));
  const vec = vector.emitVecNewFixed(values, ALLOCATION_POLICY_F64, ALLOCATION_POLICY_I32);
  const one = vector.emitConst({ kind: "i32", value: 1 }, ALLOCATION_POLICY_I32);
  const replacement = vector.emitConst({ kind: "f64", value: 9 }, ALLOCATION_POLICY_F64);
  vector.emitVecSet(vec, one, replacement);
  const length = vector.emitVecLen(vec);
  const lengthI32 = vector.emitUnary("i32.trunc_sat_f64_s", length, ALLOCATION_POLICY_I32);
  const inBounds = vector.emitBinary("i32.lt_u", index, lengthI32, ALLOCATION_POLICY_I32);
  let found!: ReturnType<IrFunctionBuilder["emitVecGet"]>;
  const foundBody = vector.collectBodyInstrs(() => {
    found = vector.emitVecGet(vec, index, ALLOCATION_POLICY_F64);
  });
  let missing!: ReturnType<IrFunctionBuilder["emitConst"]>;
  const missingBody = vector.collectBodyInstrs(() => {
    missing = vector.emitConst({ kind: "f64", value: 0 }, ALLOCATION_POLICY_F64);
  });
  const selected = vector.emitIfElse({
    cond: inBounds,
    then: foundBody,
    thenValue: found,
    else: missingBody,
    elseValue: missing,
    resultType: ALLOCATION_POLICY_F64,
  });
  const vectorHundred = vector.emitConst({ kind: "f64", value: 100 }, ALLOCATION_POLICY_F64);
  const lengthScore = vector.emitBinary("f64.mul", length, vectorHundred, ALLOCATION_POLICY_F64);
  const vectorResult = vector.emitBinary("f64.add", selected, lengthScore, ALLOCATION_POLICY_F64);
  vector.terminate({ kind: "return", values: [vectorResult] });

  return { module: { functions: [object.finish(), vector.finish()] }, registry };
}

export const LINEAR_ALLOCATION_POLICY_SOURCE = `
export function objectPolicyProof(seed: number): number {
  const first = { x: seed, y: seed + 1 };
  const second = { x: seed, y: 5 };
  const alias = first;
  alias.x = alias.x + 2;
  return (first.x - seed) * 450 + second.y + 6;
}
`;
