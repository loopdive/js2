// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const NATIVE_FUNCTION_SOURCE = "function () { [native code] }";

async function run(source: string, target: "gc" | "standalone"): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-3540-function-tostring-source-facade.ts",
    target,
  });
  expect(
    result.success,
    `compile failed:\n${(result.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);

  if (target === "standalone") {
    expect(result.imports.filter((i) => i.module === "env")).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number }).test();
}

const rawClosureSource = `
  export function test(): number {
    const f = (x: number): number => x + 1;
    const source: string = "" + f;
    return source === ${JSON.stringify(NATIVE_FUNCTION_SOURCE)} && f(41) === 42 ? 1 : 0;
  }
`;

describe("#3540 Function source facade for compiled closures", () => {
  it.each(["gc", "standalone"] as const)(
    "%s: concatenation emits NativeFunction syntax without changing callability",
    async (target) => {
      expect(await run(rawClosureSource, target)).toBe(1);
    },
  );

  it("host accessor bridge does not expose runtime callback source", async () => {
    expect(
      await run(
        `
          export function test(): number {
            const o = {
              get value(): number { return 1; },
              set value(v: number) {}
            };
            const desc: any = Object.getOwnPropertyDescriptor(o, "value");
            const getterSource: string = "" + desc.get;
            const setterSource: string = "" + desc.set;
            return getterSource === ${JSON.stringify(NATIVE_FUNCTION_SOURCE)} &&
              setterSource === ${JSON.stringify(NATIVE_FUNCTION_SOURCE)} ? 1 : 0;
          }
        `,
        "gc",
      ),
    ).toBe(1);
  });

  it("host closure keeps an own Symbol.toPrimitive override ahead of the facade", async () => {
    expect(
      await run(
        `
          export function test(): number {
            const f: any = (): number => 1;
            f[Symbol.toPrimitive] = (): string => "custom";
            return ("" + f) === "custom" ? 1 : 0;
          }
        `,
        "gc",
      ),
    ).toBe(1);
  });

  it.each(["gc", "standalone"] as const)("%s: ordinary objects keep ordinary object coercion", async (target) => {
    expect(
      await run(
        `
          export function test(): number {
            const o: any = {};
            return ("" + o) === "[object Object]" ? 1 : 0;
          }
        `,
        target,
      ),
    ).toBe(1);
  });
});
