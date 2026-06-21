// #2164 (formatters slice) — standalone Date string formatters beyond toISOString.
//
// `toString`, `toUTCString` / `toGMTString`, `toDateString`, `toTimeString`, and
// the `toLocale*` variants delegate to the `__date_format(ts, mode)` host import.
// In standalone / nativeStrings mode there is no host, so that branch previously
// emitted a single hard-coded placeholder ("Thu Jan 01 1970 00:00:00 GMT+0000")
// for ALL of them, regardless of timestamp OR format. This slice replaces the
// placeholder with a pure-Wasm `__date_format_string(ts: i64, mode: i32)` helper
// that builds each ECMA-262 §21.4.4 format directly from the millisecond
// timestamp. Standalone has no timezone DB, so every format is rendered in UTC
// (matching the deterministic-clock / UTC-for-local decisions of the earlier
// #2164 slices); the expected values below are Node's output under `TZ=UTC`.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile in standalone mode and decode a native-string formatter result back
 * to a JS string via `len`/`at` accessor exports (the raw exported `$AnyString`
 * ref reads as undefined from JS, so we reconstruct it code-unit by code-unit).
 */
async function dateFormat(method: string, ts: number): Promise<string> {
  const src = `
    let g: string = "";
    export function build(): void { g = new Date(${ts}).${method}(); }
    export function len(): number { return g.length; }
    export function at(i: number): number { return g.charCodeAt(i); }
  `;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // No host-import leak — pure standalone module.
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { build(): void; len(): number; at(i: number): number };
  ex.build();
  let s = "";
  for (let i = 0; i < ex.len(); i++) s += String.fromCharCode(ex.at(i));
  return s;
}

// (ts, expected) tuples. Expected strings are Node's `TZ=UTC` output.
const UTC_STRING: Array<[number, string]> = [
  [0, "Thu, 01 Jan 1970 00:00:00 GMT"],
  [1700000000000, "Tue, 14 Nov 2023 22:13:20 GMT"],
  [-86400000, "Wed, 31 Dec 1969 00:00:00 GMT"],
  [86399999, "Thu, 01 Jan 1970 23:59:59 GMT"],
  [1000, "Thu, 01 Jan 1970 00:00:01 GMT"],
];
const DATE_STRING: Array<[number, string]> = [
  [0, "Thu Jan 01 1970"],
  [1700000000000, "Tue Nov 14 2023"],
  [-86400000, "Wed Dec 31 1969"],
];
const TIME_STRING: Array<[number, string]> = [
  [0, "00:00:00 GMT+0000 (Coordinated Universal Time)"],
  [1700000000000, "22:13:20 GMT+0000 (Coordinated Universal Time)"],
  [86399999, "23:59:59 GMT+0000 (Coordinated Universal Time)"],
];
const FULL_STRING: Array<[number, string]> = [
  [0, "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)"],
  [1700000000000, "Tue Nov 14 2023 22:13:20 GMT+0000 (Coordinated Universal Time)"],
  [-86400000, "Wed Dec 31 1969 00:00:00 GMT+0000 (Coordinated Universal Time)"],
];

describe("#2164 (formatters) — standalone Date string formats", () => {
  it("toUTCString matches the spec format (weekday, day, month, year, time, GMT)", async () => {
    for (const [ts, want] of UTC_STRING) {
      expect(await dateFormat("toUTCString", ts), `toUTCString(${ts})`).toBe(want);
    }
  });

  it("toGMTString is an alias of toUTCString", async () => {
    expect(await dateFormat("toGMTString", 1700000000000)).toBe("Tue, 14 Nov 2023 22:13:20 GMT");
  });

  it("toDateString is WkDay Mon DD YYYY (UTC)", async () => {
    for (const [ts, want] of DATE_STRING) {
      expect(await dateFormat("toDateString", ts), `toDateString(${ts})`).toBe(want);
    }
  });

  it("toTimeString is HH:mm:ss GMT+0000 (Coordinated Universal Time)", async () => {
    for (const [ts, want] of TIME_STRING) {
      expect(await dateFormat("toTimeString", ts), `toTimeString(${ts})`).toBe(want);
    }
  });

  it("toString is the full date+time+timezone form (UTC)", async () => {
    for (const [ts, want] of FULL_STRING) {
      expect(await dateFormat("toString", ts), `toString(${ts})`).toBe(want);
    }
  });

  it("toLocaleDateString falls back to the date form (Intl-free)", async () => {
    expect(await dateFormat("toLocaleDateString", 1700000000000)).toBe("Tue Nov 14 2023");
  });

  it("toLocaleTimeString falls back to HH:mm:ss (Intl-free)", async () => {
    expect(await dateFormat("toLocaleTimeString", 1700000000000)).toBe("22:13:20");
  });

  it("toLocaleString falls back to the full string form (Intl-free)", async () => {
    expect(await dateFormat("toLocaleString", 0)).toBe(
      "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)",
    );
  });

  it("weekday is correct across positive and negative timestamps", async () => {
    // Spot-check the weekday computation: Jan 1 1970 = Thu; Nov 14 2023 = Tue;
    // Dec 31 1969 = Wed; a Sunday (Jan 4 1970 = day 3 → 3*86400000).
    expect((await dateFormat("toUTCString", 3 * 86400000)).startsWith("Sun")).toBe(true);
    expect((await dateFormat("toUTCString", 0)).startsWith("Thu")).toBe(true);
    expect((await dateFormat("toUTCString", -86400000)).startsWith("Wed")).toBe(true);
  });

  it('an Invalid Date renders the literal "Invalid Date" for every formatter', async () => {
    for (const method of ["toString", "toUTCString", "toDateString", "toTimeString"]) {
      // `new Date(NaN)` is an Invalid Date.
      const src = `
        let g: string = "";
        export function build(): void { g = new Date(NaN).${method}(); }
        export function len(): number { return g.length; }
        export function at(i: number): number { return g.charCodeAt(i); }
      `;
      const r = await compile(src, { target: "standalone" });
      expect(r.success, JSON.stringify(r.errors)).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const ex = instance.exports as { build(): void; len(): number; at(i: number): number };
      ex.build();
      let s = "";
      for (let i = 0; i < ex.len(); i++) s += String.fromCharCode(ex.at(i));
      expect(s, `${method}(Invalid Date)`).toBe("Invalid Date");
    }
  });
});
