import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#3996 block locals do not capture same-named outer bindings", () => {
  it("keeps a closure's for-let index and block const in its own frame", async () => {
    const source = `
      function makeCounter(): (values: string[]) => number {
        let i = 99;
        const key = "outer";

        return function count(values: string[]): number {
          let total = 0;
          for (let i = 0; i < values.length; i++) {
            const key = values[i];
            total = total + key.length;
          }
          return total;
        };
      }

      export function test(): number {
        return makeCounter()(["ab", "cde"]);
      }
    `;

    const result = await compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(5);
  });
});
