import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "host-array-sort.js",
    platform: "node",
    skipSemanticDiagnostics: true,
    target: "gc",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setInstance?.(instance);
  return (instance.exports.runCase as () => number)();
}

describe("#4300 host externref Array.prototype.sort", () => {
  it("keeps the JavaScript array returned by Object.keys readable", async () => {
    expect(
      await run(`
        function summarize(input) {
          const keys = Object.keys(input);
          return keys.length * 100 + keys[0].length * 10 + keys[1].length;
        }
        export function runCase() {
          return summarize({ a: 1, longer: 2 });
        }
      `),
    ).toBe(216);
  });

  it("sorts the JavaScript array returned by Object.keys with a comparator", async () => {
    expect(
      await run(`
        function longest(input) {
          const keys = Object.keys(input).sort((a, b) => b.length - a.length);
          return keys[0].length * 10 + keys.length;
        }
        export function runCase() {
          return longest({ a: 1, longer: 2 });
        }
      `),
    ).toBe(62);
  });

  it("keeps native Wasm arrays on the native in-place sort path", async () => {
    expect(
      await run(`
        export function runCase() {
          const values = [3, 1, 2];
          const sorted = values.sort((a, b) => a - b);
          return values[0] * 100 + sorted[1] * 10 + values[2];
        }
      `),
    ).toBe(123);
  });
});
