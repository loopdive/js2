// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1712 — compiled fnctor prototype recursion must not retain host frames.
//
// Acorn's recursive-descent parser installs methods through an aliased
// prototype and calls them through `this`. The generic host method bridge
// resolved each method and immediately called back into Wasm, retaining one JS
// frame per parser edge. A valid deep function input consequently overflowed
// the host stack. The raw-callable lookup now returns before the private Wasm
// driver invokes the closure.
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

describe("#1712 stack-flat compiled fnctor method recursion", () => {
  it("keeps a deep aliased-prototype call chain inside Wasm", async () => {
    const exports = await instantiate(`
      function Parser() {
        this.visits = 0;
      }
      const pp = Parser.prototype;
      pp.descend = function (remaining, unused) {
        if (unused !== undefined) return -1000;
        this.visits = this.visits + 1;
        if (remaining === 0) return this.visits;
        return this.descend(remaining - 1);
      };

      export function run() {
        const parser = new Parser();
        return parser.descend(600);
      }

      export function runHostOverride() {
        const parser = new Parser();
        parser.descend = Math.abs;
        return parser.descend(-7);
      }
    `);

    expect(exports.run()).toBe(601);
    expect(exports.runHostOverride()).toBe(7);
  });
});
