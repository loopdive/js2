// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  instantiateNativeDeclaredSignature,
  instantiateNativeDeclaredType,
  instantiateNativeDeclaredValType,
} from "../src/backend/wasmgc/resources/native-resource-declarations.js";
import type {
  NativeDeclaredType,
  NativeDeclaredValType,
} from "../src/runtime/wasmgc/values/native-resource-declaration-types.js";

function fixture(filling: boolean) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const padding = tx.reserveType("padding", { kind: "struct", name: "padding", fields: [] });
  const definition = { kind: "struct" as const, name: "element", fields: [] };
  const token = tx.reserveType("element", definition);
  if (filling) tx.freezeReservations();
  return { tx, token, padding, definition, types: new Map([[token.key, token]]) };
}

for (const filling of [false, true]) {
  it(`batches a many-reference signature without losing displaced coordinates (filling=${filling})`, () => {
    const r = fixture(filling);
    const audit = vi.spyOn(r.tx, filling ? "physicalIndices" : "assertTypeReservations");
    const ref = { kind: "ref_null", typeKey: r.token.key } as const;
    const result = instantiateNativeDeclaredSignature(r.tx, { params: Array(80).fill(ref), results: [ref] }, r.types);
    expect(result).toEqual({
      params: Array(80).fill({ kind: "ref_null", typeIdx: 1 }),
      results: [{ kind: "ref_null", typeIdx: 1 }],
    });
    expect(audit).toHaveBeenCalledTimes(1);
    // A second descriptor is freshly audited; the first result grants no cache.
    r.definition.name = "changed";
    expect(() => instantiateNativeDeclaredSignature(r.tx, { params: [ref], results: [] }, r.types)).toThrow(/altered/);
  });

  it(`checks indexed names, fields and parent in one type audit (filling=${filling})`, () => {
    const r = fixture(filling);
    const audit = vi.spyOn(r.tx, filling ? "physicalIndices" : "assertTypeReservations");
    const shape: NativeDeclaredType = {
      kind: "struct",
      name: { kind: "array-ref-index", typeKey: r.token.key },
      parent: { kind: "resource", typeKey: r.token.key },
      fields: Array.from({ length: 20 }, (_, index) => ({
        name: String(index),
        type: { kind: "ref_null" as const, typeKey: r.token.key },
        mutable: true,
      })),
    };
    const result = instantiateNativeDeclaredType(r.tx, shape, r.types);
    expect(result).toEqual({
      kind: "struct",
      name: "__arr_ref_1",
      superTypeIdx: 1,
      fields: Array.from({ length: 20 }, (_, index) => ({
        name: String(index),
        type: { kind: "ref_null", typeIdx: 1 },
        mutable: true,
      })),
    });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it(`rejects mutation after the last reference was resolved (filling=${filling})`, () => {
    const r = fixture(filling);
    const shape: NativeDeclaredType = {
      kind: "array",
      name: "array",
      element: { kind: "ref_null", typeKey: r.token.key },
      get mutable() {
        r.definition.name = "late mutation";
        return true;
      },
    };
    expect(() => instantiateNativeDeclaredType(r.tx, shape, r.types)).toThrow(/altered/);
  });

  it.each(["foreign", "copied", "missing", "substituted"])(`rejects %s references (filling=${filling})`, (kind) => {
    // A rejected owner poisons its ledger; each negative needs its own fixture.
    const r = fixture(filling);
    const shape: NativeDeclaredType = {
      kind: "array",
      name: "array",
      element: { kind: "ref_null", typeKey: r.token.key },
      mutable: true,
    };
    const types =
      kind === "foreign"
        ? fixture(filling).types
        : kind === "copied"
          ? new Map([[r.token.key, { ...r.token }]])
          : kind === "substituted"
            ? new Map([[r.token.key, r.padding]])
            : new Map();
    expect(() => instantiateNativeDeclaredType(r.tx, shape, types)).toThrow(
      /foreign|unissued|unowned|missing or substituted/,
    );
  });

  it(`rejects a physical reference in a symbolic signature (filling=${filling})`, () => {
    const r = fixture(filling);
    expect(() =>
      instantiateNativeDeclaredSignature(
        r.tx,
        { params: [{ kind: "ref", typeIdx: 1 } as unknown as NativeDeclaredValType], results: [] },
        r.types,
      ),
    ).toThrow(/physical or missing/);
  });

  it(`retains standalone value-type resolution (filling=${filling})`, () => {
    const r = fixture(filling);
    expect(instantiateNativeDeclaredValType(r.tx, { kind: "ref", typeKey: r.token.key }, r.types)).toEqual({
      kind: "ref",
      typeIdx: 1,
    });
  });
}

it("rejects a phase change caused by descriptor traversal", () => {
  const r = fixture(false);
  const shape: NativeDeclaredType = {
    kind: "array",
    name: "array",
    element: { kind: "ref_null", typeKey: r.token.key },
    get mutable() {
      r.tx.freezeReservations();
      return true;
    },
  };
  expect(() => instantiateNativeDeclaredType(r.tx, shape, r.types)).toThrow(/changed ledger phase/);
});
