import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "class-expression-private-receiver.ts",
    platform: "node",
    skipSemanticDiagnostics: true,
    target: "gc",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setInstance?.(instance);
  return (instance.exports.runCase as () => number)();
}

describe("#4301 class-expression private receiver identity", () => {
  it("reads a private field through a var-bound anonymous class method", async () => {
    expect(
      await run(`
        var Router = class {
          #routes = [1, 2];
          size() { return this.#routes.length; }
        };
        export function runCase() { return new Router().size(); }
      `),
    ).toBe(2);
  });

  it("selects the canonical class-expression method for a structural receiver", async () => {
    expect(
      await run(`
        interface RouterShape { buildAllMatchers(): number; }
        var Router = class {
          #routes = [1, 2, 3];
          buildAllMatchers() { return this.#routes.length; }
        };
        function invoke<R extends RouterShape>(router: R): number {
          return router.buildAllMatchers();
        }
        export function runCase() { return invoke(new Router()); }
      `),
    ).toBe(3);
  });

  it("resolves an anonymous class private method on a dynamically typed receiver", async () => {
    expect(
      await run(`
        var Router = class {
          #routes = [1, 2, 3, 4];
          #buildMatcher(method: string) { return this.#routes.length + method.length; }
          buildAllMatchers(receiver: any) { return receiver.#buildMatcher("GET"); }
        };
        export function runCase() {
          const router = new Router();
          return router.buildAllMatchers(router);
        }
      `),
    ).toBe(7);
  });

  it("keeps a captured this tied to each duplicate class-expression body", async () => {
    expect(
      await run(`
        var Router = class {
          #routes = [1, 2, 3, 4, 5];
          #buildMatcher(method: string) { return this.#routes.length + method.length; }
          buildAllMatchers() {
            return ["GET"].map((method) => this.#buildMatcher(method))[0];
          }
        };
        export function runCase() { return new Router().buildAllMatchers(); }
      `),
    ).toBe(8);
  });

  it("dispatches inherited private calls to the lexical base declaration", async () => {
    expect(
      await run(`
        class Base {
          #value = 3;
          #read() { return this.#value; }
          read() { return this.#read(); }
        }
        class Derived extends Base {
          #read() { return 100; }
        }
        export function runCase() { return new Derived().read(); }
      `),
    ).toBe(3);
  });
});
