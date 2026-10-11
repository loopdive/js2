// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { irSupportTypeRef } from "../src/ir/abi-bindings.js";
import { createIrSourceId, createIrUnitId } from "../src/ir/identity.js";
import { asBlockId, asValueId, type IrFunction, type IrType, type IrVecLayoutRef } from "../src/ir/nodes.js";
import { attachIrVecLayouts } from "../src/ir/vec-layout.js";
import { attachIrStringCarrier } from "../src/ir/string-carrier.js";
import { attachIrPhysicalRefTypeRefs } from "../src/ir/physical-ref-support.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { planNativeSourceClosureRequirements } from "../src/ir/program/native-source-closure-requirements.js";

const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "closure-parameter-projections.ts" });
const unitId = createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "top-level-function", ordinal: 0 });
const reference = (role: string) => irSupportTypeRef(sourceId, role, `__${role}`);
const vectorLayout: IrVecLayoutRef = {
  carrierType: reference("vector-carrier"),
  dataType: reference("vector-data"),
  lengthFieldIndex: 0,
  dataFieldIndex: 1,
};
const scalar: IrType = { kind: "val", val: { kind: "f64" } };

function closure(type: IrType, parameters = true): IrFunction {
  return {
    unitId,
    name: "lifted",
    params: [{ value: asValueId(0), name: "input", type }],
    resultTypes: [],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [],
        terminator: { kind: "return", values: [] },
      },
    ],
    exported: false,
    valueCount: 1,
    closureSubtype: {
      signature: { params: [type, scalar], defaultParamStart: 1, returnType: null },
      captureFieldTypes: [type],
      ...(parameters ? { parameters: { kind: "fixed" as const, count: 2, publicLength: 1 } } : {}),
    },
  };
}

const projections: readonly {
  readonly name: string;
  readonly type: IrType;
  readonly project: (fn: IrFunction) => IrFunction;
}[] = [
  {
    name: "vector layout",
    type: { kind: "vec", elementType: scalar, nullable: false },
    project: (fn) => attachIrVecLayouts(fn, () => vectorLayout).function,
  },
  {
    name: "string carrier",
    type: { kind: "string" },
    project: (fn) => attachIrStringCarrier(fn, reference("string-carrier")).function,
  },
  {
    name: "physical reference",
    type: { kind: "val", val: { kind: "ref_null", typeIdx: 7 } },
    project: (fn) =>
      attachIrPhysicalRefTypeRefs(fn, (type) =>
        (type.val.kind === "ref" || type.val.kind === "ref_null") && type.val.typeIdx === 7
          ? reference("physical-carrier")
          : undefined,
      ),
  },
];

describe("source parameter facts across physical preparation", () => {
  for (const projection of projections) {
    it(`retains fixed/default parameter facts through a real ${projection.name} rewrite`, () => {
      const original = closure(projection.type);
      const projected = projection.project(original);
      expect(projected).not.toBe(original);
      expect(projected.closureSubtype!.signature).not.toBe(original.closureSubtype!.signature);
      expect(projected.closureSubtype!.captureFieldTypes).not.toBe(original.closureSubtype!.captureFieldTypes);
      expect(projected.closureSubtype!.parameters).toBe(original.closureSubtype!.parameters);
      expect(projected.closureSubtype!.parameters).toEqual({ kind: "fixed", count: 2, publicLength: 1 });
      expect(projected.closureSubtype!.signature.defaultParamStart).toBe(1);
      expect(projection.project(projected)).toBe(projected);
    });

    it(`keeps absent source facts absent after a ${projection.name} rewrite`, () => {
      const original = closure(projection.type, false);
      const projected = projection.project(original);
      expect(projected).not.toBe(original);
      expect(Object.hasOwn(projected.closureSubtype!, "parameters")).toBe(false);
      expect(projection.project(projected)).toBe(projected);
    });
  }

  it("retains genuine captured String source facts through preparation and decoding", () => {
    const source = analyzeMultiSource(
      {
        "./entry.ts": `export function run(): number {
      const captured = "abc";
      const fn = function(value: string, count: number = 1): number {
        return value.length + captured.length + count;
      };
      return fn("de", 2);
    }`,
      },
      "./entry.ts",
    );
    const original = requireProgram(
      prepareWholeIrProgram({
        sourceFiles: source.sourceFiles,
        entrySource: source.entryFile,
        checker: source.checker,
        deferTopLevelInit: false,
        policy: {
          target: "standalone",
          backend: "wasmgc",
          numberBoundary: { box: "native", unbox: "native" },
          stringConst: { storage: "native" },
          stringLen: { len: "native" },
        },
      }),
    );
    for (const program of [original, decodePreparedIrProgram(encodePreparedIrProgram(original))]) {
      const projection = program.runtime[0]!;
      const requirements = planNativeSourceClosureRequirements(program, projection);
      expect(requirements).toBeDefined();
      expect(requirements!.units).toHaveLength(1);
      expect(requirements!.allocations).toHaveLength(2);
      expect(new Set(requirements!.allocations.map((row) => row.allocationId)).size).toBe(1);
      expect(new Set(requirements!.allocations.map((row) => row.ownerUnitId)).size).toBe(1);
      const unitId = requirements!.units[0]!.unitId;
      const semantic = program.ir.functions.find((fn) => fn.unitId === unitId)!;
      const physical = projection.prepared.functions.find((fn) => fn.unitId === unitId)!;
      expect(semantic.sourceUnit).toBe(true);
      expect(physical.sourceUnit).toBe(true);
      expect(semantic.closureSubtype!.captureFieldTypes.some((type) => type.kind === "string")).toBe(true);
      expect(physical.closureSubtype!.captureFieldTypes.some((type) => type.kind === "string")).toBe(true);
      for (const fn of [semantic, physical])
        expect(fn.closureSubtype!.parameters).toEqual({ kind: "fixed", count: 2, publicLength: 1 });
    }
  });
});
