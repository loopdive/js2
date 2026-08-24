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
    const wrongTarget = { kind: "func" as const, name: "Other", binding: { kind: "unit" as const, unitId } };
    expect(validateIrFnctorResolution({ ...parserResolution(shape), constructor: wrongTarget })).toMatch(
      /nominal target/,
    );
    const wrongLayout = { ...shape.reservedLayout, name: "__fnctor_Other" };
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
});
