import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileAndRunTestNumber } from "./helpers/compile.js";

describe("#4507 class method dispatch", () => {
  it("keeps static and instance methods with the same name distinct", async () => {
    const result = await compileAndRunTestNumber(`
      class Parser {
        static parse(value: number): number {
          return value + 10;
        }

        parse(value: number): number {
          return value + 1;
        }
      }

      export function test(): number {
        return new Parser().parse(1) + Parser.parse(1);
      }
    `);

    expect(result).toBe(13);
  });

  it("keeps the dynamic zero-argument bridge distinct from ToPrimitive exports", async () => {
    const result = await compile(
      `
      class Value {
        toString(): string { return "value"; }
      }

      export function test(): number {
        const value: any = new Value();
        return value.toString() === "value" ? 1 : 0;
      }
    `,
      { fileName: "test.ts" },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  });
});
