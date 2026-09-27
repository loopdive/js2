// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(["Symbol", "Map", "Set", "RegExp"])("returns source %s functions instead of builtin carriers", async (name) => {
  const result = await compile(
    `function ${name}(value: number): number { return value + 7; }
    const allocator = { get: () => ${name} };
    export function run(): number { const fn = allocator.get(); return fn(35); }`,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as () => number)()).toBe(42);
});
