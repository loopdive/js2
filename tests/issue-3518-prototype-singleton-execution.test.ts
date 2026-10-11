// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { buildNativePrototypeType } from "../src/runtime/wasmgc/values/prototype-layouts.js";
import {
  buildPrototypeSingletonRead,
  type PrototypeSingletonResponse,
} from "../src/runtime/wasmgc/values/prototype-singleton-bodies.js";
/** Actual Wasm body controls, not native provider admission or descriptor-seeder completion. */
function instantiate(seeded: boolean) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const ext = { kind: "externref" } as const,
    i32 = { kind: "i32" } as const;
  const type = tx.reserveType("test:prototype", buildNativePrototypeType());
  const singleton = tx.reserveGlobal("test:singleton", "singleton", ext, true);
  const calls = tx.reserveGlobal("test:calls", "calls", i32, true);
  const getter = tx.reserveFunction("test:get", "get", { params: [ext, ext, ext], results: [ext] });
  const seed = tx.reserveFunction("test:observe-publication", "observePublication", {
    params: [i32, i32],
    results: [ext],
  });
  const count = tx.reserveFunction("test:count", "count", { params: [], results: [i32] });
  const fields = [0, 1, 2, 3, 4, 5].map((index) =>
    tx.reserveFunction(`test:field:${index}`, `field${index}`, { params: [ext], results: [index < 2 ? i32 : ext] }),
  );
  tx.freezeReservations();
  const sg = tx.physicalIndex(singleton),
    cg = tx.physicalIndex(calls);
  tx.fillGlobal(singleton, [{ op: "ref.null.extern" }]);
  tx.fillGlobal(calls, [{ op: "i32.const", value: 0 }]);
  const recipe = buildPrototypeSingletonRead(-100, type.typeIndex, sg);
  let step = recipe.next();
  while (!step.done) {
    let response: PrototypeSingletonResponse;
    switch (step.value.kind) {
      case "parent":
        response = { kind: "parent", instructions: [{ op: "local.get", index: 2 }] };
        break;
      case "member-csv":
        response = { kind: "member-csv", instructions: [{ op: "local.get", index: 0 }] };
        break;
      case "name":
        response = { kind: "name", instructions: [{ op: "local.get", index: 1 }] };
        break;
      case "seed-companion":
        response = {
          kind: "seed-companion",
          companion: seeded ? { functionIndex: seed.handle, brandOffset: 7 } : undefined,
        };
        break;
    }
    step = recipe.next(response);
  }
  tx.fillFunction(getter, { locals: [], body: step.value });
  tx.fillFunction(seed, {
    locals: [],
    body: [
      { op: "global.get", index: sg },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 7 },
      { op: "i32.ne" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 1 },
      { op: "i32.ne" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "global.get", index: cg },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "global.set", index: cg },
      // Real reentry through the singleton reader must take its cached branch.
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "call", funcIdx: getter.handle },
    ],
  });
  tx.fillFunction(count, { locals: [], body: [{ op: "global.get", index: cg }] });
  for (const [index, field] of fields.entries())
    tx.fillFunction(field, {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: type.typeIndex },
        { op: "struct.get", typeIdx: type.typeIndex, fieldIdx: index },
      ],
    });
  for (const [name, token] of Object.entries({
    get: getter,
    count,
    ...Object.fromEntries(fields.map((f, i) => [`field${i}`, f])),
  }))
    tx.defineExport(`export:${name}`, name, token);
  expect(tx.seal().completedFunctions).toBe(9);
  const compiled = new WebAssembly.Module(emitBinary(module) as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  return new WebAssembly.Instance(compiled).exports as unknown as {
    get(csv: unknown, name: unknown, parent: unknown): unknown;
    count(): number;
    [key: string]: (...args: any[]) => any;
  };
}
describe("actual prototype singleton Wasm", () => {
  for (const seeded of [false, true])
    it(`preserves fields, singleton identity and publication/reentry seeded=${seeded}`, () => {
      const x = instantiate(seeded),
        parent = { parent: true };
      const a = x.get("m,n", "Example", parent),
        b = x.get("changed", "Wrong", null);
      expect(a).toBe(b);
      expect(x.field0(a)).toBe(-100);
      expect(x.field1(a)).toBe(0);
      expect(x.field2(a)).toBe(null);
      expect(x.field3(a)).toBe(parent);
      expect(x.field4(a)).toBe("m,n");
      expect(x.field5(a)).toBe("Example");
      expect(x.count()).toBe(seeded ? 1 : 0);
    });
  it("keeps per-instance singleton storage independent", () => {
    const a = instantiate(false),
      b = instantiate(false);
    expect(Object.is(a.get("", "Object", null), b.get("", "Object", null))).toBe(false);
  });
});
