// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
  requireCompletedNativeBigInt,
} from "../src/backend/wasmgc/resources/native-bigint.js";
import { buildBigIntToNumberDefinition } from "../src/runtime/wasmgc/values/bigint-to-number-body.js";

interface Runtime {
  box(value: bigint): object;
  wide(low64: bigint, sign: number, length: number): object;
  writeLimb(value: object, index: number, limb: number): void;
  read(value: object): bigint;
  number(value: unknown): number;
}

/** Actual issued carriers and real Wasm instructions, with no conversion imports. */
function runtime(offset: number): { exports: Runtime; bytes: Uint8Array; module: WebAssembly.Module } {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const prefix = Array.from({ length: offset }, (_, index) => {
    tx.reserveType(`prefix:type:${index}`, { kind: "struct", name: `Prefix${index}`, fields: [] });
    return tx.reserveFunction(`prefix:function:${index}`, `prefix${index}`, { params: [], results: [] });
  });
  const plan = declareNativeBigIntResources("bigint");
  const pack = reserveNativeBigIntResources(tx, "bigint", plan);
  const wide = tx.reserveFunction("observer:wide", "wide", {
    params: [{ kind: "i64" }, { kind: "i32" }, { kind: "i32" }],
    results: [{ kind: "externref" }],
  });
  const writeLimb = tx.reserveFunction("observer:write-limb", "writeLimb", {
    params: [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
    results: [],
  });
  const number = tx.reserveFunction("number", "number", {
    params: [{ kind: "externref" }],
    results: [{ kind: "f64" }],
  });
  tx.freezeReservations();
  for (const fn of prefix) tx.fillFunction(fn, { locals: [], body: [] });
  fillNativeBigIntResources(tx, pack);
  tx.fillFunction(wide, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "array.new_default", typeIdx: pack.limbs.typeIndex },
      { op: "struct.new", typeIdx: pack.wide.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(writeLimb, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: pack.wide.typeIndex },
      { op: "struct.get", typeIdx: pack.wide.typeIndex, fieldIdx: 2 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "array.set", typeIdx: pack.limbs.typeIndex },
    ],
  });
  tx.fillFunction(
    number,
    buildBigIntToNumberDefinition({
      narrow: pack.type.typeIndex,
      limbs: pack.limbs.typeIndex,
      wide: pack.wide.typeIndex,
    }),
  );
  requireCompletedNativeBigInt(tx, pack, plan);
  for (const [name, token] of Object.entries({ box: pack.box, read: pack.read, wide, writeLimb, number }))
    tx.defineExport(`export:${name}`, name, token);
  expect(tx.seal().completedFunctions).toBe(offset + 7);
  const bytes = emitBinary(module);
  const wasm = new WebAssembly.Module(bytes as BufferSource);
  return { bytes, module: wasm, exports: new WebAssembly.Instance(wasm).exports as unknown as Runtime };
}

const I64_MIN = -(1n << 63n),
  I64_MAX = (1n << 63n) - 1n;

/** Test construction only: mirrors the real canonical signed-i64 / sign+limbs ABI. */
function carrier(r: Runtime, value: bigint): object {
  if (value >= I64_MIN && value <= I64_MAX) return r.box(value);
  const limbs: number[] = [];
  for (let rest = value < 0n ? -value : value; rest > 0n; rest >>= 32n) limbs.push(Number(BigInt.asIntN(32, rest)));
  const result = r.wide(BigInt.asIntN(64, value), value < 0n ? -1 : 1, limbs.length);
  for (const [index, limb] of limbs.entries()) r.writeLimb(result, index, limb);
  return result;
}

function bits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

/** Oracle is native JavaScript; the implementation runs entirely inside Wasm. */
function assertConversion(r: Runtime, value: bigint): void {
  const expected = Number(value),
    actual = r.number(carrier(r, value));
  expect(actual).toBe(expected);
  expect(bits(actual)).toBe(bits(expected));
}

const fixedCases: readonly [string, bigint][] = [
  ["zero", 0n],
  ["negative zero is still BigInt zero", -0n],
  ["one", 1n],
  ["minus one", -1n],
  ["i31 maximum", (1n << 30n) - 1n],
  ["i31 minimum", -(1n << 30n)],
  ...[-3n, -2n, -1n, 0n, 1n, 2n, 3n, 4n, 5n].flatMap((delta): [string, bigint][] => [
    [`2^53 ${delta < 0n ? "" : "+"}${delta}`, (1n << 53n) + delta],
    [`negative 2^53 ${delta < 0n ? "" : "+"}${delta}`, -((1n << 53n) + delta)],
  ]),
  ...[-2n, -1n, 0n, 1n, 2n].flatMap((delta): [string, bigint][] => [
    [`i64 minimum offset ${delta}`, I64_MIN + delta],
    [`i64 maximum offset ${delta}`, I64_MAX + delta],
  ]),
  ["unsigned i64 maximum", (1n << 64n) - 1n],
  ["2^64", 1n << 64n],
  ["negative unsigned i64 maximum", -((1n << 64n) - 1n)],
  ["negative 2^64", -(1n << 64n)],
];

// Positions 31/0 around a limb boundary are deliberate: the guard-bit mask
// must not discard the previous limb or accidentally include the guard itself.
const tieExponents = [64, 65, 83, 84, 85, 95, 96, 115, 116, 117, 127, 255, 511, 1023];
const tieCases = tieExponents.flatMap((exponent) => [0n, 1n].map((odd) => ({ exponent, odd })));
const carryExponents = [64, 84, 85, 95, 127, 255, 511, 1022, 1023];
const limbCounts = [2, 3, 4, 5, 8, 16, 31, 32, 33, 64, 513];

/** Fixed xorshift corpus, independent of the implementation's rounding algorithm. */
function variedMagnitude(limbs: number, seed: number): bigint {
  let state = seed | 0,
    result = 0n;
  for (let index = 0; index < limbs; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    let word = state >>> 0;
    if (index === limbs - 1) {
      const topBit = (seed * 7) & 31;
      word = (word & (0xffffffff >>> (31 - topBit))) | (1 << topBit);
    }
    result |= BigInt(word >>> 0) << BigInt(index * 32);
  }
  return result;
}

describe.each([0, 4])("full-width BigInt to binary64 with coordinate offset %i", (offset) => {
  let f: ReturnType<typeof runtime>, r: Runtime;
  beforeAll(() => {
    f = runtime(offset);
    r = f.exports;
  });

  it("validates the actual emitted module with no host imports", () => {
    expect(WebAssembly.validate(f.bytes as BufferSource)).toBe(true);
    expect(WebAssembly.Module.imports(f.module)).toEqual([]);
  });

  it.each(fixedCases)("converts %s exactly like native Number(BigInt)", (_name, value) => assertConversion(r, value));

  it.each(tieCases)("rounds midpoint and both neighbors at exponent $exponent, low bit $odd", ({ exponent, odd }) => {
    const shift = BigInt(exponent - 52),
      q = (1n << 52n) + 2n + odd;
    const midpoint = (q << shift) + (1n << (shift - 1n));
    for (const delta of [-1n, 0n, 1n]) {
      assertConversion(r, midpoint + delta);
      assertConversion(r, -(midpoint + delta));
    }
  });

  it.each(carryExponents)("carries rounding into the next exponent after %i", (exponent) => {
    const shift = BigInt(exponent - 52);
    const midpoint = (((1n << 53n) - 1n) << shift) + (1n << (shift - 1n));
    for (const delta of [-1n, 0n, 1n]) {
      assertConversion(r, midpoint + delta);
      assertConversion(r, -(midpoint + delta));
    }
  });

  it("distinguishes maximum finite, the overflow midpoint and larger exponents", () => {
    const largest = ((1n << 53n) - 1n) << 971n;
    const midpoint = largest + (1n << 970n);
    expect(r.number(carrier(r, largest))).toBe(Number.MAX_VALUE);
    expect(r.number(carrier(r, midpoint - 1n))).toBe(Number.MAX_VALUE);
    expect(r.number(carrier(r, midpoint))).toBe(Infinity);
    expect(r.number(carrier(r, -midpoint))).toBe(-Infinity);
    for (const value of [largest, midpoint - 1n, midpoint, midpoint + 1n, 1n << 1024n, 1n << 2048n, 1n << 16384n]) {
      assertConversion(r, value);
      assertConversion(r, -value);
    }
  });

  it("distinguishes high magnitudes with identical low signed 64 bits", () => {
    const values = [(1n << 64n) + 7n, (1n << 96n) + 7n, (1n << 1023n) + 7n];
    const objects = values.map((value) => carrier(r, value));
    expect(objects.map((value) => r.read(value))).toEqual([7n, 7n, 7n]);
    const numbers = objects.map((value) => r.number(value));
    expect(new Set(numbers).size).toBe(3);
    for (const value of values) {
      assertConversion(r, value);
      assertConversion(r, -value);
    }
  });

  it("reads the actual magnitude on each call rather than the stored low64", () => {
    const original = (1n << 96n) + 1n,
      changed = (3n << 96n) + 1n;
    const value = carrier(r, original);
    expect(r.number(value)).toBe(Number(original));
    r.writeLimb(value, 3, 3);
    expect(r.read(value)).toBe(1n);
    expect(r.number(value)).toBe(Number(changed));
  });

  it.each(limbCounts)("matches deterministic varied canonical magnitudes with %i limbs", (limbs) => {
    for (let seed = 1; seed <= 8; seed++) {
      const magnitude = variedMagnitude(limbs, seed);
      assertConversion(r, magnitude);
      assertConversion(r, -magnitude);
    }
  });

  it.each([null, undefined, {}, 0, 1n, "1", true, Symbol("foreign")])(
    "rejects noncarrier %s without a host fallback",
    (value) => {
      expect(() => r.number(value)).toThrow(WebAssembly.RuntimeError);
    },
  );
});

it("accepts real canonical carriers from a separately emitted module at different coordinates", () => {
  const producer = runtime(0).exports,
    consumer = runtime(4).exports;
  for (const value of [0n, I64_MIN, I64_MAX, 1n << 63n, (1n << 96n) + 7n, -((1n << 1000n) + 1n)]) {
    const actual = consumer.number(carrier(producer, value));
    expect(actual).toBe(Number(value));
    expect(bits(actual)).toBe(bits(Number(value)));
  }
});

describe("BigInt conversion layout capture", () => {
  it.each(["narrow", "limbs", "wide"] as const)(
    "rejects unresolved and accessor %s coordinates without getters",
    (key) => {
      const valid = { narrow: 0, limbs: 1, wide: 2 };
      expect(buildBigIntToNumberDefinition(valid).body.length).toBeGreaterThan(0);
      for (const value of [undefined, null, -1, 0.5, NaN, 0x100000000])
        expect(() => buildBigIntToNumberDefinition({ ...valid, [key]: value } as typeof valid)).toThrow();
      let reads = 0;
      Object.defineProperty(valid, key, {
        get: () => {
          reads++;
          return 0;
        },
      });
      expect(() => buildBigIntToNumberDefinition(valid)).toThrow();
      expect(reads).toBe(0);
    },
  );
  it("rejects hidden, inherited, extra and symbol fields", () => {
    const valid = { narrow: 0, limbs: 1, wide: 2 };
    for (const bad of [
      Object.create(valid),
      { ...valid, extra: 3 },
      { ...valid, [Symbol("extra")]: 3 },
      Object.defineProperty({ ...valid }, "wide", { enumerable: false }),
    ])
      expect(() => buildBigIntToNumberDefinition(bad)).toThrow();
    expect(buildBigIntToNumberDefinition(Object.assign(Object.create(null), valid))).toEqual(
      buildBigIntToNumberDefinition(valid),
    );
  });
});
