// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, exportName: string): Promise<number> {
  // Match the Test262 script-goal wrapper: the synthetic exports do not make a
  // noStrict script strict, while explicit function directives still do.
  const result = await compile(source, { fileName: "issue-3374.ts", inferModuleStrictArguments: false });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setExports?: (exports: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
  return (instance.exports as Record<string, () => number>)[exportName]!();
}

const SOURCE = `
  const descriptorObject: any = {};
  Object.defineProperty(descriptorObject, "locked", {
    value: 10, writable: false, enumerable: true, configurable: true
  });
  Object.defineProperty(descriptorObject, "getterOnly", {
    get: function () { return 11; }, set: undefined,
    enumerable: true, configurable: true
  });

  const closedObject: any = {};
  Object.preventExtensions(closedObject);

  export function strictObjectWrites(): number {
    "use strict";
    let score = 0;
    try { descriptorObject.locked = 20; } catch (error) {
      if (error instanceof TypeError) score += 1;
    }
    try { descriptorObject.getterOnly = 20; } catch (error) {
      if (error instanceof TypeError) score += 10;
    }
    try { closedObject.added = 20; } catch (error) {
      if (error instanceof TypeError) score += 100;
    }
    if (descriptorObject.locked === 10) score += 1000;
    return score;
  }

  export function sloppyObjectWrites(): number {
    let score = 0;
    try { descriptorObject.locked = 20; score += 1; } catch (error) {}
    try { descriptorObject.getterOnly = 20; score += 10; } catch (error) {}
    try { closedObject.added = 20; score += 100; } catch (error) {}
    if (descriptorObject.locked === 10) score += 1000;
    return score;
  }

  export function strictBuiltinWrites(): number {
    "use strict";
    let score = 0;
    try { (Number as any).MAX_VALUE = 42; } catch (error) {
      if (error instanceof TypeError) score += 1;
    }
    try { (Math as any).PI = 20; } catch (error) {
      if (error instanceof TypeError) score += 10;
    }
    try { (Function as any).length = 42; } catch (error) {
      if (error instanceof TypeError) score += 100;
    }
    const globalObject: any = globalThis;
    try { globalObject.Infinity = 42; } catch (error) {
      if (error instanceof TypeError) score += 1000;
    }
    try { globalObject.undefined = 42; } catch (error) {
      if (error instanceof TypeError) score += 10000;
    }
    return score;
  }

  export function sloppyBuiltinWrite(): number {
    const before = Math.PI;
    try { (Math as any).PI = 20; } catch (error) { return 0; }
    return Math.PI === before ? 1 : 0;
  }
`;

describe("#3374 strict assignment failures", () => {
  it("throws for failed strict object writes while sloppy writes remain no-ops", async () => {
    expect(await run(SOURCE, "strictObjectWrites")).toBe(1111);
    expect(await run(SOURCE, "sloppyObjectWrites")).toBe(1111);
  });

  it("throws for strict writes to non-writable built-ins and globals", async () => {
    expect(await run(SOURCE, "strictBuiltinWrites")).toBe(11111);
    expect(await run(SOURCE, "sloppyBuiltinWrite")).toBe(1);
  });
});
