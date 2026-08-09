import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const result: CompileResult = await compile(source, {
    allowJs: true,
    fileName: "conditional-capture.js",
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
  imports.setInstance?.(instance);
  return (instance.exports.runCase as () => number)();
}

describe("#4297 conditional closure parameter boxing", () => {
  it("initializes a captured constructor parameter when its branch is skipped", async () => {
    expect(
      await run(`
        class Box {
          value = 0;
          constructor(path, buildClosure) {
            if (buildClosure) {
              const read = () => path.length;
              if (read() < 0) return;
            }
            path += "!";
            this.value = path.length;
          }
        }
        export function runCase() {
          return new Box("/a", false).value;
        }
      `),
    ).toBe(3);
  });

  it("initializes a captured setter parameter when its branch is skipped", async () => {
    expect(
      await run(`
        class Box {
          result = 0;
          set value(path) {
            if (this.result < 0) {
              const read = () => path.length;
              if (read() < 0) return;
            }
            path += "!";
            this.result = path.length;
          }
        }
        export function runCase() {
          const box = new Box();
          box.value = "/a";
          return box.result;
        }
      `),
    ).toBe(3);
  });

  it("initializes a captured getter local when its branch is skipped", async () => {
    expect(
      await run(`
        class Box {
          buildClosure = false;
          get value() {
            let value = 3;
            if (this.buildClosure) {
              const read = () => value;
              if (read() < 0) return 0;
            }
            const before = value;
            value = 4;
            return before * 10 + value;
          }
        }
        export function runCase() {
          return new Box().value;
        }
      `),
    ).toBe(34);
  });

  it("does not hoist across a for-in declaration write to the captured parameter", async () => {
    expect(
      await run(`
        function f(path) {
          let result = 0;
          for (var path in { longer: 1 }) {
            const read = () => path.length;
            result = read() * 10 + path.length;
          }
          path += "!";
          return result;
        }
        export function runCase() {
          return f("/a");
        }
      `),
    ).toBe(66);
  });

  it("initializes a captured local before a skipped construction branch", async () => {
    expect(
      await run(`
        function add(buildClosure) {
          "use strict";
          let value = 3;
          if (buildClosure) {
            const read = () => value;
            if (read() < 0) return 0;
          }
          const before = value;
          value = 4;
          return before * 10 + value;
        }
        export function runCase() {
          return add(false);
        }
      `),
    ).toBe(34);
  });

  it("initializes a mutable captured strict-function parameter when its branch is skipped", async () => {
    expect(
      await run(`
        function add(path, initialize) {
          "use strict";
          if (initialize) {
            const read = () => path.length;
            if (read() < 0) return 0;
          }
          path += "!";
          return path.length;
        }
        export function runCase() {
          return add("/a", true) * 10 + add("/a", false);
        }
      `),
    ).toBe(33);
  });

  it("initializes a mutable captured method parameter when the closure branch is skipped", async () => {
    expect(
      await run(`
        class Router {
          add(path, initialize) {
            if (initialize) {
              const read = () => path.length;
              if (read() < 0) return 0;
            }
            path += "!";
            return path.length;
          }
        }
        export function runCase() {
          const router = new Router();
          return router.add("/a", true) * 10 + router.add("/a", false);
        }
      `),
    ).toBe(33);
  });

  it("preserves a preceding parameter normalization across nested skipped branches", async () => {
    expect(
      await run(`
        class Router {
          add(path, enterOuter, buildClosure) {
            if (path === "/*") path = "*";
            if (enterOuter) {
              if (buildClosure) {
                const read = () => path.length;
                if (read() < 0) return 0;
              }
            }
            path += "!";
            return path.length;
          }
        }
        export function runCase() {
          const router = new Router();
          return router.add("/*", true, false) * 10 + router.add("/a", false, false);
        }
      `),
    ).toBe(23);
  });
});
