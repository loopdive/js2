// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  declareNativeRyuResources,
  reserveNativeRyuResources,
  requireNativeRyuReservations,
  fillNativeRyuResources,
  requireCompletedNativeRyu,
} from "../src/backend/wasmgc/resources/native-number-ryu.js";

function reserved(importOffset = 0) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  for (let i = 0; i < importOffset; i++)
    tx.reserveGlobalImport(`test:import:${i}`, "observations", `g${i}`, { kind: "i32" }, false);
  const strings = reserveNativeStringLiteralResources(tx, { key: "strings", utf8Storage: false, literals: [] });
  const pack = reserveNativeRyuResources(tx, "ryu", strings);
  return { module, tx, strings, pack };
}
// Exact existing issue-1537 generation order/LCG, including its DataView byte order.
// Raw nonfinite/zero inputs are recorded separately: the direct core does not admit them.
function existingCorpus() {
  let state = 0x1537abcd >>> 0;
  const rnd = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const dv = new DataView(new ArrayBuffer(8)),
    generated: number[] = [];
  for (let i = 0; i < 20000; i++) {
    dv.setUint32(0, (rnd() * 2 ** 32) >>> 0);
    dv.setUint32(4, (rnd() * 2 ** 32) >>> 0);
    generated.push(dv.getFloat64(0));
  }
  for (let k = -12; k <= 21; k++) for (let i = 0; i < 200; i++) generated.push((rnd() * 2 - 1) * Math.pow(10, k));
  for (let i = 0; i < 3000; i++) {
    dv.setUint32(0, (rnd() * 2 ** 32) >>> 0);
    dv.setUint32(4, (rnd() * 0x000fffff) >>> 0);
    generated.push(dv.getFloat64(0));
  }
  const admitted = generated.filter((value) => Number.isFinite(value) && value !== 0);
  return { generated, admitted, outsideCore: generated.length - admitted.length };
}
describe("issued native Ryū resources", () => {
  it("declares the exact six interleaved resources without duplicate signature operations", () => {
    const recipe = declareNativeRyuResources("ryu", "strings");
    expect(recipe.declarations.map((row) => row.role)).toEqual(
      ["mul-shift", "table-type", "inverse", "powers", "digits", "to-buffer"].map((role) => ["number-ryu", role]),
    );
    expect(recipe.reservationSteps).toEqual(
      recipe.declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
    );
    expect(recipe.declarations.map((row) => row.space)).toEqual([
      "function",
      "type",
      "global",
      "global",
      "function",
      "function",
    ]);
  });
  it.each(["copy", "foreign", "key", "strings"] as const)(
    "rejects %s ownership after authentic reservation",
    (kind) => {
      const a = reserved(),
        b = reserved();
      expect(() => requireNativeRyuReservations(a.tx, a.pack, "ryu", a.strings)).not.toThrow();
      expect(() =>
        requireNativeRyuReservations(
          kind === "foreign" ? b.tx : a.tx,
          kind === "copy" ? { ...a.pack } : a.pack,
          kind === "key" ? "other" : "ryu",
          kind === "strings" ? b.strings : a.strings,
        ),
      ).toThrow();
    },
  );
  it("requires freeze, canonical fills and seal; keeps 16/26/11 locals and exact tables", () => {
    const { tx, strings, pack } = reserved();
    expect(() => requireNativeRyuReservations(tx, pack, "ryu", strings)).not.toThrow();
    expect(() => requireCompletedNativeRyu(tx, pack, strings)).toThrow();
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, strings);
    fillNativeRyuResources(tx, pack);
    expect([
      pack.mulShift.object.locals.length,
      pack.digits.object.locals.length,
      pack.toBuffer.object.locals.length,
    ]).toEqual([16, 26, 11]);
    expect(pack.digits.object.locals.slice(12, 14).map((local) => local.name)).toEqual(["pad13", "pad14"]);
    expect(pack.toBuffer.object.locals[9]!.name).toBe("digoff");
    expect([pack.inverse.object.init.length, pack.powers.object.init.length]).toEqual([583, 653]);
    expect(pack.tableType.object).toEqual({
      kind: "array",
      name: "__ryu_i64_arr",
      element: { kind: "i64" },
      mutable: false,
    });
    expect(() => requireCompletedNativeRyu(tx, pack, strings)).toThrow();
    tx.seal();
    expect(() => requireCompletedNativeRyu(tx, pack, strings)).not.toThrow();
    expect(() => fillNativeRyuResources(tx, pack)).toThrow();
  });
  it("refuses copied string prerequisites before allocating any Ryū resources", () => {
    const { module, tx, strings, pack } = reserved();
    expect(() => requireNativeRyuReservations(tx, pack, "ryu", strings)).not.toThrow();
    const before = structuredClone(module);
    expect(() => reserveNativeRyuResources(tx, "other", { ...strings })).toThrow();
    expect(module).toEqual(before);
  });
  it("rejects a late helper signature in its own transaction", () => {
    const { tx, strings, pack } = reserved();
    expect(() => requireNativeRyuReservations(tx, pack, "ryu", strings)).not.toThrow();
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, strings);
    expect(() => tx.reserveFunction("late", "late", { params: [], results: [] })).toThrow();
    expect(() => requireCompletedNativeRyu(tx, pack, strings)).toThrow();
  });
  it("detects missing Ryū fills from an otherwise healthy filling transaction", () => {
    const control = reserved();
    control.tx.freezeReservations();
    fillNativeStringLiteralResources(control.tx, control.strings);
    fillNativeRyuResources(control.tx, control.pack);
    control.tx.seal();
    expect(() => requireCompletedNativeRyu(control.tx, control.pack, control.strings)).not.toThrow();
    const missing = reserved();
    missing.tx.freezeReservations();
    fillNativeStringLiteralResources(missing.tx, missing.strings);
    expect(missing.tx.state).toBe("filling");
    expect(() => missing.tx.seal()).toThrowError("physical module reservations: missing function fill ryu:mul-shift");
  });
  it.each(["locals", "body", "inverse", "powers"] as const)("rejects post-fill %s mutation at seal", (kind) => {
    const control = reserved();
    control.tx.freezeReservations();
    fillNativeStringLiteralResources(control.tx, control.strings);
    fillNativeRyuResources(control.tx, control.pack);
    control.tx.seal();
    expect(() => requireCompletedNativeRyu(control.tx, control.pack, control.strings)).not.toThrow();
    const changed = reserved();
    changed.tx.freezeReservations();
    fillNativeStringLiteralResources(changed.tx, changed.strings);
    fillNativeRyuResources(changed.tx, changed.pack);
    if (kind === "locals") changed.pack.digits.object.locals.reverse();
    else if (kind === "body") changed.pack.mulShift.object.body.push({ op: "nop" });
    else {
      const first = changed.pack[kind].object.init[0]!;
      if (first.op !== "i64.const") throw new Error("missing canonical signed limb");
      changed.pack[kind].object.init[0] = { op: "i64.const", value: first.value ^ 1n };
    }
    expect(() => changed.tx.seal()).toThrow();
  });
  it.each([0, 2])(
    "instantiates real finite/nonzero Ryū formatting with %i imported globals in two instances",
    async (importOffset) => {
      const { module, tx, strings, pack } = reserved(importOffset);
      const data = strings.layout.nativeStrDataTypeIdx;
      const buffer = tx.reserveGlobal("test:buffer", "test_buffer", { kind: "ref", typeIdx: data }, false);
      const format = tx.reserveFunction("test:format", "test_format", {
        params: [{ kind: "f64" }],
        results: [{ kind: "i32" }],
      });
      const read = tx.reserveFunction("test:read", "test_read", {
        params: [{ kind: "i32" }],
        results: [{ kind: "i32" }],
      });
      tx.freezeReservations();
      fillNativeStringLiteralResources(tx, strings);
      fillNativeRyuResources(tx, pack);
      tx.fillGlobal(buffer, [
        { op: "i32.const", value: 256 },
        { op: "array.new_default", typeIdx: data },
      ]);
      tx.fillFunction(format, {
        locals: [],
        body: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 },
          { op: "f64.const", value: 0 },
          { op: "f64.lt" },
          { op: "global.get", index: tx.physicalIndex(buffer) },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: pack.toBuffer.handle },
        ],
      });
      tx.fillFunction(read, {
        locals: [],
        body: [
          { op: "global.get", index: tx.physicalIndex(buffer) },
          { op: "local.get", index: 0 },
          { op: "array.get_u", typeIdx: data },
        ],
      });
      tx.defineExport("test:export-format", "format", format);
      tx.defineExport("test:export-read", "read", read);
      tx.defineExport("test:export-digits", "digits", pack.digits);
      tx.defineExport("test:export-mul", "mul", pack.mulShift);
      tx.seal();
      requireCompletedNativeRyu(tx, pack, strings);
      const bytes = emitBinary(module);
      const values = [
        70,
        3e9,
        -70,
        0.1 + 0.2,
        1 / 3,
        1e20,
        1e21,
        1e-6,
        1e-7,
        Number.MIN_VALUE,
        2 ** -1022,
        Number.MAX_VALUE,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER + 1,
      ];
      const corpus = existingCorpus();
      expect(corpus.generated).toHaveLength(29800);
      expect(corpus.admitted.length + corpus.outsideCore).toBe(29800);
      expect(corpus.admitted.length).toBeGreaterThan(29000);
      const imports = {
        observations: Object.fromEntries(
          Array.from({ length: importOffset }, (_, i) => [
            `g${i}`,
            new WebAssembly.Global({ value: "i32", mutable: false }, i + 17),
          ]),
        ),
      };
      for (let instanceIndex = 0; instanceIndex < 2; instanceIndex++) {
        const { instance } = await WebAssembly.instantiate(bytes, imports);
        const formatValue = instance.exports.format as (value: number) => number;
        const readUnit = instance.exports.read as (index: number) => number;
        for (let repeat = 0; repeat < 2; repeat++)
          for (const value of values) {
            const length = formatValue(value);
            expect(String.fromCharCode(...Array.from({ length }, (_, i) => readUnit(i)))).toBe(String(value));
          }
        const digits = instance.exports.digits as (value: number) => [bigint, number];
        expect(digits(70)).toEqual([7n, 1]);
        for (const value of corpus.admitted) {
          const length = formatValue(value);
          const result = String.fromCharCode(...Array.from({ length }, (_, i) => readUnit(i)));
          expect(result).toBe(String(value));
          expect(Number(result)).toBe(value);
        }
        const mul = instance.exports.mul as (m: bigint, lo: bigint, hi: bigint, shift: number) => bigint;
        for (const m of [1n, (1n << 32n) - 1n, (1n << 54n) - 1n])
          for (const lo of [0n, (1n << 64n) - 1n])
            for (const hi of [1n << 60n, (1n << 61n) - 1n])
              for (const shift of [118, 125]) {
                const signed = (n: bigint) => BigInt.asIntN(64, n);
                expect(mul(signed(m), signed(lo), signed(hi), shift)).toBe(
                  signed((m * ((hi << 64n) + lo)) >> BigInt(shift)),
                );
              }
      }
    },
  );
});
