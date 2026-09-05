// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5 Array constructor edge cases covered by S15.4_A1.1_T9/T10:
// object-valued property keys must use ToPropertyKey, and a dynamic numeric
// key must remain readable after the array reaches the sparse-index ceiling.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone", fileName: "es5-array-constructor-pair.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("ES5 Array constructor property-key edge cases (standalone)", () => {
  it("canonicalizes repeated object-valued keys before the vec dispatch", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const x: any[] = [];
        var object: any = {
          valueOf: function(): number { return 1; },
          toString: function(): number { return 0; },
        };
        x[object] = 7;
        var object: any = {
          valueOf: function(): number { return 1; },
          toString: function(): number { return 0; },
        };
        return x[0] === 7 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("round-trips dynamic indices through the sparse companion", async () => {
    expect(
      await runStandalone(`export function test(): number {
        var x: any[] = [];
        var k = 1;
        for (var i = 0; i < 32; i++) { k = k * 2; x[k - 2] = k; }
        k = 1;
        for (var i = 0; i < 32; i++) {
          k = k * 2;
          if (x[k - 2] !== k) return 0;
        }
        return 1;
      }`),
    ).toBe(1);
  });
});
