import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it("initializes Buffer's guarded registry-symbol key in standalone", async () => {
  const result = await compile(
    `
    var customInspectSymbol =
      (typeof Symbol === 'function' && typeof Symbol['for'] === 'function')
        ? Symbol['for']('nodejs.util.inspect.custom') : null;
    export function run() { return typeof customInspectSymbol === 'symbol' ? 1 : 0; }
  `,
    { target: "standalone", fileName: "buffer-symbol-init.js", allowJs: true, skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as Function)()).toBe(1);
});
