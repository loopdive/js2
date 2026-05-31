// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1321 / #1335 Phase 2 — pure-Wasm `Number.prototype.{toFixed,toPrecision,
 * toExponential}` in standalone / WASI mode.
 *
 * Under `--target wasi` / `--target standalone` there is no JS runtime to
 * satisfy the `env.number_toFixed` / `number_toPrecision` / `number_toExponential`
 * host imports, so the compiler emits WasmGC-native implementations instead
 * (see `number-format-native.ts`). Each test asserts:
 *   1. The compiled module emits ZERO `env.number_to*` host imports (so it
 *      instantiates with an empty import object — genuine standalone).
 *   2. The native formatter returns the spec-correct string (decoded via the
 *      NativeString `.length` / `.charCodeAt` accessors, which already work in
 *      standalone mode).
 *
 * Precision note: digit extraction runs in f64, so results match V8 for
 * fractionDigits / precision up to ~15 significant digits. These tests stay in
 * that range. Exact-low-digit (bignum) behaviour is deferred to #1335 Phase 2.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const FMT_IMPORT_RE = /^number_(toFixed|toPrecision|toExponential)$/;

async function fmtStandalone(expr: string, target: "wasi" | "standalone" = "wasi"): Promise<string> {
  const src = `export function len(): number { return (${expr}).length; }
export function at(i: number): number { return (${expr}).charCodeAt(i); }`;
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const fmtImports = WebAssembly.Module.imports(mod)
    .filter((i) => FMT_IMPORT_RE.test(i.name))
    .map((i) => `${i.module}::${i.name}`);
  expect(fmtImports, "no number_to* host import should be emitted in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as { len(): number; at(i: number): number };
  const len = exports.len();
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(exports.at(i));
  return out;
}

describe("#1321 standalone toFixed — no JS host imports", () => {
  it("toFixed basic", async () => {
    expect(await fmtStandalone("(3.14159).toFixed(2)")).toBe("3.14");
  });
  it("toFixed pads zeros", async () => {
    expect(await fmtStandalone("(0).toFixed(2)")).toBe("0.00");
  });
  it("toFixed(0) rounds half away from zero", async () => {
    expect(await fmtStandalone("(2.5).toFixed(0)")).toBe("3");
  });
  it("toFixed negative", async () => {
    expect(await fmtStandalone("(-1.5).toFixed(0)")).toBe("-2");
  });
  it("toFixed integer no fraction", async () => {
    expect(await fmtStandalone("(123.456).toFixed(0)")).toBe("123");
  });
  it("toFixed NaN", async () => {
    expect(await fmtStandalone("(NaN).toFixed(2)")).toBe("NaN");
  });
  it("toFixed Infinity", async () => {
    expect(await fmtStandalone("(Infinity).toFixed(2)")).toBe("Infinity");
  });
  it("toFixed -Infinity", async () => {
    expect(await fmtStandalone("(-Infinity).toFixed(2)")).toBe("-Infinity");
  });
});

describe("#1321 standalone toExponential — no JS host imports", () => {
  it("toExponential positive exponent", async () => {
    expect(await fmtStandalone("(255).toExponential(2)")).toBe("2.55e+2");
  });
  it("toExponential negative exponent", async () => {
    expect(await fmtStandalone("(0.000123).toExponential(2)")).toBe("1.23e-4");
  });
  it("toExponential zero fraction digits", async () => {
    expect(await fmtStandalone("(1).toExponential(0)")).toBe("1e+0");
  });
  it("toExponential rounds and carries exponent", async () => {
    expect(await fmtStandalone("(9.6).toExponential(0)")).toBe("1e+1");
  });
  it("toExponential -Infinity", async () => {
    expect(await fmtStandalone("(-Infinity).toExponential(2)")).toBe("-Infinity");
  });
});

describe("#1321 standalone toPrecision — no JS host imports", () => {
  it("toPrecision fixed notation", async () => {
    expect(await fmtStandalone("(123.456).toPrecision(4)")).toBe("123.5");
  });
  it("toPrecision small value uses fixed", async () => {
    expect(await fmtStandalone("(0.0001234).toPrecision(2)")).toBe("0.00012");
  });
  it("toPrecision large value uses exponential", async () => {
    expect(await fmtStandalone("(123456).toPrecision(2)")).toBe("1.2e+5");
  });
  it("toPrecision rounding bumps magnitude", async () => {
    expect(await fmtStandalone("(9.999).toPrecision(3)")).toBe("10.0");
  });
  it("toPrecision zero", async () => {
    expect(await fmtStandalone("(0).toPrecision(3)")).toBe("0.00");
  });
});

describe("#1321 standalone target parity with wasi target", () => {
  it("standalone target also emits native formatter", async () => {
    expect(await fmtStandalone("(3.14159).toFixed(2)", "standalone")).toBe("3.14");
  });
});
