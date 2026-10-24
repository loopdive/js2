// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeRyuResources,
  fillNativeRyuResources,
  nativeRyuBinding,
  requireCompletedNativeRyu,
} from "../src/backend/wasmgc/resources/native-number-ryu.js";
import {
  reserveNativeDecimalFormat,
  fillNativeDecimalFormat,
  nativeDecimalFormatBinding,
} from "../src/backend/wasmgc/resources/native-decimal-format.js";

function fixture(utf8Storage = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, { key: "strings", utf8Storage, literals: [] });
  const ryu = reserveNativeRyuResources(tx, "ryu", strings);
  const decimal = reserveNativeDecimalFormat(tx, "decimal", strings, ryu);
  return { module, tx, strings, ryu, decimal };
}
function fill(r: ReturnType<typeof fixture>) {
  r.tx.freezeReservations();
  fillNativeStringLiteralResources(r.tx, r.strings);
  fillNativeRyuResources(r.tx, r.ryu);
  fillNativeDecimalFormat(r.tx, r.decimal);
}
function executable(utf8Storage: boolean) {
  const r = fixture(utf8Storage),
    { tx, strings, decimal } = r;
  const length = tx.reserveFunction("observe:length", "length", {
    params: [{ kind: "externref" }],
    results: [{ kind: "i32" }],
  });
  const char = tx.reserveFunction("observe:char", "char", {
    params: [{ kind: "externref" }, { kind: "i32" }],
    results: [{ kind: "i32" }],
  });
  fill(r);
  const cast = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: strings.layout.nativeStrTypeIdx },
  ] as const;
  tx.fillFunction(length, {
    locals: [],
    body: [...cast, { op: "struct.get", typeIdx: strings.layout.nativeStrTypeIdx, fieldIdx: 0 }],
  });
  tx.fillFunction(char, {
    locals: [],
    body: [
      ...cast,
      { op: "struct.get", typeIdx: strings.layout.nativeStrTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 1 },
      { op: "array.get_u", typeIdx: strings.layout.nativeStrDataTypeIdx },
    ],
  });
  expect(nativeDecimalFormatBinding(tx, decimal, strings, true)).toBe(decimal.toString);
  expect(() => requireCompletedNativeRyu(tx, r.ryu, strings)).toThrow(/incomplete/);
  for (const [name, token] of Object.entries({ format: decimal.toString, length, char }))
    tx.defineExport("export:" + name, name, token);
  tx.seal();
  requireCompletedNativeRyu(tx, r.ryu, strings);
  const compiled = new WebAssembly.Module(emitBinary(r.module) as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toHaveLength(0);
  const api = new WebAssembly.Instance(compiled).exports as Record<string, (...args: any[]) => any>;
  return (n: number) => {
    const value = api.format(n);
    return Array.from({ length: api.length(value) }, (_, i) => String.fromCharCode(api.char(value, i))).join("");
  };
}
const edges = [
  0,
  -0,
  1,
  -1,
  9,
  10,
  99,
  100,
  4294967295,
  4294967296,
  4294967297,
  9007199254740990,
  9007199254740991,
  9007199254740992,
  1e-7,
  1e-6,
  1e20,
  1e21,
  Number.MIN_VALUE,
  Number.MAX_VALUE,
  NaN,
  Infinity,
  -Infinity,
];
const bits = new DataView(new ArrayBuffer(8));
let state = 0x123456789abcdefn;
const samples = Array.from({ length: 512 }, () => {
  state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
  bits.setBigUint64(0, state);
  return bits.getFloat64(0);
});
describe("native shared decimal formatter", () => {
  for (const utf8 of [false, true]) {
    it(`executes exact Number::toString including safe indices (utf8=${utf8})`, () => {
      const format = executable(utf8);
      for (const value of [...edges, ...samples]) expect(format(value), String(value)).toBe(String(value));
    });
  }
  it("rejects copied or mismatched borrowed Ryu producers before allocation", () => {
    const r = fixture();
    const count = r.module.functions.length;
    expect(() => reserveNativeDecimalFormat(r.tx, "copy", r.strings, { ...r.ryu })).toThrow(/foreign or copied/);
    expect(() => reserveNativeDecimalFormat(r.tx, "foreign", fixture().strings, r.ryu)).toThrow(/string dependency/);
    expect(r.module.functions).toHaveLength(count);
    expect(() => nativeDecimalFormatBinding(r.tx, { ...r.decimal }, r.strings)).toThrow(/foreign or copied/);
  });
  it("refuses unfilled producers and duplicate fill while allowing the genuine pre-seal edge", () => {
    const r = fixture();
    expect(() => nativeRyuBinding(r.tx, r.ryu, r.strings, true)).toThrow(/canonical Ryu fill/);
    fill(r);
    expect(nativeRyuBinding(r.tx, r.ryu, r.strings, true)).toBe(r.ryu.toBuffer);
    expect(() => fillNativeDecimalFormat(r.tx, r.decimal)).toThrow(/duplicate/);
  });
  for (const target of ["table", "body"] as const)
    it(`rejects changed completed Ryu ${target}`, () => {
      const r = fixture();
      fill(r);
      if (target === "table") r.ryu.inverse.object.init = [{ op: "ref.null", typeIdx: r.ryu.tableType.typeIndex }];
      else r.ryu.toBuffer.object.body = [{ op: "unreachable" }];
      expect(() => nativeDecimalFormatBinding(r.tx, r.decimal, r.strings, true)).toThrow(/altered completed/);
    });
});
