import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * (#5206) `Intl` is an ambient NAMESPACE, so no value-shaped identifier arm
 * claimed it and every read lowered to `ref.null.extern` — the very next
 * property access then threw "Cannot access property on null or undefined".
 *
 * That is the eighth `@js-temporal/polyfill` module-init blocker (#4628): the
 * bundle's first Intl statement is a TOP-LEVEL `ct = Intl.DateTimeFormat`,
 * i.e. it runs inside the wasm `start` section. Unlike #5193/#5202/#5203/#5205
 * this was NOT an init-window timing bug — a scoped probe failed identically
 * after init — so every case below pairs an AT-INIT read with an after-init
 * control, and the at-init half is the one that proves the capability, not the
 * timing.
 *
 * The measured call surface of the polyfill (grep of the linked bundle, 30
 * `Intl` occurrences) is exactly:
 *   - `Intl.DateTimeFormat` as a VALUE (top level, twice)
 *   - `<ctor>.supportedLocalesOf` copied off it (top level)
 *   - `Intl.DurationFormat?.prototype` destructured with `??` (top level)
 *   - `Intl.supportedValuesOf?.("timeZone")` (lazy)
 *   - `new Intl.DateTimeFormat(locale, options)` + `.resolvedOptions()` /
 *     `.formatToParts()` / `.formatRange()` (lazy)
 * Everything except the `formatToParts(new Date(...))` argument shape is
 * covered here; passing a COMPILED `Date` to any host function is a separate,
 * wider gap (a compiled Date is a plain object with a `timestamp` field, not a
 * host Date) and is deliberately not in scope.
 *
 * Host lane only. Standalone/WASI have no host `Intl` and keep the null
 * default — asserted by the last case so the fix cannot leak into them.
 */
async function run(source: string): Promise<Record<string, unknown>> {
  const result = await compile(source, { fileName: "issue-5206.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const exports = instance.exports as Record<string, () => unknown>;
  const out: Record<string, unknown> = {};
  for (const name of ["atInit", "test"]) {
    if (typeof exports[name] === "function") out[name] = exports[name]();
  }
  return out;
}

describe("#5206 — the host `Intl` global", () => {
  it("reads `Intl.DateTimeFormat` as a value at init and after init", async () => {
    // The narrowest statement of the blocker: on base BOTH halves threw
    // "Cannot access property on null or undefined".
    expect(
      await run(`
        const ct: any = (Intl as any).DateTimeFormat;
        export function atInit(): string { return typeof ct; }
        export function test(): string { return typeof (Intl as any).DateTimeFormat; }
      `),
    ).toEqual({ atInit: "function", test: "function" });
  });

  it("gives `Intl` itself the host namespace object's identity", async () => {
    expect(
      await run(`
        export function test(): string {
          const g: any = (globalThis as any).Intl;
          return typeof (Intl as any) + "|" + String(g === (Intl as any)) +
            "|" + String("DateTimeFormat" in (Intl as any));
        }
      `),
    ).toEqual({ test: "object|true|true" });
  });

  it("copies statics off the constructor at init (`supportedLocalesOf`)", async () => {
    // The polyfill's `di.supportedLocalesOf = ai.supportedLocalesOf`.
    expect(
      await run(`
        const ct: any = (Intl as any).DateTimeFormat;
        const slo: any = ct.supportedLocalesOf;
        export function atInit(): string { return typeof slo + "|" + String(ct.name); }
        export function test(): string { return typeof (Intl as any).DateTimeFormat.supportedLocalesOf; }
      `),
    ).toEqual({ atInit: "function|DateTimeFormat", test: "function" });
  });

  it("survives an ABSENT member through `?.` and `??` at init", async () => {
    // Model the bundle's optional `Intl.DurationFormat?.prototype` lookup
    // with a deliberately nonexistent member. DurationFormat itself is no
    // longer a stable absence probe now that newer hosts implement it.
    expect(
      await run(`
        const df: any = (Intl as any).__js2_absent_intl_member__;
        const proto: any = df ? df.prototype : null;
        export function atInit(): string { return typeof df + "|" + String(proto === null); }
        export function test(): string {
          const sv: any = (Intl as any).supportedValuesOf;
          return typeof sv;
        }
      `),
    ).toEqual({ atInit: "undefined|true", test: "function" });
  });

  it("constructs a formatter with an options object at init and reads it back", async () => {
    // The heaviest at-init shape: a COMPILED options object marshalled into
    // the host constructor (the #5193 bridge), then `resolvedOptions()` read
    // back out. `ht()` in the bundle builds exactly this.
    expect(
      await run(`
        const ct: any = (Intl as any).DateTimeFormat;
        const f: any = new ct("en-US", { timeZone: "UTC", hour12: false, year: "numeric", month: "numeric", day: "numeric" });
        const tz: string = String(f.resolvedOptions().timeZone);
        export function atInit(): string { return typeof f + "|" + tz; }
        export function test(): string {
          const g: any = new (Intl as any).DateTimeFormat("en-US", { timeZone: "UTC" });
          return typeof g + "|" + String(g.resolvedOptions().timeZone);
        }
      `),
    ).toEqual({ atInit: "object|UTC", test: "object|UTC" });
  });

  it("formats through the real ICU data (`formatToParts`, `supportedValuesOf`)", async () => {
    expect(
      await run(`
        export function test(): string {
          const f: any = new (Intl as any).DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });
          const parts: any = f.formatToParts(0);
          const zones: any = (Intl as any).supportedValuesOf("timeZone");
          return String(parts.length > 0) + "|" + String(zones.length > 0);
        }
      `),
    ).toEqual({ test: "true|true" });
  });

  it("lets a user binding shadow the ambient namespace", async () => {
    // The host-global arm must not outrank a real declaration.
    expect(
      await run(`
        const shadow: any = { DateTimeFormat: "shadowed" };
        export function test(): string {
          const Intl: any = shadow;
          return String(Intl.DateTimeFormat);
        }
      `),
    ).toEqual({ test: "shadowed" });
  });

  it("keeps standalone and WASI host-free (no `__get_globalThis` import)", async () => {
    // Standalone/WASI have no host Intl; the fix is host-lane only and must
    // not introduce a host import there.
    const source = `export function test(): string { return typeof (Intl as any); }`;
    for (const target of ["standalone", "wasi"] as const) {
      const result = await compile(source, { fileName: "issue-5206.ts", target });
      expect(result.success).toBe(true);
      expect(result.imports.map((i) => i.name)).not.toContain("__get_globalThis");
    }
  });
});
