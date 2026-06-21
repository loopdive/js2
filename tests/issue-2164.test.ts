// #2164 — standalone Date.now() / new Date() leaked an unsatisfiable host import.
//
// `Date.now()` and `new Date()` (no args) read the current wall-clock time. In
// JS-host mode that's the `env::__date_now` import; under `--target wasi` it's
// the WASI clock (`__wasi_date_now`). But under `--target standalone` (no JS
// host AND no WASI clock) the compiler still emitted the `env::__date_now`
// import — leaving it unsatisfiable, so EVERY module that calls `Date.now()` or
// `new Date()` failed to instantiate standalone. That broke unrelated Date
// tests that only touch `Date.now()` in their setup (a large slice of the Date
// standalone gap).
//
// Fix (expressions/calls.ts Date.now / performance.now, expressions/new-super.ts
// `new Date()`): pure standalone has no wall-clock source, so emit the Unix epoch
// (0) directly — deterministic, no import leak, module instantiates. Tests that
// construct explicit timestamps (the bulk of the gap) then work; only tests
// asserting a *real* current time stay failing (they need a clock, not an import).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // No __date_now host-import leak.
  const leaked = (r.imports ?? []).filter((i) => /__date_now/.test(i.name));
  expect(
    leaked.map((i) => i.name),
    "no __date_now leak",
  ).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#2164 standalone Date.now() / new Date() (no host-import leak)", () => {
  it("Date.now() instantiates and returns the epoch (0)", async () => {
    expect(await runStandalone(`export function run(): number { return Date.now() === 0 ? 1 : 0; }`)).toBe(1);
  });

  it("new Date() (no args) instantiates with epoch time", async () => {
    expect(
      await runStandalone(`export function run(): number { const d = new Date(); return d.getTime() === 0 ? 1 : 0; }`),
    ).toBe(1);
  });

  it("performance.now() instantiates standalone", async () => {
    expect(await runStandalone(`export function run(): number { return performance.now() >= 0 ? 1 : 0; }`)).toBe(1);
  });

  it("Date.now() in a module that also uses explicit timestamps", async () => {
    // The previously-fatal pattern: Date.now() in setup alongside real date math.
    expect(
      await runStandalone(
        `export function run(): number { const start = Date.now(); const d = new Date(5000); return d.getTime() - start; }`,
      ),
    ).toBe(5000);
  });

  it("explicit-timestamp Date construction is unaffected", async () => {
    expect(
      await runStandalone(`export function run(): number { const d = new Date(86400000); return d.getUTCFullYear(); }`),
    ).toBe(1970);
  });
});

describe("#2164 slice 2 — pure-Wasm Date.parse / new Date(str) (ISO 8601, no host)", () => {
  // 2000-01-01T00:00:00Z = 946684800000. Expected values are UTC-based so the
  // assertions are deterministic regardless of the host machine's timezone
  // (a no-timezone date-time form is treated as UTC standalone — there is no
  // timezone database in a pure-Wasm module; see slice 1's clock decision).
  const parse = (s: string) => `export function run(): number { return Date.parse(${JSON.stringify(s)}); }`;

  it("full ISO date-time with Z", async () => {
    expect(await runStandalone(parse("2000-01-01T00:00:00.000Z"))).toBe(946684800000);
  });

  it("date-only form (interpreted as UTC)", async () => {
    expect(await runStandalone(parse("2000-01-01"))).toBe(946684800000);
  });

  it("epoch", async () => {
    expect(await runStandalone(parse("1970-01-01T00:00:00Z"))).toBe(0);
  });

  it("milliseconds component", async () => {
    expect(await runStandalone(parse("2021-12-31T23:59:59.999Z"))).toBe(1640995199999);
  });

  it("positive timezone offset shifts UTC earlier", async () => {
    // 00:00+05:30 == previous-tz 18:30 UTC == 946665000000
    expect(await runStandalone(parse("2000-01-01T00:00:00+05:30"))).toBe(946665000000);
  });

  it("negative timezone offset shifts UTC later", async () => {
    expect(await runStandalone(parse("2000-01-01T00:00:00-08:00"))).toBe(946713600000);
  });

  it("no-timezone date-time treated as UTC", async () => {
    expect(await runStandalone(parse("2000-01-01T12:00"))).toBe(946728000000);
  });

  it("leap day", async () => {
    expect(await runStandalone(parse("2000-02-29"))).toBe(951782400000);
  });

  it("expanded negative year", async () => {
    expect(await runStandalone(parse("-000001-01-01T00:00:00Z"))).toBe(-62198755200000);
  });

  it("expanded year 10000", async () => {
    expect(await runStandalone(parse("+010000-01-01T00:00:00Z"))).toBe(253402300800000);
  });

  it("year-only form", async () => {
    expect(await runStandalone(parse("2000"))).toBe(946684800000);
  });

  it("invalid month → NaN (returned as 0 sentinel via Number.isNaN check)", async () => {
    expect(
      await runStandalone(`export function run(): number { return Number.isNaN(Date.parse("2000-13-01")) ? 1 : 0; }`),
    ).toBe(1);
  });

  it("garbage string → NaN", async () => {
    expect(
      await runStandalone(`export function run(): number { return Number.isNaN(Date.parse("garbage")) ? 1 : 0; }`),
    ).toBe(1);
  });

  it("new Date(str).getTime() parses the string", async () => {
    expect(
      await runStandalone(`export function run(): number { return new Date("2000-01-01T00:00:00.000Z").getTime(); }`),
    ).toBe(946684800000);
  });

  it("new Date(invalidStr).getTime() is NaN", async () => {
    expect(
      await runStandalone(
        `export function run(): number { return Number.isNaN(new Date("not-a-date").getTime()) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("round-trips through UTC component getters", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const d = new Date("2021-07-15T13:45:30.500Z"); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); }`,
      ),
    ).toBe(20210715);
  });
});
