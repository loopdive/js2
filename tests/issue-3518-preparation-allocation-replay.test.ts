// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { AllocSiteRegistry, copyIrPreparationData, type AllocRegistrySnapshot } from "../src/ir/alloc-registry.js";
import { asAllocSiteId, irVal, IR_CLASS_SHAPE_CELL, type IrClassShape, type IrType } from "../src/ir/nodes.js";
import { createIrClassId, createIrSourceId } from "../src/ir/identity.js";

const id = asAllocSiteId;
const type = irVal({ kind: "f64" });
function snapshot(): AllocRegistrySnapshot {
  return {
    size: 5,
    entries: [
      { state: "aliased", to: id(1) },
      { state: "aliased", to: id(2) },
      { state: "live", site: { id: id(2), kind: "object", type } },
      { state: "retired" },
      { state: "aliased", to: id(3) },
    ],
    metadata: [
      {
        id: id(2),
        entries: [
          ["future", undefined],
          ["collision", "target"],
        ],
      },
      { id: id(0), entries: [["collision", "source"]] },
    ],
  };
}

describe("typed allocation capture/restoration (not final metadata admission)", () => {
  it("retains all slots, raw alias chains, retired targets, row order, and next identity", () => {
    const original = snapshot();
    const registry = AllocSiteRegistry.fromSnapshot(original);
    expect(registry.captureSnapshot()).toEqual(original);
    expect(registry.resolve(id(0))?.id).toBe(2);
    expect(registry.resolve(id(4))).toBeNull();
    expect(registry.captureSnapshot()).toEqual(original); // resolving did not flatten the receipt
    expect(registry.fresh("object", type)).toBe(5);
  });

  it("preserves alias metadata collision precedence without replaying alias operations", () => {
    const registry = new AllocSiteRegistry();
    const left = registry.fresh("object", type),
      right = registry.fresh("object", type);
    registry.annotate(left, "collision", "left");
    registry.annotate(right, "collision", "right");
    registry.annotate(left, "future", undefined);
    registry.alias(left, right);
    const before = registry.captureSnapshot();
    const restored = AllocSiteRegistry.fromSnapshot(before);
    expect(restored.captureSnapshot()).toEqual(before);
    expect(restored.read(right, "collision")).toBe("right");
    expect(
      restored
        .captureSnapshot()
        .metadata.some((row) => row.entries.some(([key, value]) => key === "future" && value === undefined)),
    ).toBe(true);
  });

  it("jointly detaches shared IR/site/metadata objects and retains undefined and missing distinctions", () => {
    const registry = new AllocSiteRegistry();
    const shape = { value: 1 };
    const sharedType: IrType = { kind: "vec", elementType: type, nullable: true };
    const site = registry.fresh("array", sharedType);
    const sparse = new Array(3);
    sparse[1] = undefined;
    sparse[2] = shape;
    const value = {
      missing: {},
      present: { value: undefined },
      sparse,
      shape,
      values: [-0, NaN, Infinity, -Infinity, 9007199254740993n],
      map: new Map([[shape, new Set([shape])]]),
    };
    registry.annotate(site, "future", value);
    const captured = registry.capturePreparationData({ type: sharedType, shape });
    const restored = AllocSiteRegistry.restorePreparationData(captured.allocations, captured.data);
    const metadata = restored.allocations.read<typeof value>(site, "future")!;
    expect(restored.allocations.resolve(site)!.type).toBe(restored.data.type);
    expect(metadata.shape).toBe(restored.data.shape);
    expect(metadata.sparse[2]).toBe(metadata.shape);
    expect([...metadata.map.keys()][0]).toBe(metadata.shape);
    expect([...metadata.map.values()][0]!.has(metadata.shape)).toBe(true);
    expect(Object.hasOwn(metadata.sparse, 0)).toBe(false);
    expect(Object.hasOwn(metadata.sparse, 1)).toBe(true);
    expect(Object.hasOwn(metadata.present, "value")).toBe(true);
    expect(Object.hasOwn(metadata.missing, "value")).toBe(false);
    expect(metadata.values).toEqual(value.values);
    shape.value = 9;
    expect(restored.data.shape.value).toBe(1);
    captured.data.shape.value = 8;
    expect(restored.data.shape.value).toBe(1);
  });

  it("retains canonical recursive class-shape and shared graph identities", () => {
    const fields: { name: string; type: IrType }[] = [];
    const shape: IrClassShape = {
      [IR_CLASS_SHAPE_CELL]: true,
      classId: createIrClassId({
        sourceId: createIrSourceId({ kind: "entry", sourceKey: "class.ts", order: 0 }),
        lexicalOwnerId: null,
        declarationKind: "declaration",
        ordinal: 0,
      }),
      className: "Cell",
      fields,
      methods: [],
      constructorParams: [],
    };
    const recursive: IrType = { kind: "class", shape };
    fields.push({ name: "next", type: recursive });
    const copy = copyIrPreparationData({ shape, recursive, again: recursive });
    expect(copy.shape).not.toBe(shape);
    expect(copy.recursive).toBe(copy.again);
    expect(copy.shape.fields[0]!.type).toBe(copy.recursive);
    expect(copy.shape[IR_CLASS_SHAPE_CELL]).toBe(true);
  });

  it.each([
    [
      "accessor",
      () =>
        Object.defineProperty({}, "bad", {
          get() {
            throw new Error("getter ran");
          },
        }),
      /accessor/,
    ],
    ["array extras", () => Object.assign([], { extra: undefined }), /extra array property/],
    ["function", () => ({ f() {} }), /executable/],
    ["symbol", () => ({ value: Symbol("foreign") }), /symbol/],
    ["symbol key", () => ({ [Symbol("foreign")]: true }), /symbol/],
    ["Date", () => new Date(0), /unsupported Date/],
    ["invalid Date", () => new Date(NaN), /unsupported Date/],
    ["null-prototype Date", () => Object.setPrototypeOf(new Date(0), null), /unsupported Date/],
    ["null-prototype invalid Date", () => Object.setPrototypeOf(new Date(NaN), null), /unsupported Date/],
    ["Object.prototype Date", () => Object.setPrototypeOf(new Date(0), Object.prototype), /unsupported Date/],
    ["Object.prototype invalid Date", () => Object.setPrototypeOf(new Date(NaN), Object.prototype), /unsupported Date/],
    ["WeakMap", () => new WeakMap(), /unsupported collection/],
    ["map extras", () => Object.assign(new Map(), { extra: 1 }), /extra properties/],
  ] as const)("rejects %s without normalizing away evidence", (_label, make, error) => {
    const registry = new AllocSiteRegistry();
    registry.annotate(registry.fresh("object", type), "future", make());
    expect(() => registry.captureSnapshot()).toThrow(error);
    expect(() => AllocSiteRegistry.fromSnapshot(registry.snapshot())).toThrow(error);
  });

  it.each([
    ["Date", () => Object.setPrototypeOf(new Date(NaN), null)],
    ["ordinary record", () => ({})],
    ["null record", () => Object.create(null)],
  ] as const)("does not read Symbol.toStringTag while rejecting %s metadata", (_label, make) => {
    let tagReads = 0;
    const value = Object.defineProperty(make(), Symbol.toStringTag, {
      get() {
        tagReads++;
        return "Date";
      },
    });
    const registry = new AllocSiteRegistry();
    registry.annotate(registry.fresh("object", type), "future", value);
    expect(() => registry.captureSnapshot()).toThrow(/invalid preparation data/);
    expect(() => AllocSiteRegistry.fromSnapshot(registry.snapshot())).toThrow(/invalid preparation data/);
    expect(tagReads).toBe(0);
  });

  it.each([Object.prototype, null])("retains ordinary record metadata with prototype %s", (prototype) => {
    const value = Object.assign(Object.create(prototype), { present: undefined, nested: { number: 7 } });
    const registry = new AllocSiteRegistry();
    const site = registry.fresh("object", type);
    registry.annotate(site, "future", value);
    const snapshot = registry.captureSnapshot();
    const restored = AllocSiteRegistry.fromSnapshot(snapshot).read<typeof value>(site, "future")!;
    expect(restored).toEqual(value);
    expect(restored).not.toBe(value);
    expect(restored.nested).not.toBe(value.nested);
    expect(Object.getPrototypeOf(restored)).toBe(prototype);
    expect(Object.hasOwn(restored, "present")).toBe(true);
  });

  it.each([
    ["denominator", (s: AllocRegistrySnapshot) => ({ ...s, size: 6 })],
    [
      "foreign live id",
      (s: AllocRegistrySnapshot) => ({
        ...s,
        entries: s.entries.map((row, i) =>
          i === 2 ? { state: "live", site: { id: id(8), kind: "object", type } } : row,
        ),
      }),
    ],
    [
      "alias cycle",
      (s: AllocRegistrySnapshot) => ({
        ...s,
        entries: s.entries.map((row, i) => (i === 1 ? { state: "aliased", to: id(0) } : row)),
      }),
    ],
    [
      "foreign alias",
      (s: AllocRegistrySnapshot) => ({
        ...s,
        entries: s.entries.map((row, i) => (i === 1 ? { state: "aliased", to: id(7) } : row)),
      }),
    ],
    ["duplicate row", (s: AllocRegistrySnapshot) => ({ ...s, metadata: [...s.metadata, s.metadata[0]] })],
    ["foreign row", (s: AllocRegistrySnapshot) => ({ ...s, metadata: [{ id: id(7), entries: [] }] })],
    [
      "duplicate namespace",
      (s: AllocRegistrySnapshot) => ({
        ...s,
        metadata: [
          {
            id: id(2),
            entries: [
              ["x", 1],
              ["x", undefined],
            ],
          },
        ],
      }),
    ],
  ])("rejects malformed %s", (_label, change) => {
    // Deliberately malformed transport data; not an assertion of prepared-program authority.
    expect(() => AllocSiteRegistry.fromSnapshot(change(snapshot()) as AllocRegistrySnapshot)).toThrow(
      /allocation snapshot/,
    );
  });
});
