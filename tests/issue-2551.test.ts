import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2551 — standalone computed numeric-key READ truncated the index before
// stringifying. `o[1.5]` read routed through `__extern_get_idx(v, f64)` whose
// array-like `$Object` arm did `f64.trunc` BEFORE `number_toString`, so it read
// from key "1" while the STORE (`o[1.5] = …` → __extern_set → __to_property_key)
// keyed it under the canonical decimal "1.5". The read missed and returned 0.
//
// ToPropertyKey of a numeric index is ToString(idx) (§7.1.19 → §6.1.6.1.20) — no
// truncation. The fix drops the `f64.trunc` in the `$Object` arm; an integer
// index still stringifies to "3" (number_toString is canonical Number::toString),
// so positional/array reads are unregressed.

async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2551 standalone non-integer numeric-key read uses canonical decimal string", () => {
  it("numeric non-integer set + read round-trips (was 0)", async () => {
    expect(
      await runStandalone(`export function test(): number { const o: any = {}; o[1.5] = 4; return o[1.5]; }`),
    ).toBe(4);
  });

  it("literal-key store, numeric non-integer read", async () => {
    expect(await runStandalone(`export function test(): number { const o: any = {"1.5": 4}; return o[1.5]; }`)).toBe(4);
  });

  it("string-key store, numeric non-integer read", async () => {
    expect(
      await runStandalone(`export function test(): number { const o: any = {}; o["1.5"] = 4; return o[1.5]; }`),
    ).toBe(4);
  });

  it('numeric read of 1.5 does NOT alias the truncated key "1"', async () => {
    // Stored under "1" only; reading o[1.5] must miss (return 0), not read "1".
    expect(
      await runStandalone(`export function test(): number { const o: any = {}; o["1"] = 9; return o[1.5]; }`),
    ).toBe(0);
  });

  it("integer numeric read still canonicalizes to its decimal string (no regression)", async () => {
    expect(await runStandalone(`export function test(): number { const o: any = {}; o[3] = 7; return o[3]; }`)).toBe(7);
  });

  it("integer-literal-keyed object read via numeric index (no regression)", async () => {
    expect(await runStandalone(`export function test(): number { const o: any = {3: 7}; return o[3]; }`)).toBe(7);
  });

  it("$ObjVec positional read via numeric index is unregressed", async () => {
    // Object.values produces an $ObjVec; v[1] must still index positionally.
    expect(
      await runStandalone(
        `export function test(): number { const o: any = { a: 10, b: 20 }; const v: any = Object.values(o); return v[1]; }`,
      ),
    ).toBe(20);
  });
});
