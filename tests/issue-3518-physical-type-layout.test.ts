// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule, type TypeDef, type StructTypeDef } from "../src/ir/types.js";
import { indexPhysicalTypes, planPhysicalTypeSection } from "../src/wasm/physical/type-layout.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { computeRecGroups } from "../src/emit/binary.js";

const struct = (name = "s"): StructTypeDef => ({ kind: "struct", name, fields: [] });
const ref = (index: number): TypeDef => ({
  kind: "array",
  name: "a",
  element: { kind: "ref_null", typeIdx: index },
  mutable: true,
});
const plan = (types: TypeDef[], forced: ReadonlyArray<readonly [number, number]> = []) =>
  planPhysicalTypeSection(indexPhysicalTypes(types), forced);

describe("physical type indexing and group identity", () => {
  it("retains exact definitions and distinguishes record, member and type coordinates", () => {
    const prefix = struct("prefix"),
      a = ref(2),
      b = struct("b"),
      tail = struct("tail");
    const table = indexPhysicalTypes([prefix, { kind: "rec", types: [a, b] }, tail]);
    expect(
      table.entries.map(({ typeIndex, recordIndex, memberIndex }) => [typeIndex, recordIndex, memberIndex]),
    ).toEqual([
      [0, 0, undefined],
      [1, 1, 0],
      [2, 1, 1],
      [3, 2, undefined],
    ]);
    [prefix, a, b, tail].forEach((definition, index) => expect(table.entries[index]!.definition).toBe(definition));
    expect(table.recordRanges).toEqual([
      { start: 0, end: 0, recordIndex: 0 },
      { start: 1, end: 2, recordIndex: 1 },
      { start: 3, end: 3, recordIndex: 2 },
    ]);
    expect(table.explicitGroups).toEqual([{ start: 1, end: 2, recordIndex: 1 }]);
    expect(planPhysicalTypeSection(table).groups).toEqual([
      { start: 0, end: 0, recursive: false },
      { start: 1, end: 2, recursive: true, explicitRecordIndex: 1 },
      { start: 3, end: 3, recursive: false },
    ]);
  });

  it("permits future references while indexing but rejects unresolved references in a final plan", () => {
    const table = indexPhysicalTypes([ref(1)]);
    expect(table.entries).toHaveLength(1);
    expect(() => planPhysicalTypeSection(table)).toThrow("type index out of range");
    expect(plan([ref(1), struct()]).groups).toEqual([{ start: 0, end: 1, recursive: true }]);
  });

  it("retains historical ordinary forward closure and singleton encoding", () => {
    expect(computeRecGroups([ref(2), ref(3), struct(), struct(), ref(4)])).toEqual([
      [0, 3],
      [4, 4],
    ]);
    expect(plan([ref(0)]).groups[0]!.recursive).toBe(false);
    expect(plan([{ kind: "rec", types: [ref(0)] }]).groups[0]).toEqual({
      start: 0,
      end: 0,
      recursive: true,
      explicitRecordIndex: 0,
    });
  });

  it("keeps ordinary closure disjoint from multiple explicit groups", () => {
    expect(
      plan([{ kind: "rec", types: [struct()] }, ref(2), struct(), { kind: "rec", types: [ref(0), ref(3)] }]).groups.map(
        ({ start, end }) => [start, end],
      ),
    ).toEqual([
      [0, 0],
      [1, 2],
      [3, 4],
    ]);
  });

  for (const [name, types] of [
    ["empty", [{ kind: "rec", types: [] }]],
    ["sparse", [{ kind: "rec", types: new Array(1) }]],
    ["missing", [{ kind: "rec", types: [undefined] }]],
    ["nested rec", [{ kind: "rec", types: [{ kind: "rec", types: [struct()] }] }]],
    [
      "double subtype",
      [
        {
          kind: "sub",
          name: "s",
          superType: null,
          final: true,
          type: { kind: "struct", name: "s", fields: [], superTypeIdx: -1 },
        },
      ],
    ],
    [
      "nested sub",
      [
        {
          kind: "sub",
          name: "s",
          superType: null,
          final: true,
          type: { kind: "sub", name: "s", superType: null, final: true, type: struct() },
        },
      ],
    ],
  ] as const) {
    it(`rejects ${name} members at indexing`, () => {
      expect(() => indexPhysicalTypes(types as unknown as TypeDef[])).toThrow();
    });
  }

  for (const [name, types] of [
    ["prefix into group", [ref(1), { kind: "rec", types: [struct()] }]],
    ["group into suffix", [{ kind: "rec", types: [ref(1)] }, struct()]],
    [
      "group into next group",
      [
        { kind: "rec", types: [ref(1)] },
        { kind: "rec", types: [struct()] },
      ],
    ],
  ] as const) {
    it(`rejects ${name} without changing explicit identity`, () => {
      expect(() => plan(types as unknown as TypeDef[])).toThrow("merge an explicit rec group");
    });
  }

  for (const forced of [[[0, 1]], [[2, 3]], [[0, 3]], [[1, 1]]] as const) {
    it(`rejects forced explicit overlap ${JSON.stringify(forced)}`, () => {
      expect(() => plan([struct(), { kind: "rec", types: [struct(), struct()] }, struct()], forced)).toThrow(
        "split or merge an explicit rec group",
      );
    });
  }

  it("accepts exact explicit and disjoint forced ranges, refusing ordinary enlargement", () => {
    expect(
      plan(
        [struct(), struct(), { kind: "rec", types: [struct(), struct()] }, struct(), struct()],
        [
          [0, 1],
          [2, 3],
          [4, 5],
        ],
      ).groups.map(({ start, end }) => [start, end]),
    ).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    expect(() => plan([ref(2), struct(), struct()], [[0, 1]])).toThrow("merged with an adjacent type");
    expect(() => plan([struct()], [[0, 1]])).toThrow("out of range");
  });

  for (const parent of [0, 1]) {
    for (const wrapper of [false, true]) {
      it(`rejects ${parent ? "forward" : "self"} inheritance, wrapper=${wrapper}`, () => {
        const child: TypeDef = wrapper
          ? { kind: "sub", name: "child", final: true, superType: parent, type: struct() }
          : { kind: "struct", name: "child", fields: [], superTypeIdx: parent };
        expect(() => plan([{ kind: "rec", types: [child, struct()] }])).toThrow("must precede subtype");
      });
    }
  }

  for (const replacement of ["member", "payload", "descriptor"] as const) {
    it(`rejects equal-content ${replacement} substitution after freeze`, () => {
      const module = createEmptyModule();
      const tx = new PhysicalModuleReservations(module);
      const member: TypeDef = {
        kind: "sub",
        name: "child",
        final: true,
        superType: null,
        type: { kind: "struct", name: "inner", fields: [] },
      };
      const group: TypeDef = { kind: "rec", types: [member] };
      tx.reserveType("group", group);
      tx.reserveCanonicalRuntimeRecGroup("canonical", { start: 0, end: 0, abiVersion: 2 });
      tx.freezeReservations();
      if (replacement === "member") group.types[0] = { ...member };
      else if (replacement === "payload") member.type = { ...member.type };
      else module.canonicalRuntimeRecGroup = { ...module.canonicalRuntimeRecGroup! };
      expect(() => tx.seal()).toThrow(/substituted/);
      expect(tx.state).toBe("failed");
    });
  }
});
