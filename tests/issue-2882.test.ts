import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

// #2882 — Date.UTC (ECMA-262 §21.4.3.4) spec conformance.
//
// The prior lowering treated a missing year as 1970, skipped MakeFullYear
// (§21.4.1.27 — the 0..99 ⇒ 1900+y offset), did no MakeDay month normalization
// (§21.4.1.12 — ym = yr + floor(m/12), mn = m modulo 12), and applied neither
// non-finite propagation nor TimeClip (§21.4.1.14). It now mirrors the proven
// `new Date(y, m, …)` constructor path.
async function utc(expr: string): Promise<number> {
  const result = await compile(`export function test(): number { return ${expr}; }`);
  if (!result.success) {
    throw new Error(`Compile failed: ${result.errors.map((e) => `L${e.line}: ${e.message}`).join("; ")}`);
  }
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).test() as number;
}

describe("#2882 — Date.UTC spec conformance (§21.4.3.4)", () => {
  it("missing year ⇒ NaN (ToNumber(undefined))", async () => {
    expect(await utc("Date.UTC()")).toBeNaN();
  });

  it("NaN / non-finite components ⇒ NaN", async () => {
    expect(await utc("Date.UTC(NaN)")).toBeNaN();
    expect(await utc("Date.UTC(NaN, 0)")).toBeNaN();
    expect(await utc("Date.UTC(Infinity)")).toBeNaN();
    expect(await utc("Date.UTC(1970, NaN)")).toBeNaN();
    expect(await utc("Date.UTC(1970, 0, NaN)")).toBeNaN();
    expect(await utc("Date.UTC(1970, 0, 1, Infinity)")).toBeNaN();
    expect(await utc("Date.UTC(1970, 0, 1, 0, 0, 0, NaN)")).toBeNaN();
  });

  it("MakeFullYear: 0..99 maps to 1900+y", async () => {
    expect(await utc("Date.UTC(0, 0)")).toBe(-2208988800000); // year 1900
    expect(await utc("Date.UTC(-0.999999, 0)")).toBe(-2208988800000); // ToInteger ⇒ 0 ⇒ 1900
    expect(await utc("Date.UTC(70, 0)")).toBe(0); // year 1970
    expect(await utc("Date.UTC(99, 0)")).toBe(915148800000); // year 1999
    expect(await utc("Date.UTC(99.999999, 0)")).toBe(915148800000);
  });

  it("years outside 0..99 take no offset", async () => {
    expect(await utc("Date.UTC(100, 0)")).toBe(-59011459200000); // year 100
    expect(await utc("Date.UTC(-1, 0)")).toBe(-62198755200000); // year -1
  });

  it("MakeDay normalizes month overflow into the year", async () => {
    expect(await utc("Date.UTC(2016, 12)")).toBe(1483228800000); // Jan 2017
    expect(await utc("Date.UTC(2016, 13)")).toBe(1485907200000); // Feb 2017
    expect(await utc("Date.UTC(2016, 144)")).toBe(1830297600000); // Jan 2028
    expect(await utc("Date.UTC(2016, -1)")).toBe(1448928000000); // Dec 2015
    expect(await utc("Date.UTC(2016, -13)")).toBe(1417392000000); // Dec 2014
  });

  it("day overflow / negative day still rolls via days_from_civil", async () => {
    expect(await utc("Date.UTC(2016, 0, 33)")).toBe(1454371200000); // Feb 2 2016
    expect(await utc("Date.UTC(2016, 2, -27)")).toBe(1454371200000);
  });

  it("TimeClip: |t| == 8.64e15 is valid, beyond ⇒ NaN", async () => {
    expect(await utc("Date.UTC(275760, 8, 13, 0, 0, 0, 0)")).toBe(8640000000000000);
    expect(await utc("Date.UTC(275760, 8, 13, 0, 0, 0, 1)")).toBeNaN();
    expect(await utc("Date.UTC(-271821, 3, 20, 0, 0, 0, 0)")).toBe(-8640000000000000);
  });

  it("regression controls: ordinary timestamps unchanged", async () => {
    expect(await utc("Date.UTC(1970, 0, 1)")).toBe(0);
    expect(await utc("Date.UTC(1970, 0)")).toBe(0);
    expect(await utc("Date.UTC(2000, 0, 1)")).toBe(946684800000);
    expect(await utc("Date.UTC(2024, 1, 29)")).toBe(1709164800000); // leap day
    expect(await utc("Date.UTC(2023, 11, 31, 23, 59, 59, 999)")).toBe(1704067199999);
  });
});
