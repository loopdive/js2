// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4291 — An imported alias in `extends` still names the exact base class.
// Anonymous class-expression display names and local import spellings are not
// a substitute for that declaration identity.
import { describe, expect, it } from "vitest";

import { compileMulti, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports;
}

describe("#4291 imported class-alias heritage identity", () => {
  it("lets an inherited method read the aliased base fields from a subclass", async () => {
    const result = await compileMulti(
      {
        "./base.js": `
          var InternalBase = class _InternalBase {
            value = 40;
            result() { return this.value + 2; }
          };
          export { InternalBase as PublicBase };
        `,
        "./entry.js": `
          import { PublicBase as BaseAlias } from "./base.js";
          var Derived = class extends BaseAlias {
            marker = 1;
          };
          export function runCase() { return new Derived().result(); }
        `,
      },
      "./entry.js",
      {
        allowJs: true,
        platform: "node",
        skipSemanticDiagnostics: true,
        target: "gc",
      },
    );
    const exports = await instantiate(result);

    expect((exports.runCase as () => number)()).toBe(42);
  });
});
