// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { buildObjectSameValueBody } from "../src/runtime/wasmgc/values/object-same-value-body.js";
import { buildBoxNumberType } from "../src/runtime/wasmgc/values/primitive-layouts.js";
import type { ValType, Instr } from "../src/wasm/model/instructions.js";
it("SameValue treats different NaN payloads as equal and signed zeros as distinct", () => {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const ext: ValType = { kind: "externref" },
    i32: ValType = { kind: "i32" };
  const number = tx.reserveType("number", buildBoxNumberType());
  const isNumber = tx.reserveFunction("isNumber", "isNumber", { params: [ext], results: [i32] });
  const unbox = tx.reserveFunction("unbox", "unbox", { params: [ext], results: [{ kind: "f64" }] });
  const no = tx.reserveFunction("no", "no", { params: [ext], results: [i32] });
  const bigEq = tx.reserveFunction("bigEq", "bigEq", {
    params: [{ kind: "anyref" }, { kind: "anyref" }],
    results: [i32],
  });
  const same = tx.reserveFunction("same", "same", { params: [ext, ext], results: [i32] });
  const run = tx.reserveFunction("run", "run", { params: [{ kind: "i64" }, { kind: "i64" }], results: [i32] });
  tx.freezeReservations();
  tx.fillFunction(isNumber, {
    locals: [],
    body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: number.typeIndex }],
  });
  tx.fillFunction(unbox, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: number.typeIndex },
      { op: "struct.get", typeIdx: number.typeIndex, fieldIdx: 0 },
    ],
  });
  for (const f of [no, bigEq]) tx.fillFunction(f, { locals: [], body: [{ op: "i32.const", value: 0 }] });
  tx.fillFunction(same, {
    locals: [
      { name: "a", type: { kind: "anyref" } },
      { name: "b", type: { kind: "anyref" } },
    ],
    body: buildObjectSameValueBody({
      typeofNumIdx: isNumber.handle,
      typeofBoolIdx: no.handle,
      typeofBigIdx: no.handle,
      unboxNumIdx: unbox.handle,
      unboxBoolIdx: no.handle,
      bigint: { kind: "carrier", equalIdx: bigEq.handle },
      anyStrTypeIdx: -1,
      strFlattenIdx: undefined,
      strEqualsIdx: undefined,
    }),
  });
  const box = (index: number): Instr[] => [
    { op: "local.get", index },
    { op: "f64.reinterpret_i64" },
    { op: "struct.new", typeIdx: number.typeIndex },
    { op: "extern.convert_any" },
  ];
  tx.fillFunction(run, { locals: [], body: [...box(0), ...box(1), { op: "call", funcIdx: same.handle }] });
  tx.defineExport("export:run", "run", run);
  tx.seal();
  const wasm = new WebAssembly.Module(emitBinary(module) as BufferSource);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  const compare = new WebAssembly.Instance(wasm, {}).exports.run as (a: bigint, b: bigint) => number;
  // Exercise the actual numeric dispatch without JS imports or JS NaN transport.
  // Non-number dependencies are inert fixtures; this does not qualify those arms.
  const bits = [
    0n,
    0x8000000000000000n,
    0x3ff0000000000000n,
    0x4000000000000000n,
    0x7ff0000000000000n,
    0xfff0000000000000n,
    0x7ff8000000000001n,
    0x7ff8000000000002n,
    0xfff8000000000001n,
  ];
  const asNumber = (bits: bigint) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, bits);
    return view.getFloat64(0);
  };
  for (const a of bits)
    for (const b of bits) {
      expect(compare(a, b), `${a.toString(16)} vs ${b.toString(16)}`).toBe(Number(Object.is(asNumber(a), asNumber(b))));
    }
});

it("replays only the exact semantic correction before historical receipts", async () => {
  const { readFileSync } = await import("node:fs");
  const { sameValueNaNPath, applySameValueNaNCorrection, beforeSameValueNaNCorrection } =
    await import("./helpers/same-value-nan-correction.js");
  const current = readFileSync(new URL("../" + sameValueNaNPath, import.meta.url), "utf8");
  const before = applySameValueNaNCorrection(current, true);
  expect(before).not.toBe(current);
  expect(applySameValueNaNCorrection(before, false)).toBe(current);
  expect(beforeSameValueNaNCorrection(sameValueNaNPath, current)).toBe(before);
  expect(beforeSameValueNaNCorrection(sameValueNaNPath, before)).toBe(before);
  for (const altered of [
    current + "\n// outside edit\n",
    current.replace('op: "f64.ne"', 'op: "f64.eq"'),
    current.replace('        { op: "i32.or" },\n', ""),
  ]) {
    expect(altered).not.toBe(current);
    expect(() => applySameValueNaNCorrection(altered, true)).toThrow("source mismatch");
  }
  expect(() => applySameValueNaNCorrection(before, true)).toThrow("source mismatch");
  expect(() => applySameValueNaNCorrection(current, false)).toThrow("source mismatch");
});
