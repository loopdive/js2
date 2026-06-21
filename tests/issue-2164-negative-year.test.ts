// #2164 (final slice) — standalone Date negative-year calendar fields + year width.
//
// `__date_civil_from_days` returns `packed = year*10000 + month*100 + day` with
// month/day always positive. For years < 0 the whole packed value is negative,
// and Wasm's `i64.div_s` / `i64.rem_s` truncate toward zero — which corrupted
// the year (off by one) AND the month/day (returned negative) for every
// pre-year-0 timestamp standalone. e.g. `new Date(Date.UTC(-1,0,1))`
// getUTCFullYear()/getUTCMonth()/getUTCDate() returned 0 / -99 / -99 instead of
// -1 / 0 / 1. The same packed decode feeds the pure-Wasm `toISOString` and
// `__date_format_string` helpers, so the formatters were wrong too.
//
// Fix (expressions/builtins.ts): decode the packed value with floor semantics —
// `year = floor(packed/10000)`, `mmdd = packed - year*10000` (∈ [101,1231]),
// `month = mmdd/100`, `day = mmdd%100` — applied at every decode site (the three
// calendar getters, the setUTC* component readback, and both string helpers).
//
// Separately, the human-readable formatters (toString / toUTCString /
// toDateString) had rendered out-of-[0,9999] years as the fixed ISO ±6-digit
// form (`-000001`). V8 uses a sign-prefixed, minimum-4-digit decimal there
// (`-0001`, `0099`, natural width for ≥10000) — only toISOString uses the
// ±6-digit extended form (§21.4.1.18). writeYear now emits the min-4 form.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile standalone and run a numeric `run` export. */
async function runNum(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // Pure standalone module — no host-import leak.
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

/** Compile standalone and decode the native-string result of `new Date(ts).<method>()`. */
async function dateStr(ts: number, method: string): Promise<string> {
  const src = `
    let g: string = "";
    export function build(): void { g = new Date(${ts}).${method}(); }
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

// Timestamps whose UTC year is < 0, plus boundary/positive controls. Values are
// computed via Date.UTC so the expectations track the host JS Date exactly
// (UTC-based — standalone has no timezone DB; deterministic regardless of host TZ).
const NEG_YEAR_CASES: Array<[string, number]> = [
  ["year -1", Date.UTC(-1, 5, 15, 10, 30, 45, 123)],
  ["year -100", Date.UTC(-100, 0, 1)],
  ["year -271821 (near min)", Date.UTC(-271821, 3, 20)],
];

describe("#2164 standalone Date negative-year calendar getters", () => {
  for (const [label, ts] of NEG_YEAR_CASES) {
    const ref = new Date(ts);
    it(`getUTCFullYear is correct for ${label}`, async () => {
      expect(await runNum(`export function run(): number { return new Date(${ts}).getUTCFullYear(); }`)).toBe(
        ref.getUTCFullYear(),
      );
    });
    it(`getUTCMonth is non-negative & correct for ${label}`, async () => {
      expect(await runNum(`export function run(): number { return new Date(${ts}).getUTCMonth(); }`)).toBe(
        ref.getUTCMonth(),
      );
    });
    it(`getUTCDate is non-negative & correct for ${label}`, async () => {
      expect(await runNum(`export function run(): number { return new Date(${ts}).getUTCDate(); }`)).toBe(
        ref.getUTCDate(),
      );
    });
  }

  it("positive years still decode correctly (no regression)", async () => {
    const ts = Date.UTC(2023, 5, 15);
    const ref = new Date(ts);
    expect(await runNum(`export function run(): number { return new Date(${ts}).getUTCFullYear(); }`)).toBe(
      ref.getUTCFullYear(),
    );
    expect(await runNum(`export function run(): number { return new Date(${ts}).getUTCMonth(); }`)).toBe(
      ref.getUTCMonth(),
    );
    expect(await runNum(`export function run(): number { return new Date(${ts}).getUTCDate(); }`)).toBe(
      ref.getUTCDate(),
    );
  });
});

describe("#2164 setUTC* component readback on a negative-year date", () => {
  it("setUTCMonth reads the current (negative) year back correctly", async () => {
    const ts = Date.UTC(-5, 0, 1);
    const rd = new Date(ts);
    rd.setUTCMonth(5);
    // Pack month and year into one number to assert both in a single run.
    const ref = rd.getUTCMonth() * 100000 + (rd.getUTCFullYear() + 100000);
    const got = await runNum(
      `export function run(): number { const d = new Date(${ts}); d.setUTCMonth(5); return d.getUTCMonth() * 100000 + (d.getUTCFullYear() + 100000); }`,
    );
    expect(got).toBe(ref);
  });
});

describe("#2164 standalone Date string formatters across the year range", () => {
  // (ts, method, expected) — expected strings are Node's output under `TZ=UTC`.
  // The standalone formatters always render UTC (no timezone DB), so a live
  // `new Date(ts)[m]()` reference would diverge in a non-UTC CI host for the
  // local-time forms (toString / toTimeString / toDateString). Hardcoding the
  // UTC expectations keeps the assertion TZ-independent. Boundaries exercised:
  // negative years (min-4-digit signed: `-0001`, `-0100`), sub-1000 (`0099`),
  // and large positive years where toISOString uses the +6-digit extended form
  // (`+010000`, `+275760`) but the human-readable forms use natural width
  // (`10000`, `275760`, no `+`).
  const STRING_CASES: Array<[number, string, string]> = [
    // epoch
    [0, "toISOString", "1970-01-01T00:00:00.000Z"],
    [0, "toUTCString", "Thu, 01 Jan 1970 00:00:00 GMT"],
    [0, "toString", "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)"],
    [0, "toDateString", "Thu Jan 01 1970"],
    [0, "toTimeString", "00:00:00 GMT+0000 (Coordinated Universal Time)"],
    // year -1
    [-62184461354877, "toISOString", "-000001-06-15T10:30:45.123Z"],
    [-62184461354877, "toUTCString", "Tue, 15 Jun -0001 10:30:45 GMT"],
    [-62184461354877, "toString", "Tue Jun 15 -0001 10:30:45 GMT+0000 (Coordinated Universal Time)"],
    [-62184461354877, "toDateString", "Tue Jun 15 -0001"],
    [-62184461354877, "toTimeString", "10:30:45 GMT+0000 (Coordinated Universal Time)"],
    // year -100
    [-65322892800000, "toISOString", "-000100-01-01T00:00:00.000Z"],
    [-65322892800000, "toUTCString", "Mon, 01 Jan -0100 00:00:00 GMT"],
    [-65322892800000, "toDateString", "Mon Jan 01 -0100"],
    // year -271821 (near the §21.4.1.1 minimum)
    [-8640000000000000, "toISOString", "-271821-04-20T00:00:00.000Z"],
    [-8640000000000000, "toUTCString", "Tue, 20 Apr -271821 00:00:00 GMT"],
    [-8640000000000000, "toString", "Tue Apr 20 -271821 00:00:00 GMT+0000 (Coordinated Universal Time)"],
    [-8640000000000000, "toDateString", "Tue Apr 20 -271821"],
    // year 99 (sub-1000 zero-padding to 4 digits)
    [-59042995200000, "toISOString", "0099-01-01T00:00:00.000Z"],
    [-59042995200000, "toUTCString", "Thu, 01 Jan 0099 00:00:00 GMT"],
    [-59042995200000, "toDateString", "Thu Jan 01 0099"],
    // year 10000 (ISO extended +6 digit vs natural-width human form)
    [253402300800000, "toISOString", "+010000-01-01T00:00:00.000Z"],
    [253402300800000, "toUTCString", "Sat, 01 Jan 10000 00:00:00 GMT"],
    [253402300800000, "toString", "Sat Jan 01 10000 00:00:00 GMT+0000 (Coordinated Universal Time)"],
    [253402300800000, "toDateString", "Sat Jan 01 10000"],
    // year 275760 (near the §21.4.1.1 maximum)
    [8639977881600000, "toISOString", "+275760-01-01T00:00:00.000Z"],
    [8639977881600000, "toUTCString", "Tue, 01 Jan 275760 00:00:00 GMT"],
    [8639977881600000, "toDateString", "Tue Jan 01 275760"],
    // year 2023 control
    [1686825045123, "toISOString", "2023-06-15T10:30:45.123Z"],
    [1686825045123, "toUTCString", "Thu, 15 Jun 2023 10:30:45 GMT"],
    [1686825045123, "toString", "Thu Jun 15 2023 10:30:45 GMT+0000 (Coordinated Universal Time)"],
    [1686825045123, "toDateString", "Thu Jun 15 2023"],
  ];

  for (const [ts, method, want] of STRING_CASES) {
    it(`${method} renders "${want}" for ts=${ts}`, async () => {
      expect(await dateStr(ts, method)).toBe(want);
    });
  }
});
