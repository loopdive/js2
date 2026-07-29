// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile, compileMulti } from "../src/index.js";

describe("#3782 linked standalone module initialization", () => {
  it("does not carry defineProperty state across source compilation passes", async () => {
    const result = await compileMulti(
      {
        "dependency.js": `
          var state = {};
          Object.defineProperty(state, "value", { value: 7 });
          /** @returns {number} */
          export function readValue() { return state.value; }
        `,
        "entry.js": `
          import { readValue } from "./dependency.js";
          /** @returns {number} */
          export function test() { return readValue(); }
        `,
      },
      "entry.js",
      {
        allowJs: true,
        skipSemanticDiagnostics: true,
        optimize: 4,
        target: "standalone",
      },
    );

    expect(result.success).toBe(true);
    const module = await WebAssembly.compile(result.binary!);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(7);
  });

  it("expands a stable runtime-filled accessor map on a function prototype", async () => {
    const result = await compile(
      `
        var Parser = function Parser() { this.value = 40; };
        var accessors = {
          first: { configurable: true },
          second: { configurable: true }
        };
        accessors.first.get = function () { return this.value; };
        accessors.second.get = function () { return 2; };
        Object.defineProperties(Parser.prototype, accessors);
        /** @returns {number} */
        export function test() {
          var parser = new Parser();
          return parser.first + parser.second;
        }
      `,
      {
        fileName: "acorn-accessors.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
        optimize: 4,
        target: "standalone",
        deferTopLevelInit: true,
      },
    );

    expect(result.success).toBe(true);
    const module = await WebAssembly.compile(result.binary!);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    (instance.exports.__module_init as () => void)();
    expect((instance.exports.test as () => number)()).toBe(42);
  });
});
