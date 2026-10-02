// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../src/backend/wasmgc/resources/native-object-layouts.js";
import { buildIsPrototypeOfBody } from "../src/runtime/wasmgc/values/prototype-chain-bodies.js";
/** Real Wasm recipe execution. Test carrier dispatchers exercise dependencies, not completed native provider ownership. */
function runtime() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module),
    requirements = { key: "objects" };
  const layouts = reserveNativeObjectLayouts(tx, requirements, declareNativeObjectLayouts(requirements));
  const objectTypeIdx = layouts.object.typeIndex;
  const carrier = tx.reserveType("test-carrier", {
    kind: "struct",
    name: "test-carrier",
    fields: [
      { name: "kind", type: { kind: "i32" }, mutable: false },
      { name: "parent", type: { kind: "externref" }, mutable: false },
    ],
  });
  const ext = { kind: "externref" } as const,
    i32 = { kind: "i32" } as const;
  const make = tx.reserveFunction("make", "make", { params: [ext], results: [ext] });
  const wrap = tx.reserveFunction("wrap", "wrap", { params: [i32, ext], results: [ext] });
  const walks = tx.reserveFunction("walk", "walk", { params: [ext, ext], results: [i32] });
  const dispatchers = [1, 2, 3, 4].map((k) =>
    tx.reserveFunction("dispatch" + k, "dispatch" + k, { params: [ext], results: [ext] }),
  );
  const counters = dispatchers.map((_, i) =>
    tx.reserveGlobal("count" + i, "count" + i, i32, true, [{ op: "i32.const", value: 0 }]),
  );
  tx.freezeReservations();
  for (const counter of counters) tx.fillGlobal(counter, [{ op: "i32.const", value: 0 }]);
  tx.fillFunction(make, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
        then: [{ op: "ref.null", typeIdx: objectTypeIdx }],
        else: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: objectTypeIdx }],
      },
      { op: "array.new_fixed", typeIdx: layouts.propMap.typeIndex, length: 0 },
      ...[0, 0, 0, 0].map((value): Instr => ({ op: "i32.const", value })),
      { op: "struct.new", typeIdx: objectTypeIdx },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(wrap, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "struct.new", typeIdx: carrier.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  dispatchers.forEach((fn, i) => {
    const matches: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: carrier.typeIndex },
      { op: "struct.get", typeIdx: carrier.typeIndex, fieldIdx: 0 },
      { op: "i32.const", value: i + 1 },
      { op: "i32.eq" },
    ];
    const parent: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: carrier.typeIndex },
      { op: "struct.get", typeIdx: carrier.typeIndex, fieldIdx: 1 },
      { op: "return" },
    ];
    tx.fillFunction(fn, {
      locals: [],
      body: [
        { op: "global.get", index: tx.physicalIndex(counters[i]!) },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "global.set", index: tx.physicalIndex(counters[i]!) },
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: carrier.typeIndex },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...matches, { op: "if", blockType: { kind: "empty" }, then: parent }],
        },
        ...(i < 2 ? [{ op: "ref.null.extern" } as Instr] : [{ op: "local.get", index: 0 } as Instr]),
      ],
    });
    tx.defineExport("counter-export" + i, "count" + i, counters[i]!);
  });
  const seed = { objectTypeIdx, curSlot: 3, targetSlot: 2, protoSlot: 5, candidateSlot: 1 };
  tx.fillFunction(walks, {
    locals: [
      { name: "target", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
      { name: "cur", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
      { name: "any", type: { kind: "anyref" } },
      { name: "fnctor", type: ext },
      { name: "class", type: ext },
    ],
    body: buildIsPrototypeOfBody({
      objectTypeIdx,
      objRefNull: { kind: "ref_null", typeIdx: objectTypeIdx },
      fnctor: { ...seed, startIdx: dispatchers[0]!.handle },
      classInstance: { ...seed, protoSlot: 6, startIdx: dispatchers[1]!.handle },
      protoFromFunctionIdx: dispatchers[2]!.handle,
      proxyGetTargetIdx: dispatchers[3]!.handle,
    }),
  });
  tx.defineExport("make-export", "make", make);
  tx.defineExport("wrap-export", "wrap", wrap);
  tx.defineExport("walk-export", "walk", walks);
  tx.seal();
  const bytes = emitBinary(module);
  expect(WebAssembly.validate(bytes)).toBe(true);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as unknown as {
    make(parent: unknown): unknown;
    wrap(kind: number, parent: unknown): unknown;
    walk(target: unknown, candidate: unknown): number;
    count0: WebAssembly.Global;
    count1: WebAssembly.Global;
  };
}
it("walks multiple ordinary links, excludes self and distinguishes unrelated roots", () => {
  const r = runtime(),
    root = r.make(null),
    child = r.make(root),
    leaf = r.make(child),
    other = r.make(null);
  expect(r.walk(root, child)).toBe(1);
  expect(r.walk(root, leaf)).toBe(1);
  expect(r.walk(child, leaf)).toBe(1);
  expect(r.walk(root, root)).toBe(0);
  expect(r.walk(other, leaf)).toBe(0);
});
it("compares the fnctor first link and continues its full ordinary chain without class dispatch", () => {
  const r = runtime(),
    root = r.make(null),
    child = r.make(root),
    candidate = r.wrap(1, child);
  expect(r.walk(child, candidate)).toBe(1);
  expect(r.walk(root, candidate)).toBe(1);
  expect(r.count0.value).toBe(2);
  expect(r.count1.value).toBe(0);
});
it("uses the raw candidate for class fallback only after fnctor decline", () => {
  const r = runtime(),
    root = r.make(null),
    candidate = r.wrap(2, root);
  expect(r.walk(root, candidate)).toBe(1);
  expect(r.count0.value).toBe(1);
  expect(r.count1.value).toBe(1);
});
it("declines non-object seed answers without trapping", () => {
  const r = runtime(),
    root = r.make(null);
  for (const value of [null, undefined, 7, "x", {}]) {
    expect(r.walk(root, r.wrap(1, value))).toBe(0);
    expect(r.walk(root, r.wrap(2, value))).toBe(0);
  }
});
it("canonicalizes proxy then callable target while leaving candidate identity untouched", () => {
  const r = runtime(),
    root = r.make(null),
    child = r.make(root),
    callable = r.wrap(3, root),
    proxy = r.wrap(4, callable);
  expect(r.walk(proxy, child)).toBe(1);
  expect(r.walk(root, callable)).toBe(0);
  expect(r.walk(root, proxy)).toBe(0);
});
it("preserves zero for unsupported target and candidate carriers", () => {
  const r = runtime(),
    root = r.make(null);
  for (const value of [null, undefined, 1, true, "s", {}, () => 0]) {
    expect(r.walk(value, root)).toBe(0);
    expect(r.walk(root, value)).toBe(0);
  }
});
