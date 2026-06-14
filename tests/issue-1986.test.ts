// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1986 / #1987 — strict equality (`===` / `!==`) involving an `any`-typed
// operand.
//
// #1986: when exactly one operand of `===` is `any`-typed and the other is a
// known primitive, the `any` side was unboxed via ToNumber and the comparison
// lowered to `f64.eq`, so `===` behaved LOOSER than `==`:
//   (false as any) === 0  → true   (node: false)
//   ("1" as any)   === 1  → true   (node: false)
//   (null as any)  === 0  → true   (node: false — wronger than even `==`)
// §7.2.16 IsStrictlyEqual returns false on a type mismatch with no coercion.
//
// #1987: `(0 as any) === (-0 as any)` returned false because the AnyValue
// numeric path mishandled the i32-box (tag 2) vs f64-box (tag 3) split.
//
// Fix: in `compileBinaryExpression`'s externref-equality path, a strict
// comparison whose operands are an `any` externref and/or a known
// number/null/string primitive (booleans excluded — they box as a JS number)
// routes through the `__host_eq` import (JS `===`), which is spec-exact:
// type-mismatch → false, +0 === -0 → true, NaN !== NaN.

import { describe, expect, it } from "vitest";

import { compileAndInstantiate } from "../src/runtime.js";

async function strictEq(body: string): Promise<number> {
  const exports = (await compileAndInstantiate(`export function test(): number { ${body} }`)) as { test(): number };
  return exports.test();
}

describe("#1986 mixed any/primitive strict equality is not ToNumber-coerced", () => {
  it("(false as any) === 0 → false", async () => {
    expect(await strictEq("const f: any = false; return (f === 0) ? 1 : 0;")).toBe(0);
  });

  it('("1" as any) === 1 → false', async () => {
    expect(await strictEq('const s: any = "1"; return (s === 1) ? 1 : 0;')).toBe(0);
  });

  it("(null as any) === 0 → false", async () => {
    expect(await strictEq("const n: any = null; return (n === 0) ? 1 : 0;")).toBe(0);
  });

  it("(true as any) === 1 → false", async () => {
    expect(await strictEq("const t: any = true; return (t === 1) ? 1 : 0;")).toBe(0);
  });

  it("(undefined as any) === 0 → false", async () => {
    expect(await strictEq("const u: any = undefined; return (u === 0) ? 1 : 0;")).toBe(0);
  });

  it("matching number stays true: (1 as any) === 1, (1.5 as any) === 1.5, reversed", async () => {
    expect(await strictEq("const a: any = 1; return (a === 1) ? 1 : 0;")).toBe(1);
    expect(await strictEq("const a: any = 1.5; return (a === 1.5) ? 1 : 0;")).toBe(1);
    expect(await strictEq("const a: any = 3; return (3 === a) ? 1 : 0;")).toBe(1);
    expect(await strictEq("const a: any = -3; return (a === -3) ? 1 : 0;")).toBe(1);
  });

  it("matching boolean stays true: (true as any) === true, (false as any) === false", async () => {
    expect(await strictEq("const a: any = true; return (a === true) ? 1 : 0;")).toBe(1);
    expect(await strictEq("const a: any = false; return (a === false) ? 1 : 0;")).toBe(1);
    expect(await strictEq("const a: any = true; return (a === false) ? 1 : 0;")).toBe(0);
  });

  it('matching string stays true: ("x" as any) === "x"', async () => {
    expect(await strictEq('const a: any = "x"; return (a === "x") ? 1 : 0;')).toBe(1);
  });

  it("!== negation is consistent: (null as any) !== 0 → true, (1 as any) !== 2 → true", async () => {
    expect(await strictEq("const n: any = null; return (n !== 0) ? 1 : 0;")).toBe(1);
    expect(await strictEq("const a: any = 1; return (a !== 2) ? 1 : 0;")).toBe(1);
    expect(await strictEq("const a: any = true; return (a !== 1) ? 1 : 0;")).toBe(1);
  });

  it("null === null still matches across an any-typed side", async () => {
    expect(await strictEq("const a: any = null; return (a === null) ? 1 : 0;")).toBe(1);
  });
});

describe("#1987 any-boxed number strict equality merges the i32/f64 box split", () => {
  it("(0 as any) === (-0 as any) → true", async () => {
    expect(await strictEq("const d: any = 0; const e: any = -0; return (d === e) ? 1 : 0;")).toBe(1);
  });

  it("(NaN as any) === (NaN as any) → false (NaN !== NaN preserved)", async () => {
    expect(await strictEq("const a: any = NaN; const b: any = NaN; return (a === b) ? 1 : 0;")).toBe(0);
  });

  it("(5 as any) === (5.0 as any) → true across i32/f64 boxes", async () => {
    expect(await strictEq("const a: any = 5; const b: any = 5.0; return (a === b) ? 1 : 0;")).toBe(1);
  });
});

describe("#1986/#1987 do not regress object identity, strings, or loose equality", () => {
  it("object identity: (a) === (b = a) → true; two distinct literals → false", async () => {
    expect(await strictEq("const a: any = {}; const b: any = a; return (a === b) ? 1 : 0;")).toBe(1);
    expect(await strictEq("const a: any = {}; const b: any = {}; return (a === b) ? 1 : 0;")).toBe(0);
  });

  it("both-any string equality compares content", async () => {
    expect(await strictEq('const a: any = "hi"; const b: any = "hi"; return (a === b) ? 1 : 0;')).toBe(1);
  });

  it("loose `==` is unchanged: null == undefined → true, mixed any 1 == 1 → true", async () => {
    expect(await strictEq("const a: any = null; return (a == undefined) ? 1 : 0;")).toBe(1);
    expect(await strictEq("const a: any = 1; return (a == 1) ? 1 : 0;")).toBe(1);
  });
});
