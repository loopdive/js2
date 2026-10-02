// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule, type TypeDef, type StructTypeDef } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";

const struct = (): StructTypeDef => ({ kind: "struct", name: "struct", fields: [] });
const child = (parent: number, wrapped: boolean): TypeDef =>
  wrapped
    ? { kind: "sub", name: "child", superType: parent, final: true, type: struct() }
    : { ...struct(), superTypeIdx: parent, final: true };
const finalParents: readonly [string, TypeDef][] = [
  ["implicit struct", struct()],
  ["plain struct final:false is still implicit final", { ...struct(), final: false }],
  ["explicit root", { ...struct(), superTypeIdx: -1, final: true }],
  ["wrapped root", { kind: "sub", name: "parent", superType: null, final: true, type: struct() }],
  ["plain array", { kind: "array", name: "array", element: { kind: "i32" }, mutable: true }],
  ["plain function", { kind: "func", params: [], results: [] }],
];
const openParents: readonly [string, TypeDef][] = [
  ["undefined finality on explicit root", { ...struct(), superTypeIdx: -1 }],
  ["explicitly open root", { ...struct(), superTypeIdx: -1, final: false }],
  ["open wrapped root", { kind: "sub", name: "parent", superType: null, final: false, type: struct() }],
];

describe("physical final-parent reservation guards", () => {
  for (const wrapped of [false, true])
    for (const recursive of [false, true]) {
      it.each(openParents)(`retains a valid open %s, wrapped=${wrapped}, rec=${recursive}`, (_name, parent) => {
        const module = createEmptyModule(),
          tx = new PhysicalModuleReservations(module);
        const token = tx.reserveType("parent", structuredClone(parent));
        const next = child(token.typeIndex, wrapped);
        tx.reserveType("child", recursive ? { kind: "rec", types: [next] } : next);
        tx.freezeReservations();
        tx.seal();
        expect(WebAssembly.validate(emitBinary(module) as BufferSource)).toBe(true);
      });
      it.each(finalParents)(
        `rejects extending final %s atomically, wrapped=${wrapped}, rec=${recursive}`,
        (_name, parent) => {
          const module = createEmptyModule(),
            tx = new PhysicalModuleReservations(module);
          const token = tx.reserveType("parent", structuredClone(parent));
          tx.assertTypeReservation(token);
          const before = structuredClone(module),
            next = child(token.typeIndex, wrapped);
          expect(() => tx.reserveType("child", recursive ? { kind: "rec", types: [next] } : next)).toThrow(
            "final parent",
          );
          expect(module).toStrictEqual(before);
          expect(tx.state).toBe("failed");
        },
      );
    }

  it.each([false, true])("checks members of the same unpublished rec group atomically, wrapped=%s", (wrapped) => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const before = structuredClone(module);
    expect(() => tx.reserveType("group", { kind: "rec", types: [struct(), child(0, wrapped)] })).toThrow(
      "final parent",
    );
    expect(module).toStrictEqual(before);
  });

  it("accepts an open root and its concrete leaf in one actual rec group", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    tx.reserveType("group", { kind: "rec", types: [{ ...struct(), superTypeIdx: -1 }, child(0, true)] });
    tx.freezeReservations();
    tx.seal();
    expect(WebAssembly.validate(emitBinary(module) as BufferSource)).toBe(true);
  });

  it("retains the original final self-parent ordering fixture as an atomic reservation negative", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    tx.reserveType("prefix", { kind: "struct", name: "prefix", fields: [], superTypeIdx: -1 });
    const before = structuredClone(module);
    expect(() =>
      tx.reserveType("group", {
        kind: "rec",
        types: [
          {
            kind: "sub",
            name: "holder",
            superType: 1,
            final: true,
            type: { kind: "struct", name: "inner", fields: [] },
          },
          { kind: "struct", name: "target", fields: [], superTypeIdx: -1 },
        ],
      }),
    ).toThrow("cannot extend final parent type 1");
    expect(module).toStrictEqual(before);
    expect(tx.state).toBe("failed");
  });

  it("validates a correctly ordered open parent at flattened index one and its final child", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    tx.reserveType("prefix", { kind: "struct", name: "prefix", fields: [], superTypeIdx: -1 });
    const group = tx.reserveType("group", {
      kind: "rec",
      types: [
        { kind: "struct", name: "target", fields: [], superTypeIdx: -1 },
        {
          kind: "sub",
          name: "holder",
          superType: 1,
          final: true,
          type: { kind: "struct", name: "inner", fields: [] },
        },
      ],
    });
    expect(group.typeIndex).toBe(1);
    tx.freezeReservations();
    tx.seal();
    const binary = emitBinary(module) as BufferSource;
    expect(WebAssembly.validate(binary)).toBe(true);
    expect(new WebAssembly.Instance(new WebAssembly.Module(binary))).toBeInstanceOf(WebAssembly.Instance);
  });

  it("rechecks deferred parent coordinates before allowing filling", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    tx.reserveType("pending-child", child(1, true));
    tx.internFunctionType([], []);
    expect(() => tx.freezeReservations()).toThrow("final parent");
    expect(tx.state).toBe("failed");
  });
});
