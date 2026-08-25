// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4676 — standalone `%Function.prototype%[@@hasInstance]` value and receiver
// semantics. The fixture keeps constructors at module scope so the compiler's
// closure/prototype identity edge is exercised exactly as in test262's JS rows.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, exportName: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-4676-function-prototype-hasinstance.ts",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => number>)[exportName]();
}

describe("#4676 standalone Function.prototype @@hasInstance", () => {
  it("preserves the value and receiver for positive, negative, primitive, and bound cases", async () => {
    const source = `
      var F = function() {};
      var instance = new F();
      var bound = F.bind(null);
      export function positive(): number { return F[Symbol.hasInstance](instance) ? 1 : 0; }
      export function negative(): number { return F[Symbol.hasInstance](Object.create(null)) ? 1 : 0; }
      export function primitive(): number { return F[Symbol.hasInstance](null) ? 1 : 0; }
      export function boundCase(): number { return bound[Symbol.hasInstance](instance) ? 1 : 0; }
    `;

    expect(await runStandalone(source, "positive")).toBe(1);
    expect(await runStandalone(source, "negative")).toBe(0);
    expect(await runStandalone(source, "primitive")).toBe(0);
    expect(await runStandalone(source, "boundCase")).toBe(1);
  });

  it("keeps custom non-object prototypes on the ordinary TypeError path", async () => {
    const source = `
      var F = function() {};
      export function undefinedPrototype(): number {
        F.prototype = undefined;
        try { F[Symbol.hasInstance]({}); return 0; } catch { return 1; }
      }
      export function nullPrototype(): number {
        F.prototype = null;
        try { F[Symbol.hasInstance]({}); return 0; } catch { return 1; }
      }
    `;

    expect(await runStandalone(source, "undefinedPrototype")).toBe(1);
    expect(await runStandalone(source, "nullPrototype")).toBe(1);
  });

  it("keeps a non-callable explicit receiver false", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          return Function.prototype[Symbol.hasInstance].call({}, {}) ? 1 : 0;
        }`,
        "test",
      ),
    ).toBe(0);
  });
});
