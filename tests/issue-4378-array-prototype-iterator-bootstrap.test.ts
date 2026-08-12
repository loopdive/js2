// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string) {
  const result = await compile(source, { target: "standalone", nativeStrings: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, Function>;
}

describe("#4378 — Deno primordials Array.prototype iterator capture", () => {
  it("captures the genuine shared array-iterator prototype from the pristine Array.prototype", async () => {
    const exports = await compileStandalone(`
      export function probe(): number {
        const captured: any = Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]());
        const control: any = Object.getPrototypeOf([][Symbol.iterator]());
        const wrong: any = Object.getPrototypeOf([]);
        return captured === control && captured !== wrong ? 42 : 0;
      }
    `);

    expect(exports.probe!()).toBe(42);
  });

  it("does not reinterpret a user binding that shadows Array", async () => {
    const exports = await compileStandalone(`
      export function probe(): number {
        const Array = { prototype: [7] };
        let result = 0;
        for (const value of Array.prototype[Symbol.iterator]()) result = value;
        return result;
      }
    `);

    expect(exports.probe!()).toBe(7);
  });
});
