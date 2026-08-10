import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileAndRun(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#4031 IIFE capture-scan proof", () => {
  it("preserves the module-initializer no-capture path", async () => {
    expect(
      await compileAndRun(`
        var value: number = (function (input: number): number {
          return input + 1;
        })(41);
        export function test(): number { return value; }
      `),
    ).toBe(42);
  });

  it("still scans a local that shadows a registered top-level function", async () => {
    expect(
      await compileAndRun(`
        function value(): number { return 100; }
        export function test(): number {
          var value: number = 41;
          return (function (): number { return value + 1; })();
        }
      `),
    ).toBe(42);
  });
});
