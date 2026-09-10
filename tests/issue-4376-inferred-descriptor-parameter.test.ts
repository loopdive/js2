// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#4376 inferred descriptor parameters", () => {
  it.each([undefined, "deno"] as const)("reads an accessor descriptor on platform %s", async (platform) => {
    const result = await compile(
      `
      export function readDescriptor(seed) {
        const source = { get value() { return seed; } };
        function read({ enumerable, get, set }) {
          return enumerable && set === undefined ? get.call(source) : -1;
        }
        return read(Object.getOwnPropertyDescriptor(source, "value"));
      }
    `,
      {
        target: "standalone",
        platform,
        allowJs: true,
        skipSemanticDiagnostics: true,
        fileName: "descriptor.js",
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    const read = instance.exports.readDescriptor as (seed: number) => number;
    expect(read(17)).toBe(17);
  });
});
