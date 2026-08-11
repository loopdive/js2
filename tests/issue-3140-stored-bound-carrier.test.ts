// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary));
  expect(imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#3140 stored standalone bound carriers", () => {
  it("calls a bound carrier after storing it in a module global", async () => {
    expect(
      await run(`
        function add(a: number, b: number): number { return a + b; }
        var add4 = add.bind(undefined, 4);
        export function test(): number {
          return add4(3);
        }`),
    ).toBe(7);
  });

  it("preserves bound arguments through a module-global carrier", async () => {
    expect(
      await run(`
        function inspect(x: string, y: string): number {
          return (x === "a" ? 1 : 0) +
            (y === "b" ? 2 : 0) +
            (arguments[0] === "a" ? 4 : 0) +
            (arguments[1] === "b" ? 8 : 0) +
            (arguments.length === 2 ? 16 : 0);
        }
        var bound = inspect.bind({}, "a", "b");
        export function test(): number {
          return bound();
        }`),
    ).toBe(31);
  });
});
