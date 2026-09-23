import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it("calls an augmented typed array's prototype method in standalone", async () => {
  const result = await compile(
    `
    export function run() {
      var arr = new Uint8Array(1);
      var proto = { foo: function () { return 42; } };
      Object.setPrototypeOf(proto, Uint8Array.prototype);
      Object.setPrototypeOf(arr, proto);
      if (Object.getPrototypeOf(arr) !== proto) return -2;
      if (typeof arr.foo !== "function") return -3;
      return arr.foo() === 42 ? 42 : -1;
    }
  `,
    { target: "standalone", fileName: "buffer-prototype.js", allowJs: true, skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as Function)()).toBe(42);
});
