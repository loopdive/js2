// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import {
  AllocSiteRegistry,
  IrFunctionBuilder,
  asBlockId,
  asValueId,
  classShapeEquals,
  createIrClassId,
  createIrSourceId,
  irTypeEquals,
  irUnitFuncRef,
  planLinearMemory,
  verifyIrBackendLegality,
  type IrClassShape,
  type IrFunction,
  type IrType,
  type IrValueId,
} from "../src/ir/index.js";
import { irTypeKey } from "../src/ir/integration.js";
import { monomorphize } from "../src/ir/passes/monomorphize.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3520-class-shape-type-identity");
const F64: IrType = { kind: "val", val: { kind: "f64" } };

function valueId(value: number): IrValueId {
  return asValueId(value);
}

function sameLabelShape(sourceKey: string): IrClassShape {
  const sourceId = createIrSourceId({ kind: "source", order: 0, sourceKey });
  return {
    classId: createIrClassId({
      sourceId,
      lexicalOwnerId: null,
      declarationKind: "declaration",
      ordinal: 0,
    }),
    className: "Shared",
    fields: [{ name: "value", type: F64 }],
    methods: [],
    constructorParams: [],
  };
}

function identityCallee(): IrFunction {
  return {
    ...identities.next("identity"),
    params: [{ value: valueId(0), type: F64, name: "value" }],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [],
        terminator: { kind: "return", values: [valueId(0)] },
      },
    ],
    exported: false,
    valueCount: 1,
  };
}

function caller(name: string, callee: IrFunction, type: IrType): IrFunction {
  return {
    ...identities.next(name),
    params: [{ value: valueId(0), type, name: "value" }],
    resultTypes: [type],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "call",
            target: irUnitFuncRef(callee),
            args: [valueId(0)],
            result: valueId(1),
            resultType: type,
          },
        ],
        terminator: { kind: "return", values: [valueId(1)] },
      },
    ],
    exported: false,
    valueCount: 2,
  };
}

describe("#3520 source-qualified class-shape type identity", () => {
  it("keeps same-labelled source classes nominally distinct", () => {
    const first = sameLabelShape("@test/source-a.ts");
    const second = sameLabelShape("@test/source-b.ts");

    expect(first.classId).not.toBe(second.classId);
    expect(classShapeEquals(first, second)).toBe(false);
    expect(irTypeEquals({ kind: "class", shape: first }, { kind: "class", shape: second })).toBe(false);
    expect(irTypeKey({ kind: "class", shape: first })).not.toBe(irTypeKey({ kind: "class", shape: second }));
    expect(classShapeEquals(first, { ...first, className: "DiagnosticAlias" })).toBe(true);
    expect(irTypeKey({ kind: "class", shape: first })).toBe(
      irTypeKey({ kind: "class", shape: { ...first, className: "DiagnosticAlias" } }),
    );
  });

  it("forms separate monomorphization tuples for same-labelled source classes", () => {
    const firstType: IrType = { kind: "class", shape: sameLabelShape("@test/mono-a.ts") };
    const secondType: IrType = { kind: "class", shape: sameLabelShape("@test/mono-b.ts") };
    const callee = identityCallee();
    const result = monomorphize({
      functions: [callee, caller("from-a", callee, firstType), caller("from-b", callee, secondType)],
    });

    expect(result.cloneSignatures.size).toBe(1);
    expect([...result.cloneOrigins.values()]).toEqual([callee.unitId]);
  });

  it("keeps separate linear layouts for same-labelled source classes", () => {
    const first = sameLabelShape("@test/layout-a.ts");
    const second = sameLabelShape("@test/layout-b.ts");
    const registry = new AllocSiteRegistry();
    const functions = [first, second].map((shape, index) => {
      const type: IrType = { kind: "class", shape };
      const builder = new IrFunctionBuilder(identities.next(`layout-${index}`), [type], false, registry);
      const value = builder.addParam("value", type);
      builder.openBlock();
      builder.terminate({ kind: "return", values: [value] });
      return builder.finish();
    });
    const plan = planLinearMemory({ functions }, registry);

    const firstLayout = plan.layoutForClassShape(first);
    const secondLayout = plan.layoutForClassShape(second);
    expect(firstLayout).toBeDefined();
    expect(secondLayout).toBeDefined();
    expect(firstLayout?.id).not.toBe(secondLayout?.id);
    expect(plan.layouts.filter((layout) => layout.id.startsWith("record:class:"))).toHaveLength(2);
  });

  it("plans and verifies mutually recursive class layouts without losing nominal identity", () => {
    const left = sameLabelShape("@test/recursive-left.ts");
    const right = sameLabelShape("@test/recursive-right.ts");
    (left.fields as { name: string; type: IrType }[]).push({ name: "right", type: { kind: "class", shape: right } });
    (right.fields as { name: string; type: IrType }[]).push({ name: "left", type: { kind: "class", shape: left } });
    const leftType: IrType = { kind: "class", shape: left };
    const registry = new AllocSiteRegistry();
    const builder = new IrFunctionBuilder(identities.next("recursive-layout"), [leftType], false, registry);
    const value = builder.addParam("value", leftType);
    builder.openBlock();
    builder.terminate({ kind: "return", values: [value] });
    const func = builder.finish();

    const linearErrors = verifyIrBackendLegality(func, "linear");
    expect(linearErrors).toHaveLength(4);
    expect(linearErrors.every((error) => error.message.includes("does not support IR type 'class'"))).toBe(true);
    expect(linearErrors.map((error) => error.message)).toContain(
      "param value.right.left: linear backend does not support IR type 'class'",
    );
    expect(verifyIrBackendLegality(func, "wasmgc")).toEqual([]);
    const plan = planLinearMemory({ functions: [func] }, registry);
    expect(plan.layoutForClassShape(left)?.id).not.toBe(plan.layoutForClassShape(right)?.id);
    expect(plan.layouts.filter((layout) => layout.id.startsWith("record:class:")).map((layout) => layout.id)).toEqual(
      expect.arrayContaining([
        `record:class:${JSON.stringify(left.classId)}`,
        `record:class:${JSON.stringify(right.classId)}`,
      ]),
    );
  });
});
