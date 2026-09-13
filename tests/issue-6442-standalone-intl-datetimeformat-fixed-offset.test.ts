// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6442 (#5383 S9) — the standalone `Intl.DateTimeFormat` for the TABLE-FREE
// zones, which is what the compiled Temporal provider needs to resolve `UTC`.
//
// Base measurement (this branch's merge base, PR #5875 / S8): the shim's
// `DateTimeFormat` constructor threw unconditionally, so `hr`'s `try/catch`
// answered `undefined` and 62 of the 116 linked
// `Temporal/ZonedDateTime/prototype/**` failures were
// `RangeError: unknown time zone UTC`. Every assertion below that reads a
// value FAILS on that tree — the constructor throws before producing one.
//
// The oracle here is the REAL ICU implementation in the test runner's own
// `Intl`, not a table of expected strings: a hand-written expectation table is
// exactly how the en-US pattern, the POSIX sign of `Etc/GMT+1` and the `1 - y`
// BC year get memorialised wrong.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { standaloneIntlDateTimeFormatSource } from "../src/standalone-intl-datetimeformat.js";
import { standaloneIntlShimSource } from "../src/temporal-intl-shim.js";

/** The option bag the polyfill's `ht()` builds, verbatim. */
const HT_OPTIONS = {
  hour12: false,
  era: "short",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
} as const;

interface DTF {
  format(value: number): string;
  formatToParts(value: number): { type: string; value: string }[];
  resolvedOptions(): Record<string, unknown>;
  formatRange(a: number, b: number): string;
}
type DTFCtor = new (locales?: unknown, options?: unknown) => DTF;

/** Evaluate the generated shim source and hand back its `Intl.DateTimeFormat`. */
function shimDateTimeFormat(): DTFCtor {
  const intl = new Function(`${standaloneIntlShimSource()}\nreturn Intl;`)() as { DateTimeFormat: DTFCtor };
  return intl.DateTimeFormat;
}

const icu = (tz: string) => new Intl.DateTimeFormat("en-us", { timeZone: tz, ...HT_OPTIONS });

describe("#6442 — the shim's DateTimeFormat answers the table-free zones", () => {
  it("`ht()`'s option bag on UTC produces ICU's exact string, parts and resolvedOptions", () => {
    const DateTimeFormatShim = shimDateTimeFormat();
    const mine = new DateTimeFormatShim("en-us", { timeZone: "utc", ...HT_OPTIONS });
    const real = icu("utc");
    // `ht()` lowercases the identifier before constructing (`Ao`), so the
    // lowercase spelling is the one that actually reaches this.
    expect(mine.format(0)).toBe(real.format(0));
    expect(mine.format(0)).toBe("1/1/1970 AD, 00:00:00");
    expect(mine.resolvedOptions()).toEqual(real.resolvedOptions());
    expect(mine.formatToParts(0)).toEqual(real.formatToParts(0));
  });

  it("the bare constructor — `Uo()`'s system-zone read — matches ICU's default record", () => {
    const DateTimeFormatShim = shimDateTimeFormat();
    // The runner's own zone is not necessarily UTC; only the SHAPE and the
    // defaulted fields are comparable, plus our declared answer for the zone.
    const mine = new DateTimeFormatShim().resolvedOptions();
    const real = new Intl.DateTimeFormat().resolvedOptions() as unknown as Record<string, unknown>;
    expect(Object.keys(mine)).toEqual(Object.keys(real));
    expect(mine.timeZone).toBe("UTC");
    expect({ ...mine, timeZone: undefined }).toEqual({ ...real, timeZone: undefined });
  });

  it("every accepted spelling agrees with ICU, and the POSIX sign of Etc/GMT±N is not inverted", () => {
    const DateTimeFormatShim = shimDateTimeFormat();
    const ACCEPTED = [
      "utc",
      "UTC",
      "Utc",
      "etc/utc",
      "etc/gmt",
      "gmt",
      "GMT",
      "greenwich",
      "etc/greenwich",
      "zulu",
      "etc/zulu",
      "universal",
      "etc/universal",
      "gmt0",
      "etc/gmt0",
      "gmt+0",
      "gmt-0",
      "etc/gmt+0",
      "etc/gmt-0",
      "Etc/GMT+1",
      "etc/gmt+1",
      "ETC/GMT+1",
      "etc/gmt-1",
      "etc/gmt+12",
      "etc/gmt-14",
    ];
    const MS = [0, 1, -1, -1000, 86399999, 86400000, -86400000, -8640000000000000, 8640000000000000, -62167219200000];
    for (const tz of ACCEPTED) {
      const mine = new DateTimeFormatShim("en-us", { timeZone: tz, ...HT_OPTIONS });
      const real = icu(tz);
      expect(`${tz}: ${mine.resolvedOptions().timeZone}`).toBe(`${tz}: ${real.resolvedOptions().timeZone}`);
      for (const ms of MS) expect(`${tz}@${ms}: ${mine.format(ms)}`).toBe(`${tz}@${ms}: ${real.format(ms)}`);
    }
    // The trap, stated as its own assertion: `Etc/GMT+1` is UTC MINUS one hour.
    expect(new DateTimeFormatShim("en-us", { timeZone: "etc/gmt+1", ...HT_OPTIONS }).format(0)).toBe(
      "12/31/1969 AD, 23:00:00",
    );
    // …and a BC year is rendered `1 - y`, which is what `br` inverts back.
    expect(new DateTimeFormatShim("en-us", { timeZone: "utc", ...HT_OPTIONS }).format(-62167219200000)).toBe(
      "1/1/1 BC, 00:00:00",
    );
  });

  it("the seven-token contract `br` parses holds for every accepted zone", () => {
    const DateTimeFormatShim = shimDateTimeFormat();
    for (const tz of ["utc", "etc/gmt+12", "etc/gmt-14"]) {
      for (const ms of [0, -8640000000000000, 8640000000000000, 1789275967000]) {
        const tokens = new DateTimeFormatShim("en-us", { timeZone: tz, ...HT_OPTIONS }).format(ms).split(/[^\w]+/);
        expect(tokens).toHaveLength(7);
        expect(tokens[3]?.[0]).toMatch(/[AB]/);
      }
    }
  });

  it("everything that needs CLDR/tzdata still refuses, catchably", () => {
    const DateTimeFormatShim = shimDateTimeFormat();
    const refused = (locales: unknown, options: unknown): string => {
      try {
        new DateTimeFormatShim(locales, options);
        return "DID NOT THROW";
      } catch (error) {
        return (error as Error).constructor.name;
      }
    };
    // Zones that need the database, and the spellings ICU itself rejects.
    for (const tz of [
      "America/New_York",
      "Europe/Berlin",
      "etc/gmt+13",
      "etc/gmt-15",
      "etc/gmt+01",
      "gmt+1",
      "z",
      "+01:00",
    ]) {
      expect(`${tz}: ${refused("en-us", { timeZone: tz, ...HT_OPTIONS })}`).toBe(`${tz}: RangeError`);
    }
    // Option/locale shapes whose en-US pattern this cannot reproduce exactly.
    expect(refused("de-DE", { timeZone: "utc", ...HT_OPTIONS })).toBe("RangeError");
    expect(refused("en-US-u-ca-gregory", { timeZone: "utc", ...HT_OPTIONS })).toBe("RangeError");
    expect(refused("en-us", { timeZone: "utc", ...HT_OPTIONS, timeZoneName: "short" })).toBe("RangeError");
    expect(refused("en-us", { timeZone: "utc", ...HT_OPTIONS, weekday: "short" })).toBe("RangeError");
    expect(refused("en-us", { timeZone: "utc", dateStyle: "full" })).toBe("RangeError");
    expect(refused("en-us", { timeZone: "utc", ...HT_OPTIONS, hour12: true })).toBe("RangeError");
    expect(refused("en-us", { timeZone: "utc", year: "numeric" })).toBe("RangeError");
    // …and the range surfaces, which have no consumer on the offset path.
    const ok = new DateTimeFormatShim("en-us", { timeZone: "utc", ...HT_OPTIONS });
    expect(() => ok.formatRange(0, 1)).toThrow(RangeError);
    expect(() => ok.format(8640000000000001)).toThrow(RangeError);
    expect(() => ok.format(Number.NaN)).toThrow(RangeError);
  });

  it("the shim still declares `Intl` once, keeps the graceful-degradation members undefined", () => {
    const shim = standaloneIntlShimSource();
    expect(shim.match(/\bconst Intl\b/g)).toHaveLength(1);
    expect(shim).toContain("__js2wasm_IntlDateTimeFormat");
    expect(shim).toContain("--target standalone");
    const intl = new Function(`${shim}\nreturn Intl;`)() as Record<string, unknown>;
    // `hr` falls through to `ht()` when this is absent — which is also what
    // Node does, since its list carries no `Etc/*` or `UTC` entry.
    expect(intl.supportedValuesOf).toBeUndefined();
    expect(intl.DurationFormat).toBeUndefined();
    // The eager `"formatToParts" in ai.prototype` probe must still answer true,
    // or the polyfill deletes its own implementation of it.
    const proto = (intl.DateTimeFormat as DTFCtor).prototype as object;
    for (const name of ["format", "formatToParts", "formatRange", "formatRangeToParts", "resolvedOptions"]) {
      expect(`${name} in prototype: ${name in proto}`).toBe(`${name} in prototype: true`);
    }
  });

  it("the emitted source compiles and RUNS under --target standalone, host-free", { timeout: 300_000 }, async () => {
    // The Node checks above prove the algorithm; this proves the standalone
    // backend can actually lower the JavaScript it is written in — the only
    // property that cannot be established without the compiler in the loop.
    const source = [
      standaloneIntlDateTimeFormatSource("DTF", "refused"),
      `export function run() {`,
      `  const f = new DTF("en-us", { timeZone: "utc", hour12: false, era: "short", year: "numeric",`,
      `    month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });`,
      `  if (f.resolvedOptions().timeZone !== "UTC") return 2;`,
      `  if (f.format(0) !== "1/1/1970 AD, 00:00:00") return 3;`,
      `  if (f.format(-1) !== "12/31/1969 AD, 23:59:59") return 4;`,
      `  if (f.format(-62167219200000) !== "1/1/1 BC, 00:00:00") return 5;`,
      `  const g = new DTF("en-us", { timeZone: "etc/gmt+1", hour12: false, era: "short", year: "numeric",`,
      `    month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });`,
      `  if (g.resolvedOptions().timeZone !== "Etc/GMT+1") return 6;`,
      `  if (g.format(0) !== "12/31/1969 AD, 23:00:00") return 7;`,
      `  try { new DTF("en-us", { timeZone: "America/New_York" }); return 8; } catch (e) {}`,
      `  return 1;`,
      `}`,
    ].join("\n");
    const result = await compile(source, {
      target: "standalone",
      hostBridge: "off",
      fileName: "/dtf.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
    } as never);
    expect(result.success ? "compiled" : `CE: ${result.errors?.[0]?.message}`).toBe("compiled");
    const binary = (result as { binary: Uint8Array }).binary;
    // Host-free is part of the contract: a new host import here would be a
    // #2961 leak in the provider, which imports nothing at all.
    expect(WebAssembly.Module.imports(await WebAssembly.compile(binary as never))).toEqual([]);
    const { instance } = await WebAssembly.instantiate(binary as never, {});
    expect((instance.exports as { run: () => number }).run()).toBe(1);
  });
});
