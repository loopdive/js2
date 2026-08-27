import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName: "es5-p1-regression-controls.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

describe("ES5 intrinsic prototype fold decline controls", () => {
  it("uses the live constructor after the wrapper binding is reassigned", async () => {
    expect(
      await run(`
        var value: any = new Number(1);
        value = new String("x");
        export function test(): number {
          return value.constructor.prototype === String.prototype ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("does not fold a wrapper read before its var initializer", async () => {
    expect(
      await run(`
        var answer = 0;
        try { answer = value.constructor.prototype === Number.prototype ? 1 : 2; }
        catch (_error) { answer = 3; }
        var value: any = new Number(1);
        export function test(): number { return answer; }
      `),
    ).toBe(3);
  });

  it("observes an own constructor accessor", async () => {
    expect(
      await run(`
        var value: any = new Number(1);
        var calls = 0;
        Object.defineProperty(value, "constructor", {
          get: function () { calls++; return String; },
          configurable: true
        });
        export function test(): number {
          var prototype: any = value.constructor.prototype;
          return calls === 1 && prototype === String.prototype ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
