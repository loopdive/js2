// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileAndRunHost } from "./helpers/compile.js";

describe("#1058 nested optional-parameter ABI", () => {
  it("distinguishes an omitted optional number from an explicit NaN", async () => {
    const exports = await compileAndRunHost(`
      export function run(mode: number): number {
        const fallbackValue = 7;

        function pick(end?: number): number {
          return end ?? fallbackValue;
        }

        return mode === 0 ? pick() : pick(0 / 0);
      }
    `);

    expect(exports.run!(0)).toBe(7);
    expect(Number.isNaN(exports.run!(1) as number)).toBe(true);
  });

  it("preserves omission through a generic declaration specialization", async () => {
    const exports = await compileAndRunHost(`
      function pick<T>(value: T, end?: number): number {
        return end ?? 7;
      }

      export function run(mode: number): number {
        return mode === 0 ? pick("value") : pick("value", 0 / 0);
      }
    `);

    expect(exports.run!(0)).toBe(7);
    expect(Number.isNaN(exports.run!(1) as number)).toBe(true);
  });

  it("distinguishes an omitted captured optional boolean from false", async () => {
    const exports = await compileAndRunHost(`
      export function run(mode: number): number {
        const existing = { hasTrailingComma: true, value: 7 };

        function createNodeArray<T>(elements: T, hasTrailingComma?: boolean): number {
          return hasTrailingComma === undefined ? existing.value : hasTrailingComma ? 1 : 0;
        }

        return mode === 0 ? createNodeArray(existing) : createNodeArray(existing, false);
      }
    `);

    expect(exports.run!(0)).toBe(7);
    expect(exports.run!(1)).toBe(0);
  });

  it("preserves omission through a captured contextual two-layer forwarder", async () => {
    const exports = await compileAndRunHost(`
      interface NodeArrayFactory {
        createNodeArray<T>(elements: T, hasTrailingComma?: boolean): number;
      }

      export function run(mode: number): number {
        const fallbackValue = 7;

        function createFactory(): NodeArrayFactory {
          const factory: NodeArrayFactory = { createNodeArray };
          return factory;

          function createNodeArray<T>(elements: T, hasTrailingComma?: boolean): number {
            return hasTrailingComma === undefined ? fallbackValue : hasTrailingComma ? 1 : 0;
          }
        }

        const { createNodeArray: factoryCreateNodeArray } = createFactory();
        function parserCreateNodeArray<T>(elements: T, hasTrailingComma?: boolean): number {
          return factoryCreateNodeArray(elements, hasTrailingComma);
        }

        return mode === 0 ? parserCreateNodeArray({}) : parserCreateNodeArray({}, false);
      }
    `);

    expect(exports.run!(0)).toBe(7);
    expect(exports.run!(1)).toBe(0);
  });

  it("keeps an unobserved optional boolean on its scalar ABI", async () => {
    const result = await compile(`
      export function run(): number {
        function createBaseStringLiteral(isSingleQuote?: boolean): number {
          return isSingleQuote ? 1 : 0;
        }
        function shadowedUndefined(undefined: boolean, hasTrailingComma?: boolean): number {
          return hasTrailingComma === undefined ? 2 : 0;
        }
        return createBaseStringLiteral(false) + shadowedUndefined(false, false);
      }
    `);

    expect(result.success).toBe(true);
    expect(result.wat).toMatch(/\(func \$createBaseStringLiteral \(param i32\)/);
    expect(result.wat).not.toMatch(/\(func \$createBaseStringLiteral \(param externref\)/);
    expect(result.wat).toMatch(/\(func \$shadowedUndefined \(param i32 i32\)/);
  });
});
