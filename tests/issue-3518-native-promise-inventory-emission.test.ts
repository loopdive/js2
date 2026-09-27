// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  scanNativePromiseConstructions,
  compareNativePromiseConstructions,
} from "../src/backend/wasmgc/resources/native-promise-inventory.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import type { TypeDef } from "../src/wasm/model/module-records.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireCompletedNativeStringLiterals,
  nativeStringLiteralReservationInventory,
} from "../src/backend/wasmgc/resources/native-string-literals.js";

const types: TypeDef[] = [
  {
    kind: "rec",
    types: [
      { kind: "struct", name: "parent", fields: [] },
      { kind: "array", name: "array", element: { kind: "i32" }, mutable: true },
    ],
  },
  { kind: "struct", name: "child", fields: [] },
];
const allocation: Instr = { op: "struct.new", typeIdx: 2 };
describe("detached bounded construction audit, not module acceptance", () => {
  it("audits genuine completed string globals against independently specified construction obligations", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const pack = reserveNativeStringLiteralResources(tx, {
      key: "audit",
      utf8Storage: false,
      literals: [{ value: "then" }],
    });
    const inventory = nativeStringLiteralReservationInventory(tx, pack);
    expect(inventory.globals).toHaveLength(1);
    expect(inventory.functions).toHaveLength(0);
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, pack);
    requireCompletedNativeStringLiterals(tx, pack);
    tx.assertCompletedReservation(inventory.globals[0]!.global);
    // Literal producer independently promises an array and its string carrier.
    const array = pack.layout.nativeStrDataTypeIdx,
      carrier = pack.layout.hashedStrTypeIdx;
    expect(carrier).toBeGreaterThanOrEqual(0);
    const expected = [
      {
        space: "global" as const,
        index: 0,
        allocations: [
          { op: "array.new_fixed" as const, typeIndex: array },
          { op: "struct.new" as const, typeIndex: carrier },
        ],
      },
    ];
    compareNativePromiseConstructions(module, expected);
    module.globals[0]!.init.push({ op: "struct.new", typeIdx: carrier });
    expect(() => tx.assertCompletedReservation(inventory.globals[0]!.global)).toThrow();
    expect(() => compareNativePromiseConstructions(module, expected)).toThrow(/sequence/);
  });
  it("counts repeated shared sibling buffers and all nested catch arms in canonical order", () => {
    const shared = [allocation];
    const body = [
      { op: "if", then: shared, else: shared },
      {
        op: "try",
        body: [],
        catches: [{ tagIdx: 0, body: [{ op: "array.new_default", typeIdx: 1 }] }],
        catchAll: shared,
      },
    ] as Instr[];
    expect(scanNativePromiseConstructions(body, types)).toEqual([
      { op: "struct.new", typeIndex: 2 },
      { op: "struct.new", typeIndex: 2 },
      { op: "array.new_default", typeIndex: 1 },
      { op: "struct.new", typeIndex: 2 },
    ]);
  });
  it("covers all four constructors using flat recursive-group coordinates", () => {
    expect(
      scanNativePromiseConstructions(
        [
          allocation,
          { op: "array.new", typeIdx: 1 },
          { op: "array.new_fixed", typeIdx: 1, length: 2 },
          { op: "array.new_default", typeIdx: 1 },
        ],
        types,
      ),
    ).toHaveLength(4);
    expect(() => scanNativePromiseConstructions([{ op: "struct.new", typeIdx: 1 }], types)).toThrow(/wrong/);
  });
  it("compares every function and global, including empty roots and unconstructed parent types", () => {
    const module = {
      types,
      functions: [{ name: "f", typeIdx: 0, locals: [], body: [allocation], exported: false }],
      globals: [{ name: "g", type: { kind: "externref" as const }, mutable: false, init: [] as Instr[] }],
    };
    const expected = [
      { space: "function" as const, index: 0, allocations: [{ op: "struct.new" as const, typeIndex: 2 }] },
      { space: "global" as const, index: 0, allocations: [] },
    ];
    compareNativePromiseConstructions(module, expected);
    expect(() => compareNativePromiseConstructions(module, expected.slice(0, 1))).toThrow(/unowned/);
    expect(() => compareNativePromiseConstructions(module, [...expected, expected[0]!])).toThrow(/duplicate/);
    expect(() =>
      compareNativePromiseConstructions(module, [...expected, { space: "global", index: 1, allocations: [] }]),
    ).toThrow(/omitted/);
    expect(() =>
      compareNativePromiseConstructions(module, [{ ...expected[0]!, allocations: [] }, expected[1]!]),
    ).toThrow(/sequence/);
    module.globals[0]!.init.push(allocation);
    expect(() => compareNativePromiseConstructions(module, expected)).toThrow(/sequence/);
  });
  it("rejects cycles, sparse arrays, malformed catches and unknown construction operations", () => {
    const cyclic: Instr[] = [];
    cyclic.push({ op: "block", body: cyclic } as Instr);
    expect(() => scanNativePromiseConstructions(cyclic, types)).toThrow(/cyclic/);
    expect(() => scanNativePromiseConstructions(new Array(1), types)).toThrow(/sparse/);
    expect(() =>
      scanNativePromiseConstructions([{ op: "try", body: [], catches: new Array(1) } as unknown as Instr], types),
    ).toThrow(/sparse/);
    expect(() =>
      scanNativePromiseConstructions([{ op: "array.new_future", typeIdx: 1 } as unknown as Instr], types),
    ).toThrow(/unsupported/);
  });
});
