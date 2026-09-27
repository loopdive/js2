// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#1058 optional vec-factory preregistration", () => {
  it.each(["gc", "standalone"] as const)(
    "registers a nested vec-plus-optional-boolean factory before its dynamic caller in %s",
    async (target) => {
      const result = await compile(
        `
      interface Item {
        value: number;
      }

      interface Factory {
        make<T extends Item>(values?: readonly T[], flag?: boolean): readonly T[];
      }

      function makeFactory(): Factory {
        return { make };

        function make<T extends Item>(values?: readonly T[], flag?: boolean): readonly T[] {
          const result = values === undefined ? [] : values;
          if (result.length > 0) {
            if (flag === undefined) result[0]!.value += 10;
            else if (flag) result[0]!.value += 1;
          }
          return result;
        }
      }

      const { make: factoryMake } = makeFactory();

      function wrap<T extends Item>(values: T[], flag?: boolean): readonly T[] {
        return factoryMake(values, flag);
      }

      export function run(mode: number): number {
        const item = { value: 7 };
        const result = mode === 0 ? wrap([item]) : mode === 1 ? wrap([item], false) : mode === 2 ? wrap([item], true) : wrap([item], undefined);
        return result[0]!.value;
      }
    `,
        { target },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
      const imports = result.importObject ?? {};
      const instance = await WebAssembly.instantiate(module, imports);
      (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
      const exports = instance.exports as Record<string, Function>;

      expect(exports.run!(0)).toBe(17);
      expect(exports.run!(1)).toBe(7);
      expect(exports.run!(2)).toBe(8);
      expect(exports.run!(3)).toBe(17);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "preserves optional numbers in resolved generic signatures in %s",
    async (target) => {
      const result = await compile(
        `
      interface Item { value: number; }
      function read<T extends Item>(item: T, value?: number): number {
        return value === undefined ? item.value : value;
      }
      export function run(mode: number): number {
        const item = { value: 17 };
        return mode === 0 ? read(item) : mode === 1 ? read(item, 0) : mode === 2 ? read(item, 4) : read(item, undefined);
      }
    `,
        { target },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
      const imports = result.importObject ?? {};
      const instance = new WebAssembly.Instance(module, imports);
      (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
      const run = instance.exports.run as (mode: number) => number;
      expect([run(0), run(1), run(2), run(3)]).toEqual([17, 0, 4, 17]);
    },
  );
});
