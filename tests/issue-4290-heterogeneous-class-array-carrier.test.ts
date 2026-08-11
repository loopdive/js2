// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4290 — An unannotated array containing instances of unrelated classes needs
// a carrier that can hold both runtime identities. The first element's concrete
// struct is not a sound carrier for later elements.
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

describe("#4290 heterogeneous class array carrier", () => {
  it("preserves two unrelated imported class instances", async () => {
    const result = await compileMulti(
      {
        "./first.js": `
          function match() { return 17; }
          var FirstRouter = class {
            name = "FirstRouter";
            #middleware;
            #routes;
            constructor() {
              this.#middleware = { all: Object.create(null) };
              this.#routes = { all: Object.create(null) };
            }
            match = match;
          };
          export { FirstRouter };
        `,
        "./second.js": `
          var Node = class {
            #children;
            constructor() { this.#children = Object.create(null); }
          };
          var SecondRouter = class {
            name = "SecondRouter";
            #node;
            constructor() { this.#node = new Node(); }
            match() { return 25; }
          };
          export { SecondRouter };
        `,
        "./smart.js": `
          var SmartRouter = class {
            #routers = [];
            constructor(init) { this.#routers = init.routers; }
            result() { return this.#routers[0].name.length + this.#routers[1].name.length + 19; }
          };
          export { SmartRouter };
        `,
        "./entry.js": `
          import { FirstRouter } from "./first.js";
          import { SecondRouter } from "./second.js";
          import { SmartRouter } from "./smart.js";

          export function runCase() {
            const router = new SmartRouter({
              routers: [new FirstRouter(), new SecondRouter()]
            });
            return router.result();
          }
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
