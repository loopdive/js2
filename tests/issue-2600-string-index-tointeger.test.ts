import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2600 — Standalone String index/position argument ToIntegerOrInfinity (§7.1.5)
//   for at/charAt/charCodeAt/codePointAt/indexOf/lastIndexOf on a typed string
//   receiver. The position was coerced directly to i32 instead of via
//   ToNumber→truncate-toward-zero, so a fractional-string ("1.9"), non-numeric
//   string ("abc"→NaN→0), boolean, or `{valueOf(){…}}` position resolved wrong.
//
//   Fix routes the arg through the existing numeric coercion engine
//   (`coerceType(..., {kind:"f64"}, "number")` — string → __str_to_number,
//   object → ToPrimitive("number")), then applies ToIntegerOrInfinity (NaN→0,
//   else i32.trunc_sat_f64_s). No new #2108 coercion site. Substrate-independent
//   value correctness (typed receiver).
//
// `skipSemanticDiagnostics` mirrors the test262 runner — passing a non-number to
// a `(pos: number)` method is not a hard TS error there.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

async function runGc(src: string): Promise<unknown> {
  const r = await compile(src, { skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2600 standalone String index/position ToIntegerOrInfinity", () => {
  it("indexOf with fractional-string position ('1.9' → 1)", async () => {
    expect(await runStandalone(`export function test(): number { return "aaaa".indexOf("aa", "1.9"); }`)).toBe(1);
  });

  it("charAt('1.5') → trunc to index 1 ('b')", async () => {
    expect(await runStandalone(`export function test(): number { return "abc".charAt("1.5").charCodeAt(0); }`)).toBe(
      98,
    );
  });

  it("charCodeAt('2.9') → trunc to index 2 ('c' = 99)", async () => {
    expect(await runStandalone(`export function test(): number { return "abc".charCodeAt("2.9"); }`)).toBe(99);
  });

  it("codePointAt('1.5') → index 1 ('b' = 98)", async () => {
    expect(await runStandalone(`export function test(): number { return "abc".codePointAt("1.5"); }`)).toBe(98);
  });

  it("charCodeAt('abc') → NaN → 0 ('X' = 88)", async () => {
    expect(await runStandalone(`export function test(): number { return "Xyz".charCodeAt("abc"); }`)).toBe(88);
  });

  it("charCodeAt(true) → 1 ('y' = 121)", async () => {
    expect(await runStandalone(`export function test(): number { return "Xyz".charCodeAt(true); }`)).toBe(121);
  });

  it("charAt({valueOf(){return 1}}) → ToPrimitive('number') → 1 ('b')", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { valueOf() { return 1; } }; return "abc".charAt(o).charCodeAt(0); }`,
      ),
    ).toBe(98);
  });

  it("at('1.9') → index 1 ('b')", async () => {
    expect(await runStandalone(`export function test(): number { return "ab".at("1.9") === "b" ? 1 : 0; }`)).toBe(1);
  });

  it("at('0.9') → index 0 ('a')", async () => {
    expect(await runStandalone(`export function test(): number { return "ab".at("0.9") === "a" ? 1 : 0; }`)).toBe(1);
  });

  it("at('-1.5') → trunc toward zero → -1 (last char 'b')", async () => {
    expect(await runStandalone(`export function test(): number { return "ab".at("-1.5") === "b" ? 1 : 0; }`)).toBe(1);
  });

  it("at({valueOf(){return 1}}) → 'b'", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { valueOf() { return 1; } }; return "ab".at(o) === "b" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  // Regression guards — integer positions unchanged.
  it("charAt(1) integer unchanged", async () => {
    expect(await runStandalone(`export function test(): number { return "abc".charAt(1).charCodeAt(0); }`)).toBe(98);
  });

  it("indexOf('a', 2) integer position unchanged", async () => {
    expect(await runStandalone(`export function test(): number { return "aaaa".indexOf("a", 2); }`)).toBe(2);
  });

  it("charCodeAt(0) integer unchanged", async () => {
    expect(await runStandalone(`export function test(): number { return "Xyz".charCodeAt(0); }`)).toBe(88);
  });
});

describe("#2600 gc-mode (host path) unchanged", () => {
  it("gc charAt integer", async () => {
    expect(await runGc(`export function test(): number { return "abc".charAt(1).charCodeAt(0); }`)).toBe(98);
  });

  it("gc indexOf integer position", async () => {
    expect(await runGc(`export function test(): number { return "aaaa".indexOf("a", 2); }`)).toBe(2);
  });

  it("gc charCodeAt", async () => {
    expect(await runGc(`export function test(): number { return "Xyz".charCodeAt(0); }`)).toBe(88);
  });
});
