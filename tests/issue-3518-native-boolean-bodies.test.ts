// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { buildBoxBooleanType, buildBoxNumberType } from "../src/runtime/wasmgc/values/primitive-layouts.js";
import {
  buildUnboxBooleanBody,
  buildUnboxBooleanLocals,
  buildTypeofBooleanBody,
} from "../src/runtime/wasmgc/values/boolean-bodies.js";

// Body execution controls only: these explicit test reservations do not grant
// prepared-program runtime admission or substitute for a physical value owner.
function execute() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const boolean = tx.reserveType("control:boolean", buildBoxBooleanType());
  const number = tx.reserveType("control:number", buildBoxNumberType());
  const extern = { kind: "externref" } as const,
    i32 = { kind: "i32" } as const;
  const box = tx.reserveFunction("control:box", "box", { params: [i32], results: [extern] });
  const numberBox = tx.reserveFunction("control:numberBox", "numberBox", {
    params: [{ kind: "f64" }],
    results: [extern],
  });
  const read = tx.reserveFunction("control:read", "read", { params: [extern], results: [i32] });
  const isBoolean = tx.reserveFunction("control:isBoolean", "isBoolean", { params: [extern], results: [i32] });
  tx.freezeReservations();
  tx.fillFunction(box, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "struct.new", typeIdx: boolean.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(numberBox, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "struct.new", typeIdx: number.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(read, { locals: buildUnboxBooleanLocals(), body: buildUnboxBooleanBody(boolean.typeIndex) });
  tx.fillFunction(isBoolean, { locals: [], body: buildTypeofBooleanBody(boolean.typeIndex) });
  for (const [name, token] of Object.entries({ box, numberBox, read, isBoolean }))
    tx.defineExport("export:" + name, name, token);
  expect(tx.seal().completedFunctions).toBe(4);
  const compiled = new WebAssembly.Module(emitBinary(module) as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  return new WebAssembly.Instance(compiled).exports as unknown as {
    box(x: number): unknown;
    numberBox(x: number): unknown;
    read(x: unknown): number;
    isBoolean(x: unknown): number;
  };
}
let cached: ReturnType<typeof execute> | undefined;
const actual = () => (cached ??= execute());
describe("canonical native Boolean bodies", () => {
  it.each([0, 1])("recognizes and reads Boolean carrier %i", (value) => {
    const x = actual(),
      carrier = x.box(value);
    expect(x.isBoolean(carrier)).toBe(1);
    expect(x.read(carrier)).toBe(value);
  });
  it.each([null, undefined, {}, true, false, 1, "true"])(
    "does not classify a foreign/null carrier as a native Boolean: %s",
    (value) => {
      expect(actual().isBoolean(value)).toBe(0);
      expect(actual().read(value)).toBe(0);
    },
  );
  it("preserves typed unbox semantics for a native number carrier", () => {
    const x = actual(),
      carrier = x.numberBox(1);
    expect(x.isBoolean(carrier)).toBe(0);
    expect(x.read(carrier)).toBe(0);
  });
});
