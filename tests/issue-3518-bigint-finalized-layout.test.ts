// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { markLeafStructsFinal } from "../src/codegen/fixups.js";
import { widenNonDefaultableTypes } from "../src/compiler/output.js";
import {
  buildOpenBigIntType,
  buildBigIntLimbsType,
  buildWideBigIntType,
} from "../src/runtime/wasmgc/values/bigint-carrier-layouts.js";
import {
  buildFinalizedWideBigIntType,
  declareFinalizedWideBigIntType,
} from "../src/runtime/wasmgc/values/bigint-finalized-layouts.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  requireNativeBigIntReservations,
  fillNativeBigIntResources,
  requireCompletedNativeBigInt,
} from "../src/backend/wasmgc/resources/native-bigint.js";

function fixture() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const plan = declareNativeBigIntResources("bigint");
  const pack = reserveNativeBigIntResources(tx, "bigint", plan);
  return { module, tx, plan, pack };
}

describe("canonical standalone BigInt emitted layout", () => {
  it.each([0, 7])("matches both actual legacy finalization passes at offset %s", (offset) => {
    const module = createEmptyModule();
    for (let i = 0; i < offset; i++) module.types.push({ kind: "struct", name: "prefix" + i, fields: [] });
    module.types.push(buildOpenBigIntType(), buildBigIntLimbsType(), buildWideBigIntType(offset, offset + 1));
    expect(markLeafStructsFinal(module)).toEqual([offset + 2]);
    widenNonDefaultableTypes(module);
    expect(module.types[offset]).toStrictEqual(buildOpenBigIntType());
    expect(module.types[offset + 1]).toStrictEqual(buildBigIntLimbsType());
    expect(module.types[offset + 2]).toStrictEqual(buildFinalizedWideBigIntType(offset, offset + 1));
    expect(buildWideBigIntType(offset, offset + 1).fields[2]!.type).toStrictEqual({ kind: "ref", typeIdx: offset + 1 });
    expect(buildWideBigIntType(offset, offset + 1).final).toBeUndefined();
  });

  it("binds finalized declaration fields to the exact issued base and magnitude array", () => {
    const f = fixture();
    expect(declareFinalizedWideBigIntType("bigint:type", "bigint:limbs")).toStrictEqual({
      kind: "struct",
      name: "$BigIntWide",
      parent: { kind: "resource", typeKey: "bigint:type" },
      final: true,
      fields: [
        { name: "value", type: { kind: "i64", bigint: true }, mutable: false },
        { name: "sign", type: { kind: "i32" }, mutable: false },
        { name: "mag", type: { kind: "ref_null", typeKey: "bigint:limbs" }, mutable: false },
      ],
    });
    expect(f.pack.wide.object).toStrictEqual(
      buildFinalizedWideBigIntType(f.pack.type.typeIndex, f.pack.limbs.typeIndex),
    );
    requireNativeBigIntReservations(f.tx, f.pack, f.plan);
    f.tx.freezeReservations();
    fillNativeBigIntResources(f.tx, f.pack);
    expect(Object.is(requireCompletedNativeBigInt(f.tx, f.pack, f.plan), f.pack)).toBe(true);
  });

  it("does not equate the WASI skip-final policy with this standalone leaf ABI", () => {
    const module = createEmptyModule();
    module.types.push(buildOpenBigIntType(), buildBigIntLimbsType(), buildWideBigIntType(0, 1));
    expect(markLeafStructsFinal(module, true)).toEqual([]);
    widenNonDefaultableTypes(module);
    expect(module.types[2]).not.toStrictEqual(buildFinalizedWideBigIntType(0, 1));
  });

  it("rejects a future wide subtype instead of completing a contradictory leaf plan", () => {
    const f = fixture();
    requireNativeBigIntReservations(f.tx, f.pack, f.plan);
    const before = structuredClone(f.module);
    const wide = buildFinalizedWideBigIntType(f.pack.type.typeIndex, f.pack.limbs.typeIndex);
    expect(() =>
      f.tx.reserveType("future:wide-child", {
        kind: "struct",
        name: "FutureWide",
        superTypeIdx: f.pack.wide.typeIndex,
        fields: structuredClone(wide.fields),
      }),
    ).toThrow("final parent");
    expect(f.module).toStrictEqual(before);
    expect(() => requireCompletedNativeBigInt(f.tx, f.pack, f.plan)).toThrow();
  });

  it("uses actual subtype population in the legacy control", () => {
    const module = createEmptyModule();
    const wide = buildWideBigIntType(0, 1);
    module.types.push(buildOpenBigIntType(), buildBigIntLimbsType(), wide, {
      kind: "struct",
      name: "FutureWide",
      superTypeIdx: 2,
      fields: structuredClone(wide.fields),
    });
    expect(markLeafStructsFinal(module)).toEqual([3]);
    widenNonDefaultableTypes(module);
    expect(wide.final).toBeUndefined();
    expect(wide).not.toStrictEqual(buildFinalizedWideBigIntType(0, 1));
  });

  it.each(["finality", "nullability", "parent"] as const)(
    "rejects changed finalized %s after real completion",
    (part) => {
      const f = fixture();
      f.tx.freezeReservations();
      fillNativeBigIntResources(f.tx, f.pack);
      requireCompletedNativeBigInt(f.tx, f.pack, f.plan);
      const wide = f.pack.wide.object;
      if (wide.kind !== "struct") throw Error("missing issued wide struct");
      if (part === "finality") wide.final = false;
      else if (part === "nullability") wide.fields[2]!.type = { kind: "ref", typeIdx: f.pack.limbs.typeIndex };
      else wide.superTypeIdx = -1;
      expect(() => requireCompletedNativeBigInt(f.tx, f.pack, f.plan)).toThrow("altered carrier layout");
    },
  );

  it("rejects a substituted open-child plan before allocating any resources", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const plan = structuredClone(declareNativeBigIntResources("bigint"));
    const row = plan.declarations.find((row) => row.key === "bigint:wide");
    if (!row || row.space !== "type" || row.shape.kind !== "struct") throw Error("missing wide declaration");
    Object.assign(row.shape, { final: false });
    const before = structuredClone(module);
    expect(() => reserveNativeBigIntResources(tx, "bigint", plan)).toThrow("substituted declaration plan");
    expect(module).toStrictEqual(before);
  });
});
