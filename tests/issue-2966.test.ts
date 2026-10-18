// #2966 — standalone any-param closure results are tag-5 boxes whose field-4
// payload is a native $BoxedNumber/$BoxedBoolean carrier (the deliberate #1888
// "box-the-externref" contract). `__any_add` classified EVERY tag-5 operand as
// stringy (§13.15.3 concat arm), so `f(1) + f(2)` on two dispatched numbers
// concatenated their recovered strings into a tag-5 result whose f64 field
// reads 0 — SILENT WRONG VALUES (`f(1)+f(2)` → 0, `f(1,2,3)` → NaN).
//
// Fix (consumer-side, the #2040 classifier pattern): the stringiness test in
// `__any_add` inspects the tag-5 payload — a $BoxedNumber/$BoxedBoolean carrier
// is NOT a string and takes the numeric arm, whose `__any_to_f64` recovers the
// honest value (#1888 arm + the symmetric $BoxedBoolean recovery added here).
// Genuine strings/objects keep the concat arm byte-for-byte; host/gc lane and
// typed programs are byte-inert (verified via sha256 A/B in the issue file).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) return undefined;
  // Host-free: the repro family must not lean on env imports.
  const envImports = r.imports.filter((i) => i.module === "env");
  expect(envImports, `unexpected env imports: ${envImports.map((i) => i.name).join(",")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

const wrap = (body: string): string => `export function test(): number {
  const f: any = function (a: any) { return a + 10; };
  ${body}
}`;

describe("#2966 standalone any-param closure call results through `+`", () => {
  it("two calls in one expression: f(1) + f(2) === 23", async () => {
    expect(await runStandalone(wrap(`return f(1) + f(2);`))).toBe(23);
  });

  it("three any params: f(1, 2, 3) === 6 (a + b + c)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const f: any = function (a: any, b: any, c: any) { return a + b + c; };
        return f(1, 2, 3);
      }`),
    ).toBe(6);
  });

  it("cross-statement reuse: x = f(1); y = f(2); x + y === 23", async () => {
    expect(await runStandalone(wrap(`const x = f(1); const y = f(2); return x + y;`))).toBe(23);
  });

  it("call chain: f(1) + f(2) + f(3) === 36", async () => {
    expect(await runStandalone(wrap(`return f(1) + f(2) + f(3);`))).toBe(36);
  });

  it("self add: x + x === 22", async () => {
    expect(await runStandalone(wrap(`const x = f(1); return x + x;`))).toBe(22);
  });

  it("fractional values cross the boundary: f(0.5) + f(0.25) === 20.75", async () => {
    expect(await runStandalone(wrap(`return f(0.5) + f(0.25);`))).toBe(20.75);
  });

  it("add feeding sub: (f(1) + f(2)) - f(3) === 10", async () => {
    expect(await runStandalone(wrap(`return (f(1) + f(2)) - f(3);`))).toBe(10);
  });

  it("booleans through the boundary: h(true) + h(true) === 2 (§7.1.4 ToNumber)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const h: any = function (v: any) { return v; };
        return h(true) + h(true);
      }`),
    ).toBe(2);
  });

  it("number + false === number", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const f: any = function (a: any) { return a + 10; };
        const h: any = function (v: any) { return v; };
        return f(1) + h(false);
      }`),
    ).toBe(11);
  });

  // ── concat arm must be preserved (§13.15.3 step 2) ──

  it("boxed number + string literal still concatenates", async () => {
    expect(await runStandalone(wrap(`const s = f(1) + "a"; return s.length;`))).toBe(3);
  });

  it("string literal + boxed number still concatenates", async () => {
    expect(await runStandalone(wrap(`const s = "a" + f(1); return s.length;`))).toBe(3);
  });

  it("boxed boolean + string literal concatenates via ToString", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const h: any = function (v: any) { return v; };
        const s = h(true) + "x"; return s.length;
      }`),
    ).toBe(5);
  });

  // ── controls that must stay correct ──

  it("typed-param closure control", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const f: any = function (a: number) { return a + 10; };
        return f(1) + f(2);
      }`),
    ).toBe(23);
  });

  it("single call control", async () => {
    expect(await runStandalone(wrap(`return f(1);`))).toBe(11);
  });

  it("relational on dispatched numbers (pre-existing to_f64 recovery)", async () => {
    expect(await runStandalone(wrap(`return f(1) < f(2) ? 1 : 0;`))).toBe(1);
  });

  // (#3135 audit) This guard is RED on current main — a merge-window drift
  // unrelated to the #2966 fix: the closure's `undefined` return now crosses
  // the boundary as a BARE null externref, and the `+` seam it lands in
  // coerces that via `__unbox_number`'s null arm (0), so `u() + 1` answers 1
  // (r === r → 1, not the NaN-like 0 this expected). Answering NaN for the
  // bare null externref requires the #2106 S1 $undefined-singleton sweep
  // (null and undefined share the carrier by construction — no contained fix;
  // the partial attempt was the parked PR #2025). Pinned `it.fails` so the
  // suite is honest now and flips loudly when #2106 S1 lands. The BOXED
  // (tag-5 null-externval) sibling of this seam IS fixed — see
  // tests/issue-3135.test.ts.
  it("undefined result + 1 stays NaN-like (fixed with #2106 S1; promoted from it.fails, #7014)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const u: any = function () { return undefined; };
        const r = u() + 1; return r === r ? 1 : 0;
      }`),
    ).toBe(0);
  });
});
