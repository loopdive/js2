import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module must validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4447 — standalone binding carriers preserve mixed array values", () => {
  it.each(["const", "let", "var"] as const)(
    "preserves null, number, boolean, and string for %s bindings",
    async (kind) => {
      const result = await runStandalone(`
      var initCount = 0;
      function counter(): void { initCount += 1; }
      var result = 0;
      for (${kind} [w = counter(), x = counter(), y = counter(), z = counter()] of [[null, 0, false, ""]]) {
        result = (w === null ? 1000 : 0) +
          (x === 0 ? 100 : 0) +
          (y === false ? 10 : 0) +
          (z === "" ? 1 : 0) +
          (initCount === 0 ? 10000 : 0);
      }
      export function test(): number { return result; }
    `);
      expect(result).toBe(11111);
    },
  );

  it("shares the carrier-preserving conversion with parameter destructuring", async () => {
    const result = await runStandalone(`
      var initCount = 0;
      function counter(): void { initCount += 1; }
      function read([w = counter(), x = counter(), y = counter(), z = counter()]: any[]): number {
        return (w === null ? 1000 : 0) +
          (x === 0 ? 100 : 0) +
          (y === false ? 10 : 0) +
          (z === "" ? 1 : 0) +
          (initCount === 0 ? 10000 : 0);
      }
      export function test(): number { return read([null, 0, false, ""]); }
    `);
    expect(result).toBe(11111);
  });
});
