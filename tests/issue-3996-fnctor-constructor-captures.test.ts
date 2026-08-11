import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#3996 fnctor constructors carry their enclosing captures", () => {
  it("forwards mutable sibling state into every synthesized constructor call", async () => {
    const source = `
      function makeBoxes(): number {
        let offset = 5;
        function add(value: number): number {
          offset += 1;
          return value + offset;
        }
        function Box(value: number) {
          (this as any).value = add(value);
        }
        const first: any = new Box(7);
        const second: any = new Box(7);
        return first.value + second.value;
      }

      export function test(): number {
        return makeBoxes();
      }
    `;

    const result = await compile(source, {});
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(27);
  });
});
