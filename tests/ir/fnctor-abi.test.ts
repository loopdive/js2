import { describe, expect, it } from "vitest";

import type { IrBindingId, IrSourceId, IrUnitId } from "../../src/ir/identity.js";
import {
  irFnctorShapeEquals,
  validateIrFnctorResolution,
  validateIrFnctorShape,
  type IrFnctorResolution,
  type IrFnctorShape,
} from "../../src/ir/fnctor-abi.js";
import { irFnctor, irTypeEquals, irVal } from "../../src/ir/nodes.js";
import { IrFunctionBuilder } from "../../src/ir/builder.js";
import { effectsOf, isSideEffecting } from "../../src/ir/effects.js";
import { verifyIrFunction } from "../../src/ir/verify.js";
import { verifyIrBackendLegality } from "../../src/ir/backend/legality.js";
import { irTypeKey } from "../../src/ir/type-key.js";

const sourceId = "ir-source:test:entry:parser.ts" as IrSourceId;
const unitId = "ir-unit:test:parser" as IrUnitId;
const bindingId = "ir-binding:test:parser" as IrBindingId;

function parserShape(): IrFnctorShape {
  return {
    kind: "fnctor-shape",
    sourceId,
    constructorUnitId: unitId,
    constructorName: "Parser",
    constructorTarget: { kind: "func", name: "Parser", binding: { kind: "unit", unitId } },
    reservedLayout: { kind: "type", name: "__fnctor_Parser", binding: { kind: "source", bindingId } },
    fields: [{ name: "input", type: { kind: "string" }, ordinal: 0 }],
    captures: [],
    userParamTypes: [irVal({ kind: "externref" })],
    constructorIdentity: { unitId, paramIndex: 1 },
  };
}

function parserResolution(shape: IrFnctorShape): IrFnctorResolution {
  return {
    shape,
    structType: shape.reservedLayout,
    constructor: shape.constructorTarget,
    captureParamTypes: [],
    userParamTypes: shape.userParamTypes,
    constructorIdentityParamIndex: shape.constructorIdentity.paramIndex,
    resultIsExternref: false,
  };
}

describe("fnctor ABI contract", () => {
  it("accepts an exact source-qualified Parser shape and resolution", () => {
    const shape = parserShape();
    expect(validateIrFnctorShape(shape)).toBeNull();
    expect(validateIrFnctorResolution(parserResolution(shape))).toBeNull();
    expect(irFnctorShapeEquals(shape, parserShape())).toBe(true);
  });

  it("rejects duplicate fields and an identity index that does not follow the ABI", () => {
    const shape = parserShape();
    expect(validateIrFnctorShape({ ...shape, fields: [...shape.fields, shape.fields[0]!] })).toMatch(/duplicate field/);
    expect(validateIrFnctorShape({ ...shape, constructorIdentity: { unitId, paramIndex: 0 } })).toMatch(
      /identity index/,
    );
  });

  it("rejects a resolver that retargets the constructor", () => {
    const shape = parserShape();
    const wrongTarget = {
      kind: "func" as const,
      name: "Other",
      binding: { kind: "unit" as const, unitId: "ir-unit:test:other" as IrUnitId },
    };
    expect(validateIrFnctorResolution({ ...parserResolution(shape), constructor: wrongTarget })).toMatch(
      /nominal target/,
    );
    const wrongLayout = {
      ...shape.reservedLayout,
      name: "__fnctor_Other",
      binding: { kind: "source" as const, bindingId: "ir-binding:test:other" as IrBindingId },
    };
    expect(validateIrFnctorResolution({ ...parserResolution(shape), structType: wrongLayout })).toMatch(
      /reserved layout identity/,
    );
  });

  it("keeps nominal IrType equality sensitive to the full fnctor shape", () => {
    const shape = parserShape();
    const type = irFnctor(shape);
    expect(irTypeEquals(type, irFnctor(parserShape()))).toBe(true);
    expect(
      irTypeEquals(
        type,
        irFnctor({
          ...shape,
          fields: [{ ...shape.fields[0]!, type: irVal({ kind: "f64" }) }],
        }),
      ),
    ).toBe(false);
    expect(irTypeEquals(type, { kind: "dynamic" })).toBe(false);
  });

  it("builds and verifies fnctor.new/get without lowering it", () => {
    const shape: IrFnctorShape = {
      ...parserShape(),
      userParamTypes: [],
      constructorIdentity: { unitId, paramIndex: 0 },
    };
    const builder = new IrFunctionBuilder({ unitId: "ir-unit:test:fnctor" as IrUnitId, name: "fnctorTest" }, [
      { kind: "string" },
    ]);
    builder.openBlock();
    const instance = builder.emitFnctorNew(shape, [], [], null);
    const field = builder.emitFnctorGet(instance, shape, "input");
    builder.terminate({ kind: "return", values: [field] });
    const fn = builder.finish();
    expect(verifyIrFunction(fn)).toEqual([]);
    const instructions = fn.blocks[0]!.instrs;
    const made = instructions.find((instr) => instr.kind === "fnctor.new")!;
    const read = instructions.find((instr) => instr.kind === "fnctor.get")!;
    expect(effectsOf(made).writesHeap).toBe(true);
    expect(isSideEffecting(made)).toBe(true);
    expect(effectsOf(read).readsHeap).toBe(true);
    expect(isSideEffecting(read)).toBe(false);
    expect(verifyIrBackendLegality(fn, "wasmgc").some((error) => error.message.includes("fnctor"))).toBe(true);
  });

  it("rejects malformed fnctor instruction arity and nominal mismatches", () => {
    const shape: IrFnctorShape = {
      ...parserShape(),
      userParamTypes: [],
      constructorIdentity: { unitId, paramIndex: 0 },
    };
    const builder = new IrFunctionBuilder(
      { unitId: "ir-unit:test:fnctor-errors" as IrUnitId, name: "fnctorErrors" },
      [],
    );
    builder.openBlock();
    expect(() => builder.emitFnctorNew(shape, [0 as never], [], null)).toThrow(/capture count/);
    const instance = builder.emitFnctorNew(shape, [], [], null);
    expect(() => builder.emitFnctorGet(instance, shape, "missing")).toThrow(/unknown fnctor field/);
    builder.terminate({ kind: "return", values: [] });
    const fn = builder.finish();
    const wrongName = { ...shape, constructorName: "Other" };
    expect(irTypeEquals(irFnctor(shape), irFnctor(wrongName))).toBe(true);
    expect(irTypeKey(irFnctor(shape))).toBe(irTypeKey(irFnctor(wrongName)));
    const recursive = { ...shape, fields: [] as IrFnctorShape["fields"] };
    const recursiveType = { kind: "fnctor" as const, shape: recursive };
    (recursive.fields as { name: string; type: typeof recursiveType; ordinal: number }[]).push({
      name: "self",
      type: recursiveType,
      ordinal: 0,
    });
    expect(validateIrFnctorShape(recursive)).toMatch(/recursive/);
    expect(() => irTypeKey(irFnctor(recursive))).toThrow(/recursive/);
    expect(verifyIrFunction({ ...fn, resultTypes: [irFnctor(shape)] })).not.toEqual([]);
  });
});
