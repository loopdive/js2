import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it("calls a typed-array expando with the original receiver and arguments", async () => {
  const result = await compile(
    `
    export function run() {
      var arr = new Uint8Array(2);
      arr[0] = 10;
      arr.foo = function (a, b) { this[1] = a; return this[0] + a * 10 + b; };
      var value = arr.foo(3, 4);
      return value === 44 && arr[1] === 3 ? 1 : 0;
    }
  `,
    { target: "standalone", fileName: "typed-array-expando.js", allowJs: true, skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as Function)()).toBe(1);
});
