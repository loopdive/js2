import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it("calls the compiled Buffer binding's static method without a host builtin lookup", async () => {
  const result = await compile(
    `
    function Buffer() {}
    Buffer.isBuffer = function (value) { return value === 7; };
    export function run() { return Buffer.isBuffer(7) ? 1 : 0; }
  `,
    { fileName: "buffer-shadow.js", allowJs: true, skipSemanticDiagnostics: true, target: "standalone" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as Function)()).toBe(1);
});
