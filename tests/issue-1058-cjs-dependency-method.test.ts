import { expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

it("keeps same-named mutable ESM bindings and their import aliases independent", async () => {
  const result = await compileMulti(
    {
      "./a.ts": `export let value = 1; export function bump() { value += 1; }`,
      "./b.ts": `export let value = 10; export function bump() { value += 1; }`,
      "./entry.ts": `
      import { value as a, bump as bumpA } from './a.js';
      import { value as b, bump as bumpB } from './b.js';
      export function run(): number { bumpA(); bumpB(); return a * 100 + b; }
    `,
    },
    "./entry.ts",
    { target: "standalone" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as Function)()).toBe(211);
  expect((instance.exports.run as Function)()).toBe(312);
});

it.each(["single", "sibling", "nested"])(
  "calls a CommonJS dependency (%s) through its default object",
  async (mode) => {
    const result = await compileMulti(
      {
        "./encoder.js": `
        exports.fromByteArray = fromByteArray;
        function fromByteArray(bytes) { return bytes[0] + bytes[1]; }
      `,
        ...(mode === "single"
          ? {}
          : {
              "./buffer.js": `
        var base64 = require('./encoder.js');
        exports.encode = encode;
        function encode(bytes) { return base64.fromByteArray(bytes); }
      `,
            }),
        "./entry.js":
          mode === "nested"
            ? `
        var buffer = require('./buffer.js');
        export function run() { return buffer.encode(new Uint8Array([104, 195])); }
      `
            : `
        var base64 = require('./encoder.js');
        export function linked() { return typeof base64.fromByteArray === 'function' ? 1 : 0; }
        export function run() { return base64.fromByteArray(new Uint8Array([104, 195])); }
      `,
      },
      "./entry.js",
      { allowJs: true, skipSemanticDiagnostics: true, target: "standalone" },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    if (mode !== "nested") {
      expect((instance.exports.linked as Function)(), "importer method").toBe(1);
    }
    expect((instance.exports.run as Function)()).toBe(299);
  },
);
