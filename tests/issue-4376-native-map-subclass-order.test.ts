// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

async function build(seed: string, body: string) {
  return compileMulti(
    {
      "/probe/seed.ts": seed,
      "/probe/main.ts": `import './seed.ts'; ${body}`,
    },
    "/probe/main.ts",
    { target: "standalone", platform: "deno", skipSemanticDiagnostics: true },
  );
}

async function run(seed: string, body: string) {
  const result = await build(seed, body);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  expect((instance.exports.test as () => number)()).toBe(42);
}

describe("native Map subclass declaration order", () => {
  for (const collection of ["Set<number>", "Map<number, number>"]) {
    const seed = `export const ids = new ${collection}();`;
    for (const declaration of [
      "class SafeMap extends Map {}",
      "const SafeMap = class SafeMap extends Map {};",
      "class Base extends Map {} class SafeMap extends Base {}",
    ]) {
      it(`${collection} registered before ${declaration}`, async () => {
        await run(
          seed,
          `${declaration}
          export function test(): number {
            const map = new SafeMap(); map.set('answer', 42); return map.get('answer');
          }`,
        );
      });
    }
  }

  it("preserves construction when no collection was registered first", async () => {
    await run(
      "export const seed = 1;",
      `class SafeMap extends Map {}
      export function test(): number { const map = new SafeMap(); map.set('x', 42); return map.get('x'); }`,
    );
  });

  it("does not mistake a user class named Map for the native carrier", async () => {
    await run(
      "export const ids = new Set<number>();",
      `class Map { answer = 42; }
      class Child extends Map {}
      export function test(): number { return new Child().answer; }`,
    );
  });

  it("keeps the unsupported native subclass field diagnostic", async () => {
    const result = await build(
      "export const ids = new Set<number>();",
      `class SafeMap extends Map { answer = 42; }
      export function test(): number { return new SafeMap().answer; }`,
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.message.includes("declared property or accessor"))).toBe(true);
  });
});
