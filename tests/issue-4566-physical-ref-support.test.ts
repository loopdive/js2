// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { irSupportTypeRef } from "../src/ir/abi-bindings.js";
import { createIrSourceId, createIrUnitId } from "../src/ir/identity.js";
import { type IrLowerResolver, lowerIrTypeToValType } from "../src/ir/lower.js";
import { asBlockId, asValueId, type IrFunction, type IrType } from "../src/ir/nodes.js";
import { attachIrPhysicalRefTypeRefs } from "../src/ir/physical-ref-support.js";

const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "issue-4566-physical-ref-support.ts" });
const unitId = createIrUnitId({
  sourceId,
  lexicalOwnerId: null,
  kind: "top-level-function",
  ordinal: 0,
});
const mapRef = irSupportTypeRef(sourceId, "native-map-carrier", "__ir_native_map_carrier");
const otherRef = irSupportTypeRef(sourceId, "other-carrier", "__ir_other_carrier");

function fnWithParam(type: IrType): IrFunction {
  return {
    unitId,
    name: "run",
    params: [{ value: asValueId(0), name: "value", type }],
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
  };
}

const mapCarrier = (): IrType => ({ kind: "val", val: { kind: "ref_null", typeIdx: 7 } });
const mapRefFor = (type: Extract<IrType, { readonly kind: "val" }>) =>
  (type.val.kind === "ref" || type.val.kind === "ref_null") && type.val.typeIdx === 7 ? mapRef : undefined;

describe("#4566 physical reference preparation", () => {
  it("preserves identity on no-match and on an already attached second pass", () => {
    const noMatch = fnWithParam({
      kind: "object",
      shape: {
        fields: [
          { name: "items", type: { kind: "vec", elementType: { kind: "val", val: { kind: "f64" } }, nullable: false } },
        ],
      },
    });
    expect(attachIrPhysicalRefTypeRefs(noMatch, mapRefFor)).toBe(noMatch);

    const nested = fnWithParam({
      kind: "object",
      shape: { fields: [{ name: "cache", type: mapCarrier() }] },
    });
    const attached = attachIrPhysicalRefTypeRefs(nested, mapRefFor);
    expect(attached).not.toBe(nested);
    expect(attached.params[0]!.type).toMatchObject({
      kind: "object",
      shape: { fields: [{ name: "cache", type: { kind: "val", typeRef: mapRef } }] },
    });
    expect(attachIrPhysicalRefTypeRefs(attached, mapRefFor)).toBe(attached);
  });

  it("rewrites every member of a recursive type graph that reaches the carrier", () => {
    const aShape: { fields: { name: string; type: IrType }[] } = { fields: [] };
    const bShape: { fields: { name: string; type: IrType }[] } = { fields: [] };
    const a: IrType = { kind: "object", shape: aShape };
    const b: IrType = { kind: "object", shape: bShape };
    aShape.fields.push({ name: "b", type: b }, { name: "cache", type: mapCarrier() });
    bShape.fields.push({ name: "a", type: a });

    const original = fnWithParam(a);
    const attached = attachIrPhysicalRefTypeRefs(original, mapRefFor);
    expect(attached).not.toBe(original);
    const attachedA = attached.params[0]!.type;
    expect(attachedA).not.toBe(a);
    expect(attachedA.kind).toBe("object");
    if (attachedA.kind !== "object") throw new Error("expected attached recursive object A");
    const attachedB = attachedA.shape.fields[0]!.type;
    expect(attachedB).not.toBe(b);
    expect(attachedB.kind).toBe("object");
    if (attachedB.kind !== "object") throw new Error("expected attached recursive object B");
    expect(attachedB.shape.fields[0]!.type).toBe(attachedA);
    expect(attachedA.shape.fields[1]!.type).toMatchObject({ kind: "val", typeRef: mapRef });
    expect(attachIrPhysicalRefTypeRefs(attached, mapRefFor)).toBe(attached);
  });

  it("rejects conflicting identities and scalar attachments before lowering", () => {
    const conflicting = fnWithParam({
      kind: "val",
      val: { kind: "ref_null", typeIdx: 7 },
      typeRef: otherRef,
    });
    expect(() => attachIrPhysicalRefTypeRefs(conflicting, mapRefFor)).toThrow(
      /IR physical reference type carries .* expected/,
    );

    const scalar = fnWithParam({ kind: "val", val: { kind: "f64" } });
    expect(() => attachIrPhysicalRefTypeRefs(scalar, () => mapRef)).toThrow(
      "IR physical reference identity cannot attach to scalar f64",
    );
  });

  it("lowers the symbolic Program-ABI type instead of the stale physical index", () => {
    const resolver: IrLowerResolver = {
      resolveFunc: () => {
        throw new Error("unexpected function resolution");
      },
      resolveGlobal: () => {
        throw new Error("unexpected global resolution");
      },
      resolveType: (ref) => {
        expect(ref).toBe(mapRef);
        return 23;
      },
      internFuncType: () => {
        throw new Error("unexpected function-type interning");
      },
    };
    expect(
      lowerIrTypeToValType(
        { kind: "val", val: { kind: "ref_null", typeIdx: 7 }, typeRef: mapRef },
        resolver,
        "symbolicMap",
      ),
    ).toEqual({ kind: "ref_null", typeIdx: 23 });
  });
});
