import { describe, expect, it } from "vitest";

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
});
