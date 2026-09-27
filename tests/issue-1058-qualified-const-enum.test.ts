// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

it.each([false, true])("folds qualified imported const enum members (barrel=%s)", async (barrel) => {
  const result = await compileMulti(
    {
      "./types.ts": `
      export const enum Kind { Start = 7, Next = Start + 1, Text = "abc" }
      export let mutable = 1;
    `,
      "./barrel.ts": 'export * from "./types.js";',
      "./entry.ts": `
      import * as ts from "./${barrel ? "barrel" : "types"}.js";
      export function run(): number { return ts.Kind.Next * 10 + ts.Kind.Text.length; }
    `,
    },
    "./entry.ts",
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(83);
});

it("folds nested static namespaces without confusing effectful property reads", async () => {
  const result = await compile(
    `
    namespace Outer { export namespace Inner { export const enum Kind { Value = 8 } } }
    let reads = 0;
    const object = { get inner() { reads++; return { value: 3 }; } };
    export function run(): number { return Outer.Inner.Kind.Value * 100 + object.inner.value * 10 + reads; }
  `,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(831);
});
