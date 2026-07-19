// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(
  source: string,
  exportName: string,
  fileName = "issue-3374.ts",
  deferTopLevelInit = false,
): Promise<number> {
  // Match the Test262 script-goal wrapper: the synthetic exports do not make a
  // noStrict script strict, while explicit function directives still do.
  const result = await compile(source, { fileName, inferModuleStrictArguments: false, deferTopLevelInit });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setExports?: (exports: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
  (instance.exports.__module_init as (() => void) | undefined)?.();
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

  function strictComputedWrite(obj: any, name: any): number {
    "use strict";
    try { obj[name] = "unlikely"; } catch (error) {
      return error instanceof TypeError ? 1 : -1;
    }
    return 0;
  }

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

  export function strictComputedBuiltinWrites(): number {
    "use strict";
    const name: any = "name";
    let score = strictComputedWrite(Object.isSealed, name);
    const getter: any = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get;
    score += strictComputedWrite(getter, name) * 10;
    return score;
  }

  export function sloppyBuiltinWrite(): number {
    const before = Math.PI;
    try { (Math as any).PI = 20; } catch (error) { return 0; }
    return Math.PI === before ? 1 : 0;
  }
`;

const CHECKED_JS_SOURCE = `
  "use strict";
  // @ts-check
  /**
   * @param {object} obj
   * @param {string|symbol} name
   */
  function strictComputedWrite(obj, name) {
    try { obj[name] = "unlikely"; } catch (error) {
      return error instanceof TypeError ? 1 : -1;
    }
    return 0;
  }

  var score = strictComputedWrite(Object.isSealed, "name");
  var getter = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength").get;
  score += strictComputedWrite(getter, "name") * 10;

  export function test() {
    return score;
  }
`;

const DYNAMIC_JS_SAME_VALUE_SOURCE = `
  // @ts-check
  function isSameValue(a, b) {
    if (a === 0 && b === 0) return 1 / a === 1 / b;
    if (a !== a && b !== b) return true;
    return a === b;
  }

  function propertyMatches(obj, name, expected) {
    return isSameValue(obj[name], expected);
  }

  export function test() {
    return propertyMatches(Object.isSealed, "name", "unlikelyValue") ? 1 : 0;
  }
`;

describe("#3374 strict assignment failures", () => {
  it("throws for failed strict object writes while sloppy writes remain no-ops", async () => {
    expect(await run(SOURCE, "strictObjectWrites")).toBe(1111);
    expect(await run(SOURCE, "sloppyObjectWrites")).toBe(1111);
  });

  it("throws for strict writes to non-writable built-ins and globals", async () => {
    expect(await run(SOURCE, "strictBuiltinWrites")).toBe(11111);
    expect(await run(SOURCE, "strictComputedBuiltinWrites")).toBe(11);
    expect(await run(SOURCE, "sloppyBuiltinWrite")).toBe(1);
  });

  it("keeps computed host writes catchable in checked JavaScript helpers", async () => {
    expect(await run(CHECKED_JS_SOURCE, "test", "issue-3374.js", true)).toBe(11);
  });

  it("does not numerically specialize generic JavaScript SameValue helpers", async () => {
    expect(await run(DYNAMIC_JS_SAME_VALUE_SOURCE, "test", "issue-3374-dynamic.js")).toBe(0);
  });
});
