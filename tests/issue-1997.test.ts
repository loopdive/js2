// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1997 — Array.prototype.toString() (§23.1.3.36) delegates to join(",").
// #1998 — join's elemToStr must handle externref/ref elements (boxed numbers,
//   undefined, null, holes) and the `Array(n)` sparse-array hole case.
//
// Both were spec-conformance residuals of #1215. The `Array(n)` sub-case
// (#1998) miscompiled because the non-`new` `Array(n)` constructor
// (compileArrayConstructorCall in src/codegen/literals.ts) defaulted untyped
// element storage to f64, whose `array.new_default` fills holes with `0`, so
// `Array(3).join(",")` rendered "0,0,0". This pins the externref-backed
// sparse-array fix (matching the `new Array(n)` path), so holes render as ""
// (§23.1.3.18 step 7.c/d) → ",,".
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStr(src: string): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#1997/#1998 — Array toString/join element stringification", () => {
  describe("#1997 Array.prototype.toString delegates to join", () => {
    it("flat numeric array toString", async () => {
      expect(await runStr(`export function test(): string { return [1, 2, 3].toString(); }`)).toBe("1,2,3");
    });

    it("nested array toString stringifies recursively via join", async () => {
      expect(
        await runStr(`export function test(): string { const a: any[] = [[1, 2], [3]]; return a.toString(); }`),
      ).toBe("1,2,3");
    });
  });

  describe("#1998 join handles externref / hole elements", () => {
    it("any[] of numbers joins", async () => {
      expect(await runStr(`export function test(): string { const a: any[] = [10, 9]; return a.join(","); }`)).toBe(
        "10,9",
      );
    });

    it("undefined element renders empty", async () => {
      expect(await runStr(`export function test(): string { return [1, undefined, 2].join("-"); }`)).toBe("1--2");
    });

    it("null element renders empty", async () => {
      expect(await runStr(`export function test(): string { return [1, null, 2].join("-"); }`)).toBe("1--2");
    });

    it("literal hole renders empty", async () => {
      expect(await runStr(`export function test(): string { return [1, , 3].join(","); }`)).toBe("1,,3");
    });

    it("Array(n) sparse array renders holes as empty (the #1998 fix)", async () => {
      expect(await runStr(`export function test(): string { return Array(3).join(","); }`)).toBe(",,");
    });

    it("Array(n) sparse array reports length n", async () => {
      expect(await runStr(`export function test(): number { const a = Array(5); return a.length; }`)).toBe(5);
    });

    it("Array(0) joins to empty string", async () => {
      expect(await runStr(`export function test(): string { return Array(0).join(","); }`)).toBe("");
    });
  });

  describe("regression guards — untyped dense + typed Array(n) unchanged", () => {
    it("Array(a, b, c) builds a dense numeric array", async () => {
      expect(await runStr(`export function test(): string { return Array(1, 2, 3).join(","); }`)).toBe("1,2,3");
    });

    it("typed number[] via Array(n) then assignment joins numerically", async () => {
      expect(
        await runStr(
          `export function test(): string { const a: number[] = Array(3); a[0] = 1; a[1] = 2; a[2] = 3; return a.join(","); }`,
        ),
      ).toBe("1,2,3");
    });
  });
});
