// #2164 — standalone Date.prototype.toISOString / toJSON.
//
// The Date string formatters (`toISOString`, `toJSON`, …) delegate to the
// `__date_format(ts, mode)` host import. In standalone / nativeStrings mode
// there is no JS host, so that branch previously emitted a hard-coded
// placeholder ("1970-01-01T00:00:00.000Z") — every non-epoch `toISOString()`
// returned the wrong string. This slice replaces the placeholder with a pure
// Wasm `__date_iso_string(ts: i64) -> ref $NativeString` helper that builds the
// ECMA-262 §21.4.4.36 Date Time String Format (incl. the §21.4.1.18 extended
// ±YYYYYY year form) directly from the millisecond timestamp.
//
// toISOString throws RangeError on an Invalid Date (§21.4.4.36); toJSON returns
// null on an Invalid Date (§21.4.4.45).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile in standalone mode and run an i32-returning `run` export. */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // No host-import leak (pure standalone module).
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

/**
 * Compile in standalone mode and decode the native string `toISOString()`
 * result back to a JS string via `len`/`at` accessor exports (the standalone
 * native-string read-back idiom — the raw exported `$AnyString` ref is opaque
 * to JS).
 */
async function isoString(ts: number): Promise<string> {
  const src = `
    let g: string = "";
    export function build(): void { g = new Date(${ts}).toISOString(); }
    export function len(): number { return g.length; }
    export function at(i: number): number { return g.charCodeAt(i); }
  `;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as {
    build: () => void;
    len: () => number;
    at: (i: number) => number;
  };
  ex.build();
  let out = "";
  for (let i = 0; i < ex.len(); i++) out += String.fromCharCode(ex.at(i));
  return out;
}

describe("#2164 standalone Date.prototype.toISOString / toJSON", () => {
  // Exact-string conformance against the host JS Date for a spread of
  // timestamps the standalone calendar getters compute correctly (years 0+).
  const timestamps: Array<[string, number]> = [
    ["epoch", 0],
    ["arbitrary", 1700000000000],
    ["sub-second ms", 1577836800123],
    ["mid-day h/m/s/ms", Date.UTC(2021, 5, 15, 13, 45, 30, 7)],
    ["extended +6-digit year", Date.UTC(275760, 8, 13)],
    ["first extended year (10000)", Date.UTC(10000, 0, 1)],
    ["last 4-digit year (9999)", Date.UTC(9999, 11, 31)],
  ];
  for (const [name, ts] of timestamps) {
    it(`toISOString matches host JS for ${name}`, async () => {
      expect(await isoString(ts)).toBe(new Date(ts).toISOString());
    });
  }

  it("toISOString returns the ISO form (in-Wasm comparison)", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           return new Date(1577836800000).toISOString() === "2020-01-01T00:00:00.000Z" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("toJSON equals toISOString for a valid Date", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           return new Date(1577836800000).toJSON() === "2020-01-01T00:00:00.000Z" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("toJSON returns null for an Invalid Date", async () => {
    expect(
      await runStandalone(`export function run(): number { return new Date(NaN).toJSON() === null ? 1 : 0; }`),
    ).toBe(1);
  });

  it("toISOString throws RangeError on an Invalid Date", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           try { new Date(NaN).toISOString(); return 0; }
           catch (e) { return e instanceof RangeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });

  it("toISOString formats a pre-epoch (1969) timestamp", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           return new Date(-86400000).toISOString() === "1969-12-31T00:00:00.000Z" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("toISOString round-trips with milliseconds preserved", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           return new Date(1577836800123).toISOString() === "2020-01-01T00:00:00.123Z" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });
});
