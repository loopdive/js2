// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1712 — dynamic indexed writes to a WasmGC vec were silently ignored.
//
// Acorn builds its token table at module initialization and then installs
// context callbacks with assignments such as:
//
//   this.context[index] = types.f_gen;
//
// `this.context` is stored on a dynamically dispatched Parser instance. Its
// indexed assignment therefore crosses `__extern_set_strict` with the raw vec
// as receiver. The old host path accepted the write into the opaque WasmGC
// handle but never called the module's vec element setter. The context stayed
// `f_stat`, so `yield` was not recognized as generator context and `/` was
// tokenized as division rather than as a RegExp literal.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(source: string): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool) as WebAssembly.Imports & {
    setExports?: (exports: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

describe("#1712 dynamic indexed write to a WasmGC vec", () => {
  it("updates the live element used by later reads", async () => {
    const exports = await instantiate(`
      function Context(name, generator) {
        this.name = name;
        this.generator = generator;
      }
      const types = {
        f_stat: new Context("function", false),
        f_gen: new Context("function", true)
      };
      function Parser() {
        this.context = [types.f_stat];
      }
      function markGenerator(parser) {
        const index = parser.context.length - 1;
        parser.context[index] = types.f_gen;
      }

      export function run() {
        const parser = new Parser();
        markGenerator(parser);
        return parser.context[0] === types.f_gen && parser.context[0].generator ? 1 : 0;
      }
    `);

    expect(exports.run()).toBe(1);
  });
});
