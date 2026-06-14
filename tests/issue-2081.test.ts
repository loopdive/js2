// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2081 — standalone loose `==` between two `any` operands compared by reference
// identity and never coerced, so `("1" as any) == (1 as any)` returned false.
//
// Root cause (corrected vs the architect spec): the headline repro does NOT
// reach `__any_eq` (anyValueTypeIdx stays -1) — it lowers through the #1776
// no-JS-host native equality cascade in binary-ops.ts, which handled
// number/number, bool/bool, bigint/bigint, then fell to eqref ref-identity.
// The cross-type loose coercion arms (§7.2.15) were missing. This adds, for
// LOOSE `==`/`!=` only (strict is unchanged — `"1" === 1` is false by type):
//   - null/undefined cross (steps 2-3) — both nullish ⇒ true,
//   - Number/Boolean numeric coercion (step 8) — `true == 1`, `false == 0`,
//   - String⇄Number (steps 4-7) — ToNumber(string) via the §7.1.4.1
//     `__str_to_number` scanner (NOT parseFloat), then f64.eq.
//
// Verified standalone (`--target wasi`): valid module, no host imports.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function looseEq(src: string): Promise<boolean> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  // standalone: no host imports should leak for a pure equality module
  expect((r.imports ?? []).filter((i) => i.module === "env" && i.name === "__host_loose_eq")).toHaveLength(0);
  const io: any = r.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports);
  return Boolean((instance.exports as { test(): unknown }).test());
}

describe("#2081 — standalone loose == coerces (any/any)", () => {
  it('"1" == 1  → true (String⇄Number, the headline repro)', async () => {
    expect(
      await looseEq(`const a: any = "1"; const b: any = 1; export function test(): boolean { return a == b; }`),
    ).toBe(true);
  });

  it('1 == "1"  → true (reversed)', async () => {
    expect(
      await looseEq(`const a: any = 1; const b: any = "1"; export function test(): boolean { return a == b; }`),
    ).toBe(true);
  });

  it('"" == 0   → true (ToNumber("")=0)', async () => {
    expect(
      await looseEq(`const a: any = ""; const b: any = 0; export function test(): boolean { return a == b; }`),
    ).toBe(true);
  });

  it('"abc" == 0 → false (ToNumber("abc")=NaN)', async () => {
    expect(
      await looseEq(`const a: any = "abc"; const b: any = 0; export function test(): boolean { return a == b; }`),
    ).toBe(false);
  });

  it('"0x10" == 16 → true (ToNumber parses hex, NOT parseFloat)', async () => {
    expect(
      await looseEq(`const a: any = "0x10"; const b: any = 16; export function test(): boolean { return a == b; }`),
    ).toBe(true);
  });

  it('"2" != 1  → true', async () => {
    expect(
      await looseEq(`const a: any = "2"; const b: any = 1; export function test(): boolean { return a != b; }`),
    ).toBe(true);
  });

  it("true == 1, false == 0 → true (Boolean→ToNumber)", async () => {
    expect(
      await looseEq(`const a: any = true; const b: any = 1; export function test(): boolean { return a == b; }`),
    ).toBe(true);
    expect(
      await looseEq(`const a: any = false; const b: any = 0; export function test(): boolean { return a == b; }`),
    ).toBe(true);
    expect(
      await looseEq(`const a: any = true; const b: any = 2; export function test(): boolean { return a == b; }`),
    ).toBe(false);
  });

  it("null == undefined → true; null == 0 → false (never coerces nullish)", async () => {
    expect(
      await looseEq(
        `const a: any = null; const b: any = undefined; export function test(): boolean { return a == b; }`,
      ),
    ).toBe(true);
    expect(
      await looseEq(`const a: any = null; const b: any = 0; export function test(): boolean { return a == b; }`),
    ).toBe(false);
  });

  it("object identity preserved: same ref == true, distinct == false", async () => {
    expect(
      await looseEq(
        `const o: any = {}; const a: any = o; const b: any = o; export function test(): boolean { return a == b; }`,
      ),
    ).toBe(true);
    expect(
      await looseEq(`const a: any = {}; const b: any = {}; export function test(): boolean { return a == b; }`),
    ).toBe(false);
  });

  it("strict === does NOT coerce: '1' === 1 → false, true === 1 → false", async () => {
    expect(
      await looseEq(`const a: any = "1"; const b: any = 1; export function test(): boolean { return a === b; }`),
    ).toBe(false);
    expect(
      await looseEq(`const a: any = true; const b: any = 1; export function test(): boolean { return a === b; }`),
    ).toBe(false);
  });

  it("number/number loose unchanged: 2 == 2 true, 2 == 3 false", async () => {
    expect(
      await looseEq(`const a: any = 2; const b: any = 2; export function test(): boolean { return a == b; }`),
    ).toBe(true);
    expect(
      await looseEq(`const a: any = 2; const b: any = 3; export function test(): boolean { return a == b; }`),
    ).toBe(false);
  });
});
