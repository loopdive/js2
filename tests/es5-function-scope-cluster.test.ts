// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Focused standalone controls for the ES5 function-instantiation slice:
// pre-initialization reads through a nested function, and same-named function
// declarations replacing parameter/var bindings before function entry.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "es5-function-scope-control.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(module, {});
  return (exports as { test(): number }).test();
}

describe("ES5 standalone function declaration instantiation", () => {
  it("keeps a nested pre-init var return as undefined", async () => {
    expect(
      await run(`
        var outer = 0;
        function f() {
          function read() { return outer; }
          return read();
          var outer = 1;
        }
        export function test(): number { return f() === undefined ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("hoists same-named functions over parameter, var, and arguments bindings", async () => {
    expect(
      await run(`
        function param(x) { return x; function x() { return 7; } }
        function local() { var x; return typeof x; function x() { return 7; } }
        function args() { return typeof arguments; function arguments() { return 7; } }
        export function test(): number {
          return (typeof param() === "function" ? 1 : 0) +
            (local() === "function" ? 10 : 0) +
            (args() === "function" ? 100 : 0);
        }
      `),
    ).toBe(111);
  });
});
