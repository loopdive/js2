// #2164 (Date.parse RFC2822 extension) — standalone Date.parse of the
// RFC2822 / `toString` / `toDateString` string forms.
//
// The pure-Wasm `__date_parse` helper (date-parse-native.ts) previously handled
// only the ECMAScript Date-Time-String (ISO) grammar, so `Date.parse` of an
// RFC2822 / `toString`-shaped string ("Tue, 14 Nov 2023 22:13:20 GMT",
// "Tue Nov 14 2023 …", "Nov 14 2023") returned NaN standalone. This slice adds
// a month-name / weekday-aware arm: a leading-letter string routes to an
// RFC2822 scanner that fills the SAME field locals as the ISO scanner, so the
// shared range-validate + compose tail handles either. All forms are parsed as
// UTC (standalone has no timezone DB), matching the formatter/clock decisions
// of the earlier #2164 slices — so it ROUND-TRIPS the #1682 formatters:
// `Date.parse(d.toUTCString())` / `Date.parse(d.toString())` recover the
// timestamp (to second precision — toUTCString/toString carry no milliseconds,
// exactly like V8).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function parse(str: string): Promise<number> {
  // Escape embedded quotes/backslashes defensively (none here, but safe).
  const src = `export function run(): number { return Date.parse("${str}"); }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { run(): number }).run();
}

describe("#2164 — standalone Date.parse of RFC2822 / toString forms", () => {
  it("toUTCString form: 'Www, DD Mon YYYY HH:mm:ss GMT'", async () => {
    expect(await parse("Tue, 14 Nov 2023 22:13:20 GMT")).toBe(1700000000000);
    expect(await parse("Thu, 01 Jan 1970 00:00:00 GMT")).toBe(0);
    expect(await parse("Wed, 31 Dec 1969 00:00:00 GMT")).toBe(-86400000);
  });

  it("toString form: 'Www Mon DD YYYY HH:mm:ss GMT+0000 (…)'", async () => {
    expect(await parse("Tue Nov 14 2023 22:13:20 GMT+0000 (Coordinated Universal Time)")).toBe(1700000000000);
    expect(await parse("Thu Jan 01 1970 00:00:00 GMT+0000")).toBe(0);
  });

  it("toDateString form: 'Www Mon DD YYYY' (date only, midnight UTC)", async () => {
    expect(await parse("Tue Nov 14 2023")).toBe(1699920000000);
    expect(await parse("Thu Jan 01 1970")).toBe(0);
  });

  it("month-first, no weekday: 'Mon DD YYYY'", async () => {
    expect(await parse("Nov 14 2023")).toBe(1699920000000);
    expect(await parse("Jan 1 1970")).toBe(0);
    expect(await parse("Dec 31 1969")).toBe(-86400000);
  });

  it("an explicit ±HHMM offset is applied", async () => {
    // 2023-11-14 22:13:20 at +0100 is 21:13:20 UTC = 1700000000000 - 3600000.
    expect(await parse("Tue, 14 Nov 2023 22:13:20 +0100")).toBe(1700000000000 - 3600000);
    expect(await parse("Tue, 14 Nov 2023 22:13:20 -0030")).toBe(1700000000000 + 30 * 60000);
  });

  it("all twelve month names resolve", async () => {
    const months: Array<[string, number]> = [
      ["Jan", 0],
      ["Feb", 31],
      ["Mar", 59],
      ["Apr", 90],
      ["May", 120],
      ["Jun", 151],
      ["Jul", 181],
      ["Aug", 212],
      ["Sep", 243],
      ["Oct", 273],
      ["Nov", 304],
      ["Dec", 334],
    ];
    for (const [mon, dayOfYear] of months) {
      // <Mon> 01 1970 → dayOfYear * 86400000 (1970 is not a leap year).
      expect(await parse(`${mon} 01 1970`), mon).toBe(dayOfYear * 86400000);
    }
  });

  it("ISO forms still parse (no regression)", async () => {
    expect(await parse("2023-11-14T22:13:20Z")).toBe(1700000000000);
    expect(await parse("2023-11-14")).toBe(1699920000000);
    expect(await parse("2023-11-14T22:13:20.500Z")).toBe(1700000000500);
  });

  it("garbage / unsupported leading-letter strings are NaN, not a trap", async () => {
    expect(Number.isNaN(await parse("Hello world"))).toBe(true);
    expect(Number.isNaN(await parse("Xyz 99 2023"))).toBe(true);
  });

  it("round-trips the #1682 toUTCString/toString/toDateString formatters", async () => {
    const src = `
      export function rtUTC(ts: number): number { return Date.parse(new Date(ts).toUTCString()); }
      export function rtStr(ts: number): number { return Date.parse(new Date(ts).toString()); }
      export function rtDate(ts: number): number { return Date.parse(new Date(ts).toDateString()); }
    `;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const e = instance.exports as {
      rtUTC(ts: number): number;
      rtStr(ts: number): number;
      rtDate(ts: number): number;
    };
    // toUTCString / toString carry seconds but no ms → round-trip to the second.
    for (const ts of [0, 1700000000000, -86400000, 1000]) {
      const sec = Math.floor(ts / 1000) * 1000;
      expect(e.rtUTC(ts), `rtUTC(${ts})`).toBe(sec);
      expect(e.rtStr(ts), `rtStr(${ts})`).toBe(sec);
    }
    // toDateString drops the time entirely → round-trip to the day.
    for (const ts of [0, 1700000000000, -86400000]) {
      expect(e.rtDate(ts), `rtDate(${ts})`).toBe(Math.floor(ts / 86400000) * 86400000);
    }
  });
});
