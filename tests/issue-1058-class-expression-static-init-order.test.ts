// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function compileAndRun(source: string): Promise<number> {
  const result = await compile(source, { fileName: "class-expression-static-init-order.ts" });

  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return (instance.exports.test as () => number)();
}

describe("#1058 class-expression static initialization order", () => {
  it("runs statics before the next declarator in the same statement", async () => {
    expect(
      await compileAndRun(`
        let order = 0;
        const C = class {
          static value = order = order * 10 + 1;
        }, after = order = order * 10 + 2;

        export function test(): number {
          return order * 10 + C.value;
        }
      `),
    ).toBe(121);
  });

  it("runs statics at a class expression nested within an initializer", async () => {
    expect(
      await compileAndRun(`
        let order = 0;
        const values = [
          class {
            static {
              order = order * 10 + 1;
            }
          },
          order = order * 10 + 2,
        ];

        export function test(): number {
          return order;
        }
      `),
    ).toBe(12);
  });

  it("defers a function-local class expression until the function evaluates it", async () => {
    expect(
      await compileAndRun(`
        let order = 0;

        function make(): number {
          const C = class {
            static value = order = order * 10 + 1;
          }, after = order = order * 10 + 2;
          return order * 10 + C.value;
        }

        export function test(): number {
          const before = order;
          return before * 10000 + make();
        }
      `),
    ).toBe(121);
  });

  it("runs statics before arguments of a directly constructed class expression", async () => {
    expect(
      await compileAndRun(`
        let order = 0;
        const instance = new (class {
          static {
            order = order * 10 + 1;
          }

          constructor(value: number) {
            void value;
          }
        })(order = order * 10 + 2);

        export function test(): number {
          void instance;
          return order;
        }
      `),
    ).toBe(12);
  });
});
