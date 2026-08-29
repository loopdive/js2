// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

async function instantiate(result: Awaited<ReturnType<typeof compile>>) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

const FACTORY = `
      interface Factory { ci(t: number): number; }
      function makeFactory(seed: number): Factory {
        return { ci(t: number): number { return seed + t; } };
      }
`;

/**
 * (#1058) A method on an object literal built INSIDE a function must survive
 * being extracted as a value.
 *
 * `compileObjectLiteralForStruct` emits the struct's field values before it
 * registers the literal's method functions, so a literal whose methods are seen
 * for the first time during construction found `ctx.funcMap` empty and stored
 * `undefined` in the method's field. Calling through the receiver still worked
 * (that dispatches statically), so the defect only showed when the method was
 * read out as a value — which is exactly what the TypeScript parser does:
 * `parser.ts` destructures `createIdentifier` and ~25 siblings off the object
 * `createNodeFactory` returns, then calls them. The extracted binding read
 * undefined and trapped with "dereferencing a null pointer".
 */
describe("#1058 object-literal method extracted as a value", () => {
  it("survives a renamed destructure inside a namespace (the parser.ts shape)", async () => {
    const result = await compile(`${FACTORY}
      namespace Parser {
        var factory = makeFactory(100);
        var { ci: factoryCreateIdentifier } = factory;

        function createIdentifier(isIdentifier: boolean): number {
          if (isIdentifier) return factoryCreateIdentifier(7);
          return -1;
        }
        function parseIdentifier(): number { return createIdentifier(true); }
        export function parsePrimaryExpression(): number { return parseIdentifier(); }
      }
      export function test(): number { return Parser.parsePrimaryExpression(); }
    `);
    expect((await instantiate(result)).test()).toBe(107);
  });

  it("survives a module-level alias when the method captures nothing", async () => {
    const result = await compile(`
      interface Factory { ci(t: number): number; }
      function makeFactory(): Factory { return { ci(t: number): number { return 100 + t; } }; }
      const factory = makeFactory();
      const extracted = factory.ci;
      export function test(): number { return extracted(7); }
    `);
    expect((await instantiate(result)).test()).toBe(107);
  });

  it("survives a module-level alias when the method captures a factory parameter", async () => {
    const result = await compile(`${FACTORY}
      const factory = makeFactory(100);
      const extracted = factory.ci;
      export function test(): number { return extracted(7); }
    `);
    expect((await instantiate(result)).test()).toBe(107);
  });

  it("survives an alias local to the calling function", async () => {
    const result = await compile(`${FACTORY}
      const factory = makeFactory(100);
      export function test(): number {
        const extracted = factory.ci;
        return extracted(7);
      }
    `);
    expect((await instantiate(result)).test()).toBe(107);
  });

  it("keeps the direct member call working", async () => {
    const result = await compile(`${FACTORY}
      const factory = makeFactory(100);
      export function test(): number { return factory.ci(7); }
    `);
    expect((await instantiate(result)).test()).toBe(107);
  });

  it("extracts several methods at once, as the parser's multi-name destructure does", async () => {
    const result = await compile(`
      interface Multi {
        a(x: number): number;
        b(x: number): number;
        c(x: number): number;
      }
      function makeMulti(seed: number): Multi {
        return {
          a(x: number): number { return seed + x; },
          b(x: number): number { return seed - x; },
          c(x: number): number { return seed * x; },
        };
      }
      const factory = makeMulti(100);
      const { a: fa, b: fb, c: fc } = factory;
      export function test(): number { return fa(7) * 10000 + fb(5) * 100 + fc(2) / 100; }
    `);
    expect((await instantiate(result)).test()).toBe(107 * 10000 + 95 * 100 + 2);
  });

  it("keeps `this` bound for a method that reads its receiver", async () => {
    const result = await compile(`
      interface Holder { base: number; get(): number; }
      function makeHolder(): Holder {
        return { base: 100, get(): number { return this.base + 7; } };
      }
      const holder = makeHolder();
      export function test(): number { return holder.get(); }
    `);
    expect((await instantiate(result)).test()).toBe(107);
  });
});
