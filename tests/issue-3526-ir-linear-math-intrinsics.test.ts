// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { type IntrinsicId, PURE_MATH_INTRINSIC_IDS } from "../src/ir/intrinsics.js";
import { irVal, type IrFunction } from "../src/ir/nodes.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-ir-linear-math-intrinsics");
const F64 = irVal({ kind: "f64" });
const LINEAR_BACKEND_OP_INTRINSICS = [
  "math.abs",
  "math.ceil",
  "math.floor",
  "math.sqrt",
  "math.trunc",
] as const satisfies readonly IntrinsicId[];

function intrinsicFunction(id: IntrinsicId): IrFunction {
  const builder = new IrFunctionBuilder(identities.next(id.replace(".", "_")), [F64], true);
  const left = builder.addParam("left", F64);
  const right = builder.addParam("right", F64);
  builder.openBlock();
  const result = builder.emitIntrinsic(id, id === "math.atan2" || id === "math.pow" ? [left, right] : [left]);
  builder.terminate({ kind: "return", values: [result] });
  return builder.finish();
}

describe("#3526 linear semantic Math intrinsic legality", () => {
  it("admits exactly the five semantic intrinsics backed by native linear f64 operations", () => {
    const admitted = PURE_MATH_INTRINSIC_IDS.filter(
      (id) => verifyIrBackendLegality(intrinsicFunction(id), "linear").length === 0,
    );

    expect(admitted).toStrictEqual(LINEAR_BACKEND_OP_INTRINSICS);
  });

  it("rejects every callable-backed Math intrinsic at the linear boundary", () => {
    const callableBacked = PURE_MATH_INTRINSIC_IDS.filter(
      (id) => !LINEAR_BACKEND_OP_INTRINSICS.includes(id as (typeof LINEAR_BACKEND_OP_INTRINSICS)[number]),
    );

    for (const id of callableBacked) {
      expect(verifyIrBackendLegality(intrinsicFunction(id), "linear")).toContainEqual(
        expect.objectContaining({
          instr: "intrinsic",
          message: expect.stringContaining(`does not support semantic intrinsic '${id}'`),
        }),
      );
    }
  });

  it("leaves WasmGC backend legality unchanged for the complete certified family", () => {
    for (const id of PURE_MATH_INTRINSIC_IDS) {
      expect(verifyIrBackendLegality(intrinsicFunction(id), "wasmgc"), id).toStrictEqual([]);
    }
  });
});
