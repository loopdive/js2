// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4288 — Every `var X = class {}` in published JavaScript has a distinct
// binding identity. TypeScript calls each anonymous class symbol `__class`, so
// constructor lowering must follow the imported binding instead of a global
// last-writer mapping for that internal display name.
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

describe("#4288 imported anonymous-class constructor identity", () => {
  it("constructs each imported class-expression binding rather than the enclosing class", async () => {
    const result = await compileMulti(
      {
        "./first.js": `
          var FirstRouter = class {
            constructor() { this.value = 17; }
          };
          export { FirstRouter };
        `,
        "./second.js": `
          var SecondRouter = class {
            constructor() { this.value = 25; }
          };
          export { SecondRouter };
        `,
        "./entry.js": `
          import { FirstRouter } from "./first.js";
          import { SecondRouter } from "./second.js";

          var App = class {
            constructor() {
              this.first = new FirstRouter();
              this.second = new SecondRouter();
            }
            result() { return this.first.value + this.second.value; }
          };

          export function runCase() { return new App().result(); }
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
