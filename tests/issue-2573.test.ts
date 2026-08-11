import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "missing-property.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports.test as () => number)();
}

describe("#2573 missing property reads", () => {
  it("returns undefined rather than null for a dynamic read on an empty compiled object", async () => {
    const value = await run(`
      function read(object, key) {
        return object[key];
      }

      export function test() {
        const value = read({}, "missing");
        if (typeof value === "undefined") return 1;
        if (value === null) return 2;
        return 3;
      }
    `);
    expect(value).toBe(1);
  });

  it("still returns a real null property value", async () => {
    const value = await run(`
      function read(object, key) {
        return object[key];
      }

      export function test() {
        const value = read({ present: null }, "present");
        return value === null ? 1 : 0;
      }
    `);
    expect(value).toBe(1);
  });
});
