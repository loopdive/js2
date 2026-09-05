// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4233 follow-up — the ambient RegExp constructor must remain constructable
// when it is obtained through RegExp.prototype.constructor. TypeScript reports
// that property as the broad `Function` type, so the standalone new dispatcher
// must use the binding/prototype identity rather than the checker signature.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const source = `export function test(): number { ${body} }`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "regexp-constructor-alias.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4233 RegExp.prototype.constructor aliases", () => {
  it("constructs through a direct prototype constructor alias", async () => {
    const result = await runStandalone(`
      var factory = RegExp.prototype.constructor;
      var instance = new factory;
      return instance.constructor === RegExp ? 1 : 0;
    `);
    expect(result).toBe(1);
  });

  it("constructs when the prototype constructor is used directly", async () => {
    const result = await runStandalone(`
      var instance = new RegExp.prototype.constructor;
      return instance.constructor === RegExp ? 1 : 0;
    `);
    expect(result).toBe(1);
  });

  it("follows a second variable alias without treating it as a plain object", async () => {
    const result = await runStandalone(`
      var factory = RegExp.prototype.constructor;
      var alias = factory;
      var instance = new alias;
      return instance.constructor === RegExp ? 1 : 0;
    `);
    expect(result).toBe(1);
  });
});
