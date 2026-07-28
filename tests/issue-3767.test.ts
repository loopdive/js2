// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-3767.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors?.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#3767 standalone Function.prototype.bind IsCallable guard", () => {
  it("throws TypeError for every statically non-callable ES5 target shape", async () => {
    expect(
      await run(`
        export function test(): number {
          let score = 0;
          try { Function.prototype.bind.call(undefined, {}); } catch (e) {
            if (e instanceof TypeError) score += 1;
          }
          try { Function.prototype.bind.call(null, {}); } catch (e) {
            if (e instanceof TypeError) score += 2;
          }
          try { Function.prototype.bind.call(false, {}); } catch (e) {
            if (e instanceof TypeError) score += 4;
          }
          try { Function.prototype.bind.call(1, {}); } catch (e) {
            if (e instanceof TypeError) score += 8;
          }
          try { Function.prototype.bind.call("x", {}); } catch (e) {
            if (e instanceof TypeError) score += 16;
          }
          try { Function.prototype.bind.call({}, {}); } catch (e) {
            if (e instanceof TypeError) score += 32;
          }
          try { Function.prototype.bind.call(/x/, undefined); } catch (e) {
            if (e instanceof TypeError) score += 64;
          }
          var re = /y/;
          try { Function.prototype.bind.call(re, undefined); } catch (e) {
            if (e instanceof TypeError) score += 128;
          }
          return score;
        }`),
    ).toBe(255);
  });

  it("evaluates thisArg and bound arguments in source order before throwing", async () => {
    expect(
      await run(`
        export function test(): number {
          let order = 0;
          function mark(n: number): object {
            order = order * 10 + n;
            return {};
          }
          try {
            Function.prototype.bind.call({}, mark(1), mark(2));
          } catch (e) {
            return e instanceof TypeError && order === 12 ? 1 : -order;
          }
          return 0;
        }`),
    ).toBe(1);
  });

  it("keeps the callable indirect-bind path intact", async () => {
    expect(
      await run(`
        function add(a: number, b: number): number { return a + b; }
        export function test(): number {
          const add3 = Function.prototype.bind.call(add, undefined, 3);
          return add3(4);
        }`),
    ).toBe(7);
  });
});
