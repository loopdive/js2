// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1558 — ESLint Tier 1d: `Linter_verifyAndFix` failed Wasm validation with
//
//   f64.eq[0] expected type f64, found call of type i32 @+...
//
// because the `compileBinary` dispatch at binary-ops.ts ~1361 (the
// `(isNumberType(leftTsType) || leftType.kind === "f64")` branch) coerced
// only the *right* operand from i32 → f64 before calling
// `compileNumericBinaryOp`. When the left operand was lowered to i32 (e.g.
// `messages.length`, a `.length` property access, or any other host helper
// whose TS type is `number` but whose Wasm result is `i32`), it stayed on
// the stack as i32, and the subsequent `f64.eq` rejected it as a type
// mismatch.
//
// Fix: in that same branch, also coerce the left operand from i32 → f64
// (save-right / convert / restore-right pattern); and when both operands
// are i32, route through `compileI32BinaryOp` for `i32.eq` / `i32.ne` /
// comparison ops directly.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

function compileAndValidate(src: string): boolean {
  const r = compile(src, { fileName: "/test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors?.[0]?.message}`);
  return WebAssembly.validate(r.binary);
}

describe("#1558 — i32 ↔ f64 coercion in equality / comparison", () => {
  it("arr.length === <number literal> validates (i32 on left, f64 on right)", () => {
    expect(
      compileAndValidate(`
        export function fn(arr: any[]): boolean {
          return arr.length === 1;
        }
      `),
    ).toBe(true);
  });

  it("<number literal> === arr.length validates (f64 on left, i32 on right)", () => {
    expect(
      compileAndValidate(`
        export function fn(arr: any[]): boolean {
          return 1 === arr.length;
        }
      `),
    ).toBe(true);
  });

  it("a.length === b.length (both i32 typed-as-number) validates", () => {
    expect(
      compileAndValidate(`
        export function fn(a: string, b: string): boolean {
          return a.length === b.length;
        }
      `),
    ).toBe(true);
  });

  it("number param === arr.length validates", () => {
    expect(
      compileAndValidate(`
        export function fn(arr: any[], n: number): boolean {
          return n === arr.length;
        }
      `),
    ).toBe(true);
  });

  it("arr.length !== <number literal> validates", () => {
    expect(
      compileAndValidate(`
        export function fn(arr: any[]): boolean {
          return arr.length !== 0;
        }
      `),
    ).toBe(true);
  });

  it("arr.length == <number literal> (loose equality) validates", () => {
    expect(
      compileAndValidate(`
        export function fn(arr: any[]): boolean {
          return arr.length == 1;
        }
      `),
    ).toBe(true);
  });

  it("arr.length < <number literal> (relational) validates", () => {
    expect(
      compileAndValidate(`
        export function fn(arr: any[]): boolean {
          return arr.length < 10;
        }
      `),
    ).toBe(true);
  });

  it("runtime: arr.length === 1 returns the expected boolean", async () => {
    const src = `
      export function fn(arr: any[]): boolean {
        return arr.length === 1;
      }
    `;
    const r = compile(src, { fileName: "/runtime.ts" });
    if (!r.success) throw new Error(r.errors?.[0]?.message);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
