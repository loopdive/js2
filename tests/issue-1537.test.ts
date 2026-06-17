// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1537 — Wasm-native shortest-roundtrip number formatting (Ryū core).
 *
 * Under `--target wasi` / `--target standalone` there is no JS host to satisfy
 * the `number_toString` import, so the compiler emits a WasmGC-native shortest-
 * decimal formatter. Before this issue the standalone `Number.prototype
 * .toString()` used a fixed six-fractional-digit expansion that did NOT produce
 * the ECMA-262 §6.1.6.1.13 shortest decimal (`String(0.1+0.2)` gave `"0.3"`,
 * `1/3` truncated to `"0.333333"`, `1e21` printed in full, `1e-7` underflowed to
 * `"0"`). The Ryū port (`src/codegen/number-ryu.ts`) replaces the fractional /
 * unsafe-magnitude branch with the shortest-roundtrip algorithm whose output
 * matches V8 exactly.
 *
 * These tests compile in standalone (`target: "wasi"`) mode and decode the
 * NativeString result via the `.length` / `.charCodeAt(i)` accessors (which work
 * host-free), then assert `=== String(value)` — V8 is the ground-truth shortest
 * oracle. A seeded property test sweeps random f64 bit patterns, scaled
 * magnitudes, and subnormals.
 *
 * Spec: ECMA-262 §6.1.6.1.13 (Number::toString).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Host-import names that must NOT appear once the Ryū formatter is used. */
const HOST_NUMBER_IMPORT_RE = /^number_toString$/;

/**
 * Compile `(<expr>).toString()` in standalone mode, instantiate host-free, and
 * read back the produced NativeString. `expr` is a TS expression evaluating to a
 * number. Asserts no `number_toString` host import is emitted.
 */
async function strStandalone(expr: string, target: "wasi" | "standalone" = "wasi"): Promise<string> {
  const src = `export function len(): number { return ((${expr}).toString()).length; }
export function at(i: number): number { return ((${expr}).toString()).charCodeAt(i); }`;
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const hostImports = WebAssembly.Module.imports(mod)
    .filter((i) => HOST_NUMBER_IMPORT_RE.test(i.name))
    .map((i) => `${i.module}::${i.name}`);
  expect(hostImports, "no number_toString host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as { len(): number; at(i: number): number };
  const len = exports.len();
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(exports.at(i));
  return out;
}

describe("#1537 standalone shortest-roundtrip toString — boundary cases", () => {
  // The headline regressions the Ryū core fixes.
  it("0.1 + 0.2 → shortest 0.30000000000000004 (not 0.3)", async () => {
    expect(await strStandalone("0.1 + 0.2")).toBe("0.30000000000000004");
  });
  it("1/3 → full 0.3333333333333333 (not truncated to 6 digits)", async () => {
    expect(await strStandalone("1 / 3")).toBe("0.3333333333333333");
  });
  it("1e21 → exponential 1e+21 (engineering threshold)", async () => {
    expect(await strStandalone("1e21")).toBe("1e+21");
  });
  it("1e-7 → exponential 1e-7 (not underflow to 0)", async () => {
    expect(await strStandalone("1e-7")).toBe("1e-7");
  });
  it("1e20 → fixed 100000000000000000000", async () => {
    expect(await strStandalone("1e20")).toBe("100000000000000000000");
  });

  // Simple values.
  it("0.1", async () => expect(await strStandalone("0.1")).toBe("0.1"));
  it("0.2", async () => expect(await strStandalone("0.2")).toBe("0.2"));
  it("0.3", async () => expect(await strStandalone("0.3")).toBe("0.3"));
  it("0.5", async () => expect(await strStandalone("0.5")).toBe("0.5"));
  it("1.005", async () => expect(await strStandalone("1.005")).toBe("1.005"));
  it("123.456", async () => expect(await strStandalone("123.456")).toBe("123.456"));
  it("3.14159", async () => expect(await strStandalone("3.14159")).toBe("3.14159"));
  it("9.6", async () => expect(await strStandalone("9.6")).toBe("9.6"));
  it("9.999", async () => expect(await strStandalone("9.999")).toBe("9.999"));

  // Safe integers (delegate to the radix-10 fast path).
  it("0", async () => expect(await strStandalone("0")).toBe("0"));
  it("42", async () => expect(await strStandalone("42")).toBe("42"));
  it("100", async () => expect(await strStandalone("100")).toBe("100"));
  it("123456", async () => expect(await strStandalone("123456")).toBe("123456"));

  // 2^53 rounding boundary.
  it("9007199254740993 → 9007199254740992 (2^53+1 rounds)", async () => {
    expect(await strStandalone("9007199254740993")).toBe("9007199254740992");
  });

  // Extremes.
  it("Number.MIN_VALUE (5e-324, min subnormal)", async () => {
    expect(await strStandalone("5e-324")).toBe("5e-324");
  });
  it("4.9e-324 (rounds to min subnormal 5e-324)", async () => {
    expect(await strStandalone("4.9e-324")).toBe("5e-324");
  });
  it("Number.MAX_VALUE (1.7976931348623157e+308)", async () => {
    expect(await strStandalone("1.7976931348623157e308")).toBe("1.7976931348623157e+308");
  });
  it("min normal 2.2250738585072014e-308", async () => {
    expect(await strStandalone("2.2250738585072014e-308")).toBe("2.2250738585072014e-308");
  });
  it("1e100", async () => expect(await strStandalone("1e100")).toBe("1e+100"));
  it("1e-100", async () => expect(await strStandalone("1e-100")).toBe("1e-100"));

  // Negative sign handling across all formatting cases.
  it("-0.1 (fixed)", async () => expect(await strStandalone("-0.1")).toBe("-0.1"));
  it("-1.5 (integer-ish)", async () => expect(await strStandalone("-1.5")).toBe("-1.5"));
  it("-1e21 (exponential)", async () => expect(await strStandalone("-1e21")).toBe("-1e+21"));
  it("-1e-7 (exponential)", async () => expect(await strStandalone("-1e-7")).toBe("-1e-7"));
  it("-123.456 (fixed)", async () => expect(await strStandalone("-123.456")).toBe("-123.456"));
  it("-5e-324 (negative min subnormal)", async () => {
    expect(await strStandalone("-5e-324")).toBe("-5e-324");
  });
});

describe("#1537 standalone target parity with wasi target", () => {
  it("standalone target also uses the Ryū formatter", async () => {
    expect(await strStandalone("0.1 + 0.2", "standalone")).toBe("0.30000000000000004");
  });
});

describe("#1537 property test — shortest === V8 over random f64", () => {
  // One compiled module exposes slen/sat over an f64 parameter, so the sweep
  // does not pay a compile per value.
  async function buildOracle(): Promise<(x: number) => string> {
    const src = `export function slen(x: number): number { return (x.toString()).length; }
export function sat(x: number, i: number): number { return (x.toString()).charCodeAt(i); }`;
    const r = await compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as { slen(x: number): number; sat(x: number, i: number): number };
    return (x: number) => {
      const len = ex.slen(x);
      let out = "";
      for (let i = 0; i < len; i++) out += String.fromCharCode(ex.sat(x, i));
      return out;
    };
  }

  // Deterministic LCG so failures reproduce.
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  it("round-trips & matches String() over 30k random bit patterns + scaled magnitudes + subnormals", async () => {
    const ryu = await buildOracle();
    const rnd = makeRng(0x1537abcd);
    const dv = new DataView(new ArrayBuffer(8));
    const fails: string[] = [];

    const check = (x: number): void => {
      if (!Number.isFinite(x) || x === 0) return;
      const got = ryu(x);
      const want = String(x);
      if (got !== want && fails.length < 20) fails.push(`String(${want}) but Wasm gave ${got}`);
    };

    // (1) random raw bit patterns
    for (let i = 0; i < 20000; i++) {
      dv.setUint32(0, (rnd() * 2 ** 32) >>> 0);
      dv.setUint32(4, (rnd() * 2 ** 32) >>> 0);
      check(dv.getFloat64(0));
    }
    // (2) scaled magnitudes across the decimal range (the "normal" numbers)
    for (let k = -12; k <= 21; k++) {
      for (let i = 0; i < 200; i++) {
        check((rnd() * 2 - 1) * Math.pow(10, k));
      }
    }
    // (3) subnormals (biased exponent == 0)
    for (let i = 0; i < 3000; i++) {
      dv.setUint32(0, (rnd() * 2 ** 32) >>> 0);
      dv.setUint32(4, (rnd() * 0x000fffff) >>> 0);
      check(dv.getFloat64(0));
    }

    expect(fails, fails.join("\n")).toEqual([]);
  });
});
