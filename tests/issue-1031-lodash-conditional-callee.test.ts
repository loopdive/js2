import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

describe("#1031 lodash conditional-callee result representation", () => {
  it("joins the actual Wasm results of direct conditional-callee branches", async () => {
    const result = await compile(`
      function arrayEach(value: number[]): number[] {
        return value;
      }

      function baseForOwn(value: number[]): unknown {
        return value;
      }

      export function run(useArrayEach: number): number {
        const result = (useArrayEach ? arrayEach : baseForOwn)([11, 31]);
        return (result as number[])[0] + (result as number[])[1];
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const instance = await instantiateWithRuntime(result);
    const run = (instance.exports as { run: (useArrayEach: number) => number }).run;
    expect(run(1)).toBe(42);
    expect(run(0)).toBe(42);
  });
});
