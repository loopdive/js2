// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4295 — an any-typed receiver cannot be assigned to the first source class
// that happens to own the same method name; runtime class identity must decide.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "runtime-user-class-method-dispatch.js",
    platform: "node",
    skipSemanticDiagnostics: true,
    target: "gc",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports.runCase as () => number)();
}

describe("#4295 runtime user-class method dispatch", () => {
  it("dispatches an any-typed inherited router field by runtime class", async () => {
    expect(
      await run(`
        class FirstRouter {
          #value = -1;
          extra = 0;
          add() { return this.#value; }
        }
        class SelectedRouter {
          #value = 42;
          add() { return this.#value; }
        }
        class Base {
          router;
          run() { return this.router.add(); }
        }
        class App extends Base {
          constructor() {
            super();
            this.router = new SelectedRouter();
          }
        }
        export function runCase() { return new App().run(); }
      `),
    ).toBe(42);
  });

  it("is independent of unrelated class declaration order", async () => {
    expect(
      await run(`
        class SelectedRouter {
          #value = 42;
          add() { return this.#value; }
        }
        class WrongRouter {
          #value = -1;
          extra = 0;
          add() { return this.#value; }
        }
        function invoke(router) { return router.add(); }
        export function runCase() { return invoke(new SelectedRouter()); }
      `),
    ).toBe(42);
  });

  it("preserves a dynamic spread argument vector for the selected class method", async () => {
    expect(
      await run(`
        class WrongRouter {
          marker = 0;
          add(method, path, value) { return -1; }
        }
        class SelectedRouter {
          add(method, path, value) {
            return method.length * 100 + path.length * 10 + value;
          }
        }
        function invoke(router, route) { return router.add(...route); }
        export function runCase() {
          return invoke(new SelectedRouter(), ["GET", "/x", 2]);
        }
      `),
    ).toBe(322);
  });
});
