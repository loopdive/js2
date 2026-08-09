// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4294 — source rest parameters are one vec-typed Wasm formal. Calls must
// pack every trailing JavaScript argument into that vec, including zero args.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
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

async function run(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "closure-rest-argument-packing.js",
    platform: "node",
    skipSemanticDiagnostics: true,
    target: "gc",
  });
  const exports = await instantiate(result);
  return (exports.runCase as () => number)();
}

describe("#4294 closure rest argument packing", () => {
  it("packs zero trailing arguments into an empty rest vector", async () => {
    expect(
      await run(
        `const probe = (base, sub, ...rest) => rest.length; export function runCase() { return probe("/", "/api") + 42; }`,
      ),
    ).toBe(42);
  });

  it("packs multiple positional values into the rest vector", async () => {
    expect(
      await run(`
        const probe = (base, ...rest) => rest.length * 100 + rest[0] * 10 + rest[1];
        export function runCase() { return probe(0, 1, 2); }
      `),
    ).toBe(212);
  });

  it("packs trailing arguments for a dynamically installed class-field closure", async () => {
    expect(
      await run(`
        const methods = ["get"];
        class App {
          get;
          count = 0;
          routes = [];
          constructor() {
            methods.forEach((method) => {
              this[method] = (path, ...handlers) => {
                this.count = handlers.length;
                handlers.forEach((handler) => this.routes.push({ path, handler }));
              };
            });
          }
        }
        export function runCase() {
          const app = new App();
          if (app.get == null) return -2;
          app.get("/users", () => 1);
          return app.count * 10 + app.routes.length;
        }
      `),
    ).toBe(11);
  });

  it("expands a spread source into the rest vector", async () => {
    expect(
      await run(`
        const probe = (base, ...rest) => rest.length * 10 + rest[0] + rest[1];
        export function runCase() {
          const values = [2, 3];
          return probe(1, ...values);
        }
      `),
    ).toBe(25);
  });

  it("does not enter a recursive arrow rest branch when no rest arguments were passed", async () => {
    expect(
      await run(`
        const probe = (base, sub, ...rest) => {
          if (rest.length) sub = probe(sub, ...rest);
          return 42;
        };
        export function runCase() { return probe("/", "/api"); }
      `),
    ).toBe(42);
  });

  it("runs Hono's recursive mergePath shape", async () => {
    expect(
      await run(`
        const mergePath = (base, sub, ...rest) => {
          if (rest.length) sub = mergePath(sub, ...rest);
          return \`${'${base?.[0] === "/" ? "" : "/"}'}${"${base}"}${'${sub === "/" ? "" : `\${base?.at(-1) === "/" ? "" : "/"}\${sub?.[0] === "/" ? sub.slice(1) : sub}`}'}\`;
        };
        export function runCase() {
          if (mergePath("/", "/api") !== "/api") return -1;
          if (mergePath("api", "v1") !== "/api/v1") return -2;
          if (mergePath("api", "v1", "items") !== "/api/v1/items") return -3;
          return 42;
        }
      `),
    ).toBe(42);
  });

  it("preserves fixed and rest arguments in a dynamic three-parameter closure", async () => {
    expect(
      await run(`
        class App {
          on;
          count = 0;
          constructor() {
            this.on = (method, path, ...handlers) => {
              const paths = [path].flat();
              const methods = [method].flat();
              this.count = paths.length * 100 + methods.length * 10 + handlers.length;
            };
          }
        }
        export function runCase() {
          const app = new App();
          app.on(["GET", "PUT"], ["/health", "/status"], () => 1);
          return app.count;
        }
      `),
    ).toBe(221);
  });
});
