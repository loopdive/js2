// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { irSupportRef, irVal, objectShapeEquals, type IrObjectShape, type IrType } from "../src/ir/core/types.js";
import { irSupportTypeRef } from "../src/ir/core/type-references.js";
import { createIrSourceId } from "../src/ir/identity.js";
import { irPhysicalTypeKey, irTypeKey } from "../src/ir/type-key.js";
import { irPhysicalTypeKey as corePhysicalKey } from "../src/ir/core/type-key.js";
import { orderedObjectFields } from "../src/ir/object-layout.js";
import { orderedObjectFields as coreOrderedFields } from "../src/ir/core/object-layout.js";
import { lowerIrTypeToValType, type IrLowerResolver } from "../src/ir/lower.js";
import { lowerIrTypeToValType as genericLowerType } from "../src/ir/lower-generic.js";

const source = createIrSourceId({ kind: "entry", order: 0, sourceKey: "composition.ts" });
const ref = irSupportTypeRef(source, "closure-cell", "carrier");
const support = irSupportRef(ref, true);

it("keeps the facade and canonical implementations identical", () => {
  expect(irPhysicalTypeKey).toBe(corePhysicalKey);
  expect(orderedObjectFields).toBe(coreOrderedFields);
  expect(lowerIrTypeToValType).toBe(genericLowerType);
});

it("preserves support-reference keys inside ordered declared object layouts", () => {
  const shape: IrObjectShape = {
    allocationKind: "declared",
    fields: [
      { name: "a", type: support },
      { name: "z", type: irVal({ kind: "f64" }) },
    ],
    fieldOrder: ["z", "a"],
  };
  const canonical: IrObjectShape = { ...shape, fieldOrder: ["a", "z"] };
  const type: IrType = { kind: "object", shape };
  expect(orderedObjectFields(shape).map((field) => field.name)).toEqual(["z", "a"]);
  expect(objectShapeEquals(shape, canonical)).toBe(false);
  expect(irTypeKey(type)).toContain(irTypeKey(support));
  expect(irPhysicalTypeKey(type)).toContain(irTypeKey(support));
  expect(irPhysicalTypeKey(type)).not.toBe(irPhysicalTypeKey({ kind: "object", shape: canonical }));
  expect(() => orderedObjectFields({ ...shape, fieldOrder: ["a", "a"] })).toThrow(/every field exactly once/);
});

it("keeps physical closure keys stable across symbolic carrier relocation", () => {
  const carrier = (typeIdx: number): IrType => ({ kind: "val", val: { kind: "ref_null", typeIdx }, typeRef: ref });
  const closure = (typeIdx: number): IrType => ({
    kind: "closure",
    signature: { params: [support, carrier(typeIdx)], returnType: carrier(typeIdx) },
  });
  expect(irPhysicalTypeKey(closure(7))).toBe(irPhysicalTypeKey(closure(91)));
  expect(irTypeKey(closure(7))).not.toBe(irTypeKey(closure(91)));
  expect(irPhysicalTypeKey(support)).toBe(irTypeKey(support));
});

it("resolves a boxed support-reference through the relocated lowerer", () => {
  const seen: unknown[] = [];
  const unused = (): never => {
    throw new Error("unexpected resolver request");
  };
  const resolver: IrLowerResolver = {
    resolveFunc: unused,
    resolveGlobal: unused,
    internFuncType: unused,
    resolveType: (requested) => {
      expect(requested).toBe(ref);
      return 23;
    },
    resolveRefCell: (inner) => {
      seen.push(inner);
      return { typeIdx: 42, fieldIdx: 0 };
    },
  };
  expect(lowerIrTypeToValType({ kind: "boxed", inner: support }, resolver, "composed")).toEqual({
    kind: "ref",
    typeIdx: 42,
  });
  expect(seen).toEqual([{ kind: "ref_null", typeIdx: 23 }]);
});
