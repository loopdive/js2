// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Target = "gc" | "standalone";

async function run(source: string, target: Target): Promise<number> {
  const result = await compile(source, {
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  if (target === "standalone") expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports.test as () => number)();
}

describe.each<Target>(["gc", "standalone"])("#3769 JSON.stringify static space coercion (%s)", (target) => {
  it("clamps a pure boxed numeric space like its primitive value", async () => {
    expect(
      await run(
        `
          var value = { a: { b: 1 } };
          export function test(): number {
            return JSON.stringify(value, null, new Number(-5)) === JSON.stringify(value, null, 0) &&
              JSON.stringify(value, null, new Number(100)) === JSON.stringify(value, null, 10) ? 1 : 0;
          }
        `,
        target,
      ),
    ).toBe(1);
  });

  it("truncates a pure boxed fractional space like its primitive value", async () => {
    expect(
      await run(
        `
          var value = { a: { b: 1 } };
          export function test(): number {
            return JSON.stringify(value, null, new Number(5.11111)) === JSON.stringify(value, null, 5) ? 1 : 0;
          }
        `,
        target,
      ),
    ).toBe(1);
  });

  it("ignores pure non-number and non-string space values", async () => {
    expect(
      await run(
        `
          var value = { a: { b: 1 } };
          export function test(): number {
            var compact = JSON.stringify(value);
            return compact === JSON.stringify(value, null, null) &&
              compact === JSON.stringify(value, null, true) &&
              compact === JSON.stringify(value, null, new Boolean(false)) &&
              compact === JSON.stringify(value, null, Symbol()) &&
              compact === JSON.stringify(value, null, {}) ? 1 : 0;
          }
        `,
        target,
      ),
    ).toBe(1);
  });
});

it("keeps a bound mutable Number wrapper on the dynamic refusal path", async () => {
  const result = await compile(
    `
      var value = { a: 1 };
      const space = new Number(1);
      space.valueOf = function () { return 4; };
      export function test(): number {
        return JSON.stringify(value, null, space).length;
      }
    `,
    { target: "standalone", skipSemanticDiagnostics: true },
  );
  expect(result.success).toBe(false);
  expect(result.errors.some((error) => error.message.includes("#1599"))).toBe(true);
});
