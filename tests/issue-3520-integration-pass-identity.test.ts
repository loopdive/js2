// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  asBlockId,
  asValueId,
  irImportFuncRef,
  irIntrinsicFuncRef,
  irRuntimeFuncRef,
  irSupportFuncRef,
  irUnitFuncRef,
  irVal,
  type IrFuncRef,
  type IrFunction,
  type IrInstr,
} from "../src/ir/index.js";
import { findReferencedWithdrawnIrUnit } from "../src/ir/integration.js";
import { runTaggedUnions } from "../src/ir/passes/tagged-unions.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const I32 = irVal({ kind: "i32" });
const F64 = irVal({ kind: "f64" });

function call(target: IrFuncRef): IrInstr {
  return { kind: "call", target, args: [], result: null, resultType: null };
}

function functionWith(name: string, instrs: readonly IrInstr[], sourceKey: string): IrFunction {
  const identities = createTestIrFunctionIdentityFactory(sourceKey);
  return {
    ...identities.next(name),
    params: [{ value: asValueId(0), type: I32, name: "condition" }],
    resultTypes: [],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [] },
      },
    ],
    exported: false,
    valueCount: 1,
  };
}

function invalidTaggedUnionFunction(identity: ReturnType<typeof createTestIrFunctionIdentityFactory>): IrFunction {
  return {
    ...identity.next("shared"),
    params: [{ value: asValueId(0), type: F64, name: "value" }],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "box",
            value: asValueId(0),
            toType: F64,
            result: asValueId(1),
            resultType: F64,
          },
        ],
        terminator: { kind: "return", values: [asValueId(1)] },
      },
    ],
    exported: false,
    valueCount: 2,
  };
}

describe("#3520 integration pass identity", () => {
  it("attributes same-labelled tagged-union failures to exact function units", () => {
    const identities = createTestIrFunctionIdentityFactory("issue-3520-integration-tagged-unions");
    const first = invalidTaggedUnionFunction(identities);
    const second = invalidTaggedUnionFunction(identities);

    const { errors } = runTaggedUnions({ functions: [first, second] });

    expect(errors).toHaveLength(2);
    expect(errors.map(({ unitId, func }) => ({ unitId, func }))).toEqual([
      { unitId: first.unitId, func: "shared" },
      { unitId: second.unitId, func: "shared" },
    ]);
  });

  it("withdraws nested exact-unit references without matching duplicate labels or provider lookalikes", () => {
    const identities = createTestIrFunctionIdentityFactory("issue-3520-integration-withdrawal");
    const withdrawn = identities.next("shared");
    const sameLabelPeer = identities.next("shared");
    const withdrawnIds = new Set([withdrawn.unitId]);
    const exactRelabelled = irUnitFuncRef({ ...withdrawn, name: "debug-alias" });
    const exactNested = functionWith(
      "exact-caller",
      [
        {
          kind: "if.stmt",
          cond: asValueId(0),
          then: [call(exactRelabelled)],
          else: [],
          result: null,
          resultType: null,
        },
      ],
      "issue-3520-integration-exact-caller",
    );
    const lookalikes = functionWith(
      "lookalike-caller",
      [
        call(irUnitFuncRef(sameLabelPeer)),
        call(irImportFuncRef("env", "shared", "shared")),
        call(irRuntimeFuncRef("shared", "shared")),
        call(irIntrinsicFuncRef("shared", "shared")),
        call(irSupportFuncRef(withdrawn.unitId, "adapter", "shared")),
      ],
      "issue-3520-integration-lookalike-caller",
    );

    expect(findReferencedWithdrawnIrUnit(exactNested, withdrawnIds)).toEqual({
      unitId: withdrawn.unitId,
      name: "debug-alias",
    });
    expect(findReferencedWithdrawnIrUnit(lookalikes, withdrawnIds)).toBeUndefined();
  });
});
