// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

it.each((["gc", "standalone"] as const).flatMap((target) => [false, true].map((rest) => ({ target, rest }))))(
  "keeps module-initializer callbacks local in $target (foreign rest=$rest)",
  async ({ target, rest }) => {
    const result = await compileMulti(
      {
        "./parser.ts": `
        function visitNodes(callback: (value: number) => number, values: number[]): number {
          let sum = 0;
          for (const value of values) sum += callback(value);
          return sum;
        }
        const table = { walk: (values: number[]) => visitNodes(value => value + 1, values) };
        export function parse(): number { return table.walk([2, 3]); }
      `,
        "./visitor.ts": rest
          ? `
        export function visitNodes(...values: number[]): number {
          let sum = 0;
          for (const value of values) sum += value * 10;
          return sum;
        }
        `
          : `
        export function visitNodes(values: number[], callback: (value: number) => number): number {
          let sum = 0;
          for (const value of values) sum += callback(value) * 10;
          return sum;
        }
      `,
        "./main.ts": `
        import { parse } from "./parser.js";
        import { visitNodes } from "./visitor.js";
        export function run(): number { return parse() * 1000 + ${rest ? "visitNodes(4)" : "visitNodes([4], value => value)"}; }
      `,
      },
      "./main.ts",
      { target },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
    const imports = result.importObject ?? {};
    const instance = await WebAssembly.instantiate(module, imports);
    (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.run as () => number)()).toBe(7040);
  },
);
