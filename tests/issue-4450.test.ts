import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<Record<string, any>> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-4450.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, any>;
}

describe("#4450 class ES6 standalone residuals", () => {
  it("preserves a statically-falsy logical assignment in computed field names", async () => {
    const exports = await runStandalone(`
      let x = 0;
      let C = class {
        [x &&= 1] = () => 2;
        static [x &&= 1] = () => 2;
      };
      let c = new C();
      export function test(): number {
        return c[x &&= 1]() + C[x &&= 1]() +
          c[String(x &&= 1)]() + C[String(x &&= 1)]() + x;
      }
    `);

    expect(exports.test()).toBe(8);
  });

  it("throws TypeError for a primitive return before derived super()", async () => {
    const exports = await runStandalone(`
      class Obj extends Object {
        constructor() { return 42; }
      }
      export function test(): number {
        try {
          new Obj();
          return 0;
        } catch (error: any) {
          return error.constructor === TypeError ? 1 : 0;
        }
      }
    `);

    expect(exports.test()).toBe(1);
  });
});
