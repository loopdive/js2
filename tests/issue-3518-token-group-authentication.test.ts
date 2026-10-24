// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { createVectorBaseType } from "../src/runtime/wasmgc/values/vector-grow-store.js";
import {
  declareNativeArgumentVectorResources,
  reserveNativeArgumentVectorResources,
  fillNativeArgumentVectorResources,
  nativeArgumentVectorReservationInventory,
} from "../src/backend/wasmgc/resources/native-argument-vectors.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeSymbolCarrierResources,
  fillNativeSymbolCarrierResources,
  nativeSymbolCarrierReservationInventory,
} from "../src/backend/wasmgc/resources/native-symbol-carrier.js";

function argumentsFixture() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const vectorBase = tx.reserveType("base", createVectorBaseType());
  const plan = declareNativeArgumentVectorResources({ key: "argv" }, { vectorBaseKey: vectorBase.key });
  const pack = reserveNativeArgumentVectorResources(tx, { key: "argv" }, { vectorBase }, plan);
  return { module, tx, pack, plan };
}

it("executes argument-vector allocation and growth after batched authentication", () => {
  const { module, tx, pack, plan } = argumentsFixture();
  const size = tx.reserveFunction("size", "size", { params: [{ kind: "externref" }], results: [{ kind: "i32" }] });
  const before = nativeArgumentVectorReservationInventory(tx, pack, plan);
  tx.freezeReservations();
  fillNativeArgumentVectorResources(tx, pack);
  tx.fillFunction(size, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: pack.carrier.typeIndex },
      { op: "struct.get", typeIdx: pack.carrier.typeIndex, fieldIdx: 0 },
    ],
  });
  expect(nativeArgumentVectorReservationInventory(tx, pack, plan)).toEqual(before);
  for (const [name, token] of [
    ["create", pack.newVector],
    ["push", pack.push],
    ["size", size],
  ] as const)
    tx.defineExport(`export:${name}`, name, token);
  tx.seal();
  expect(nativeArgumentVectorReservationInventory(tx, pack, plan)).toEqual(before);
  const wasm = new WebAssembly.Module(emitBinary(module) as BufferSource);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  const api = new WebAssembly.Instance(wasm).exports as {
    create: () => unknown;
    push: (v: unknown, x: unknown) => void;
    size: (v: unknown) => number;
  };
  const vector = api.create();
  expect(api.size(vector)).toBe(0);
  for (let i = 0; i < 40; i++) api.push(vector, { i });
  expect(api.size(vector)).toBe(40);
});

it.each(["reserving", "filling"] as const)("reaudits argument dependencies after layout comparison in %s", (phase) => {
  const { tx, pack, plan } = argumentsFixture();
  if (phase === "filling") {
    tx.freezeReservations();
    fillNativeArgumentVectorResources(tx, pack);
  }
  nativeArgumentVectorReservationInventory(tx, pack, plan);
  const base = pack.vectorBase.object,
    carrier = pack.carrier.object;
  if (base.kind !== "struct" || carrier.kind !== "struct") throw Error("fixture requires struct layouts");
  let mutated = false;
  carrier.fields = new Proxy(carrier.fields, {
    getPrototypeOf(target) {
      // Comparison inspects the prototype after the ledger's array data audit.
      if (!mutated) {
        base.name = "changed during carrier comparison";
        mutated = true;
      }
      return Reflect.getPrototypeOf(target);
    },
  });
  expect(() => nativeArgumentVectorReservationInventory(tx, pack, plan)).toThrow(/altered/);
  expect(mutated).toBe(true);
  expect(tx.state).toBe("failed");
});

it.each(["type", "global", "function"] as const)("reauthenticates Symbol %s data on each inventory request", (kind) => {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, { key: "strings", utf8Storage: false, literals: [] });
  const pack = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, strings);
  fillNativeSymbolCarrierResources(tx, pack);
  const before = nativeSymbolCarrierReservationInventory(tx, pack);
  expect(before.resources).toHaveLength(4);
  if (kind === "type") {
    const type = pack.types.symbol.object;
    if (type.kind !== "struct") throw Error("fixture requires Symbol struct");
    type.name = "changed symbol layout";
  } else if (kind === "global") pack.globals.internTable.object.mutable = false;
  else pack.functions.box.object.body.push({ op: "nop" });
  expect(() => nativeSymbolCarrierReservationInventory(tx, pack)).toThrow(/altered/);
  expect(tx.state).toBe("failed");
});
