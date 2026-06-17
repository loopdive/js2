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
