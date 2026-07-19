// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source, {
    fileName: "test.ts",
    deferTopLevelInit: true,
    skipSemanticDiagnostics: true,
  });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join("\n"));
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  const exports = wrapExports(instance.exports, { signatures: result.exportSignatures });
  return (exports.test as () => unknown)();
}

describe("#3470 original-harness iterator helper resolution", () => {
  it("calls a generator helper during deferred module initialization", async () => {
    expect(
      await run(`
        function* g() {}
        const result = g().every(function(): boolean { return true; });
        export function test(): any { return typeof result; }
      `),
    ).toBe("boolean");
  });

  it("destructures the result of a lazy generator helper", async () => {
    expect(
      await run(`
        function* g() { yield 1; yield 2; }
        const iterator = g().drop(2);
        const { value, done } = iterator.next();
        export function test(): any { return typeof value + ":" + String(value) + ":" + String(done); }
      `),
    ).toBe("undefined:undefined:true");
  });

  it("preserves host undefined through externref object destructuring", async () => {
    expect(
      await run(`
        const source: any = { value: undefined };
        const { value } = source;
        export function test(): any { return typeof value + ":" + String(value); }
      `),
    ).toBe("undefined:undefined");
  });
});
