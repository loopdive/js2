import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1688 — Number(string) must perform §7.1.4.1 StringToNumber under
// --target wasi / standalone (native strings). Before the fix the WasmGC
// string ref fell through the generic struct ToPrimitive path and yielded 0.

async function runWasi(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { fileName: "t.ts", target: "wasi" });
  if (!r.success) throw new Error("compile error: " + r.errors?.[0]?.message);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#1688 Number(string) native ToNumber under --target wasi", () => {
  it("parses a plain integer string", async () => {
    expect(await runWasi(`const s: string = "7"; return Number(s);`)).toBe(7);
  });

  it("parses a string literal argument directly", async () => {
    expect(await runWasi(`return Number("42");`)).toBe(42);
  });

  it("trims leading and trailing whitespace", async () => {
    expect(await runWasi(`const s: string = "  123  "; return Number(s);`)).toBe(123);
  });

  it("treats empty / all-whitespace as 0", async () => {
    expect(await runWasi(`const s: string = ""; return Number(s);`)).toBe(0);
    expect(await runWasi(`const s: string = "   "; return Number(s);`)).toBe(0);
  });

  it("parses fractions and exponents", async () => {
    expect(await runWasi(`const s: string = "3.14"; return Number(s);`)).toBeCloseTo(3.14, 10);
    expect(await runWasi(`const s: string = "1.5e-2"; return Number(s);`)).toBeCloseTo(0.015, 10);
    expect(await runWasi(`const s: string = "1e3"; return Number(s);`)).toBe(1000);
  });

  it("parses signed values", async () => {
    expect(await runWasi(`const s: string = "-5"; return Number(s);`)).toBe(-5);
    expect(await runWasi(`const s: string = "+8"; return Number(s);`)).toBe(8);
  });

  it("parses hex integer literals", async () => {
    expect(await runWasi(`const s: string = "0x1F"; return Number(s);`)).toBe(31);
  });

  it("parses Infinity", async () => {
    expect(await runWasi(`const s: string = "Infinity"; return Number(s);`)).toBe(Infinity);
    expect(await runWasi(`const s: string = "-Infinity"; return Number(s);`)).toBe(-Infinity);
  });

  it("returns NaN for non-numeric and trailing-junk strings", async () => {
    expect(await runWasi(`const s: string = "abc"; return Number(s);`)).toBeNaN();
    expect(await runWasi(`const s: string = "12px"; return Number(s);`)).toBeNaN();
  });
});
