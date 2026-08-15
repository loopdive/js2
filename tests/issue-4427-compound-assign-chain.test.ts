// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #4427 — two independent defects in the standalone (nativeStrings) `+=`
 * lowering, both reachable from test262 S11.13.2_A4.4_T2.6–T2.9.
 *
 * 1. INVALID MODULE. `emitBoolToString` is dual-lane: JS-host selects an
 *    externref string-constant global, standalone selects a native
 *    `$AnyString`. Both native-string coercion sites appended the host lane's
 *    `any.convert_extern` + `ref.cast` unconditionally, so V8 rejected the
 *    whole module with
 *      `any.convert_extern[0] expected type externref,
 *       found if of type (ref null $AnyString)`
 *    for `var x = "1"; x += true;` — a MODULE-level failure, i.e. every
 *    function in the file is lost, not just the statement.
 *
 * 2. WRONG LANE. `+` concatenates as soon as EITHER operand's ToPrimitive is a
 *    String (§13.5.3 step 3), but the lane gate only consulted the LHS. With
 *    the checker narrowing `x` to `number` right after `x = 1`, `x += "1"`
 *    took the numeric lane and ToNumber-coerced the string: `2` instead of
 *    `"11"`. Same for an `undefined` / `null` LHS.
 */

async function instantiateStandalone(source: string) {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  // Empty import object — proves the module is JS-host-free (pure Wasm).
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number>;
}

describe("#4427 standalone compound `+=` with boolean / string operands", () => {
  it("emits a VALID module for a boolean RHS on a string LHS", async () => {
    const ex = await instantiateStandalone(`
      var x = "1";
      x += true;
      export function test(): number { return (x === "1true") ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("emits a VALID module for a two-statement `+=` chain (the CE repro)", async () => {
    const ex = await instantiateStandalone(`
      var x;
      x = true; x += "1";
      x = "1";  x += true;
      export function test(): number { return (x === "1true") ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("concatenates a number LHS with a string RHS (S11.13.2_A4.4_T2.6 #2)", async () => {
    const ex = await instantiateStandalone(`
      var x;
      x = 1;
      x += "1";
      export function test(): number { return (x === "11") ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("concatenates a boolean LHS with a string RHS (S11.13.2_A4.4_T2.7 #1)", async () => {
    const ex = await instantiateStandalone(`
      var x;
      x = true;
      x += "1";
      export function test(): number { return (x === "true1") ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("stringifies an undefined LHS (S11.13.2_A4.4_T2.8)", async () => {
    const ex = await instantiateStandalone(`
      var x;
      x = undefined;
      x += "1";
      export function test(): number { return (x === "undefined1") ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("stringifies a null LHS (S11.13.2_A4.4_T2.9)", async () => {
    const ex = await instantiateStandalone(`
      var x;
      x = null;
      x += "1";
      export function test(): number { return (x === "null1") ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("keeps a provably numeric `+=` on the numeric lane", async () => {
    // The RHS-is-string rule must not widen to numeric RHS: this stays `2`.
    const ex = await instantiateStandalone(`
      var x;
      x = 1;
      x += 1;
      export function test(): number { return (x === 2) ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("keeps a Number-wrapper `+=` numeric (#3989 regression guard)", async () => {
    const ex = await instantiateStandalone(`
      var n = new Number(1);
      n += 1;
      export function test(): number { return (n === 2) ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });
});
