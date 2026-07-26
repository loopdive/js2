// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import {
  asBlockId,
  asValueId,
  createDerivedIrUnitId,
  irImportFuncRef,
  irIntrinsicFuncRef,
  irRuntimeFuncRef,
  irSupportFuncRef,
  irUnitFuncRef,
  irVal,
  type IrFuncRef,
  type IrFunction,
  type IrInstr,
  type IrType,
  type IrUnitId,
  type IrValueId,
} from "../src/ir/index.js";
import { monomorphize } from "../src/ir/passes/monomorphize.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3520-monomorphize");
const F64 = irVal({ kind: "f64" });
const F32 = irVal({ kind: "f32" });
const I32 = irVal({ kind: "i32" });
const EXTERNREF = irVal({ kind: "externref" });

function id(value: number): IrValueId {
  return asValueId(value);
}

function makeIdentity(name: string): IrFunction {
  return {
    ...identities.next(name),
    params: [{ value: id(0), type: F64, name: "value" }],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [],
        terminator: { kind: "return", values: [id(0)] },
      },
    ],
    exported: false,
    valueCount: 1,
  };
}

function makeCaller(name: string, target: IrFuncRef, argType: IrType): IrFunction {
  return {
    ...identities.next(name),
    params: [{ value: id(0), type: argType, name: "value" }],
    resultTypes: [argType],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [{ kind: "call", target, args: [id(0)], result: id(1), resultType: argType }],
        terminator: { kind: "return", values: [id(1)] },
      },
    ],
    exported: false,
    valueCount: 2,
  };
}

function firstCall(fn: IrFunction): Extract<IrInstr, { kind: "call" }> {
  const call = fn.blocks[0]!.instrs.find((instr): instr is Extract<IrInstr, { kind: "call" }> => instr.kind === "call");
  expect(call).toBeDefined();
  return call!;
}

function unitTarget(call: Extract<IrInstr, { kind: "call" }>): IrUnitId {
  expect(call.target.binding.kind).toBe("unit");
  return (call.target.binding as { readonly kind: "unit"; readonly unitId: IrUnitId }).unitId;
}

describe("#3520 — monomorphization structural identity", () => {
  it("groups and edits exact units despite duplicate labels and provider lookalikes", () => {
    const first = makeIdentity("shared");
    const second = makeIdentity("shared");
    const firstExternCaller = makeCaller("caller", irUnitFuncRef(first), EXTERNREF);
    const firstNumberCaller = makeCaller("caller", irUnitFuncRef(first), F64);
    const secondCaller = makeCaller("caller", irUnitFuncRef(second), F64);
    const importCaller = makeCaller("caller", irImportFuncRef("env", "shared", "shared"), I32);
    const runtimeCaller = makeCaller("caller", irRuntimeFuncRef("shared", "shared"), F32);
    const intrinsicCaller = makeCaller("caller", irIntrinsicFuncRef("shared", "shared"), EXTERNREF);
    const supportCaller = makeCaller("caller", irSupportFuncRef(first.unitId, "shared-provider", "shared"), F64);

    const result = monomorphize({
      functions: [
        first,
        second,
        firstExternCaller,
        firstNumberCaller,
        secondCaller,
        importCaller,
        runtimeCaller,
        intrinsicCaller,
        supportCaller,
      ],
    });

    expect(result.cloneSignatures.size).toBe(1);
    expect(result.cloneOrigins.size).toBe(1);
    expect(result.cloneUnitProvenance.size).toBe(1);
    const [cloneUnitId, signature] = [...result.cloneSignatures.entries()][0]!;
    expect(result.cloneOrigins.get(cloneUnitId)).toBe(first.unitId);
    expect(result.cloneUnitProvenance.get(cloneUnitId)).toEqual({
      id: cloneUnitId,
      parentId: first.unitId,
      role: "monomorphization-clone",
      ordinal: 0,
    });
    expect(cloneUnitId).toBe(
      createDerivedIrUnitId({
        parentId: first.unitId,
        role: "monomorphization-clone",
        ordinal: 0,
      }),
    );

    const firstTargets = new Set([
      unitTarget(firstCall(result.module.functions[2]!)),
      unitTarget(firstCall(result.module.functions[3]!)),
    ]);
    expect(firstTargets).toEqual(new Set([first.unitId, cloneUnitId]));
    expect(unitTarget(firstCall(result.module.functions[4]!))).toBe(second.unitId);
    expect(firstCall(result.module.functions[5]!).target.binding).toEqual({
      kind: "import",
      module: "env",
      field: "shared",
    });
    expect(firstCall(result.module.functions[6]!).target.binding).toEqual({
      kind: "runtime",
      symbol: "shared",
    });
    expect(firstCall(result.module.functions[7]!).target.binding).toEqual({
      kind: "intrinsic",
      symbol: "shared",
    });
    expect(firstCall(result.module.functions[8]!).target.binding.kind).toBe("support");

    const clone = result.module.functions.find((fn) => fn.unitId === cloneUnitId);
    expect(clone?.name).toBe(signature.name);
    expect(signature.name.startsWith("shared$")).toBe(true);
  });

  it("preserves exact clone ordinals when the callee is itself a derived lifted unit", () => {
    const sourceOwner = identities.next("owner");
    const liftedUnitId = createDerivedIrUnitId({
      parentId: sourceOwner.unitId,
      role: "lifted-closure",
      ordinal: 3,
    });
    const lifted: IrFunction = {
      ...makeIdentity("owner__closure_3"),
      unitId: liftedUnitId,
    };
    const numberCaller = makeCaller("numberCaller", irUnitFuncRef(lifted), F64);
    const externCaller = makeCaller("externCaller", irUnitFuncRef(lifted), EXTERNREF);
    const integerCaller = makeCaller("integerCaller", irUnitFuncRef(lifted), I32);

    const result = monomorphize({
      functions: [lifted, numberCaller, externCaller, integerCaller],
    });

    expect(result.cloneSignatures.size).toBe(2);
    expect(result.cloneOrigins.size).toBe(2);
    const provenance = [...result.cloneUnitProvenance.values()];
    expect(provenance).toEqual([
      {
        id: createDerivedIrUnitId({
          parentId: liftedUnitId,
          role: "monomorphization-clone",
          ordinal: 0,
        }),
        parentId: liftedUnitId,
        role: "monomorphization-clone",
        ordinal: 0,
      },
      {
        id: createDerivedIrUnitId({
          parentId: liftedUnitId,
          role: "monomorphization-clone",
          ordinal: 1,
        }),
        parentId: liftedUnitId,
        role: "monomorphization-clone",
        ordinal: 1,
      },
    ]);
    for (const record of provenance) {
      expect(result.cloneOrigins.get(record.id)).toBe(liftedUnitId);
      expect(result.module.functions.some((fn) => fn.unitId === record.id)).toBe(true);
    }
  });

  it("excludes only the recursive identity when a same-named peer is cloneable", () => {
    const recursiveIdentity = identities.next("loop");
    const recursive: IrFunction = {
      ...recursiveIdentity,
      params: [{ value: id(0), type: F64, name: "value" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            { kind: "const", value: { kind: "f64", value: 0 }, result: id(1), resultType: F64 },
            {
              kind: "call",
              target: irUnitFuncRef(recursiveIdentity),
              args: [id(1)],
              result: id(2),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: false,
      valueCount: 3,
    };
    const peer = makeIdentity("loop");
    const recursiveExternCaller = makeCaller("run", irUnitFuncRef(recursive), EXTERNREF);
    const recursiveNumberCaller = makeCaller("run", irUnitFuncRef(recursive), F64);
    const peerExternCaller = makeCaller("run", irUnitFuncRef(peer), EXTERNREF);
    const peerNumberCaller = makeCaller("run", irUnitFuncRef(peer), F64);

    const result = monomorphize({
      functions: [recursive, peer, recursiveExternCaller, recursiveNumberCaller, peerExternCaller, peerNumberCaller],
    });

    expect(result.cloneOrigins.size).toBe(1);
    const [[cloneUnitId, originUnitId]] = [...result.cloneOrigins.entries()];
    expect(originUnitId).toBe(peer.unitId);
    expect(cloneUnitId).toBe(
      createDerivedIrUnitId({
        parentId: peer.unitId,
        role: "monomorphization-clone",
        ordinal: 0,
      }),
    );

    expect(unitTarget(firstCall(result.module.functions[0]!))).toBe(recursive.unitId);
    expect(
      new Set([unitTarget(firstCall(result.module.functions[2]!)), unitTarget(firstCall(result.module.functions[3]!))]),
    ).toEqual(new Set([recursive.unitId]));
    expect(
      new Set([unitTarget(firstCall(result.module.functions[4]!)), unitTarget(firstCall(result.module.functions[5]!))]),
    ).toEqual(new Set([peer.unitId, cloneUnitId]));
  });

  it("rejects duplicate structural function identities instead of choosing the last unit", () => {
    const first = makeIdentity("first");
    const duplicate: IrFunction = {
      ...makeIdentity("second"),
      unitId: first.unitId,
    };

    expect(() => monomorphize({ functions: [first, duplicate] })).toThrow(
      new RegExp(`duplicate function unitId ${first.unitId}`),
    );
  });
});
