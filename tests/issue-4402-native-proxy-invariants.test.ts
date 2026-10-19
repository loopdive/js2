// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const NATIVE_INVARIANT_SOURCE = `
function throwsTypeError(f: () => void): number {
  try { f(); } catch (error) { return error instanceof TypeError ? 1 : 0; }
  return 0;
}

export function test(): number {
  let out = 0;

  const fixedGetTarget: any = {};
  Object.defineProperty(fixedGetTarget, "fixed", {
    value: 1, writable: false, enumerable: true, configurable: false,
  });
  const fixedGetProxy: any = new Proxy(fixedGetTarget, {
    get: function () { return 2; },
  });
  out += throwsTypeError(function () { const value = fixedGetProxy.fixed; });

  const duplicateKeysProxy: any = new Proxy({ a: 1 }, {
    ownKeys: function () { return ["a", "a"]; },
  });
  out += throwsTypeError(function () { Reflect.ownKeys(duplicateKeysProxy); }) * 2;

  const missingKeyTarget: any = {};
  Object.defineProperty(missingKeyTarget, "fixed", {
    value: 1, writable: true, enumerable: true, configurable: false,
  });
  const missingKeyProxy: any = new Proxy(missingKeyTarget, {
    ownKeys: function () { return []; },
  });
  out += throwsTypeError(function () { Reflect.ownKeys(missingKeyProxy); }) * 4;

  const extraKeyTarget: any = { a: 1 };
  Object.preventExtensions(extraKeyTarget);
  const extraKeyProxy: any = new Proxy(extraKeyTarget, {
    ownKeys: function () { return ["a", "extra"]; },
  });
  out += throwsTypeError(function () { Reflect.ownKeys(extraKeyProxy); }) * 8;

  const hiddenDescriptorTarget: any = {};
  Object.defineProperty(hiddenDescriptorTarget, "fixed", {
    value: 1, writable: true, enumerable: true, configurable: false,
  });
  const hiddenDescriptorProxy: any = new Proxy(hiddenDescriptorTarget, {
    getOwnPropertyDescriptor: function () { return undefined; },
  });
  out += throwsTypeError(function () {
    Object.getOwnPropertyDescriptor(hiddenDescriptorProxy, "fixed");
  }) * 16;

  const prototypeTarget: any = {};
  const actualPrototype: any = {};
  const falsePrototype: any = {};
  Object.setPrototypeOf(prototypeTarget, actualPrototype);
  Object.preventExtensions(prototypeTarget);
  const prototypeProxy: any = new Proxy(prototypeTarget, {
    getPrototypeOf: function () { return falsePrototype; },
  });
  out += throwsTypeError(function () { Object.getPrototypeOf(prototypeProxy); }) * 32;

  const setPrototypeTarget: any = {};
  Object.preventExtensions(setPrototypeTarget);
  const setPrototypeProxy: any = new Proxy(setPrototypeTarget, {
    setPrototypeOf: function () { return true; },
  });
  out += throwsTypeError(function () { Object.setPrototypeOf(setPrototypeProxy, {}); }) * 64;

  const deleteTarget: any = {};
  Object.defineProperty(deleteTarget, "fixed", {
    value: 1, writable: true, enumerable: true, configurable: false,
  });
  const deleteProxy: any = new Proxy(deleteTarget, {
    deleteProperty: function () { return true; },
  });
  out += throwsTypeError(function () { delete deleteProxy.fixed; }) * 128;

  const defineTarget: any = {};
  Object.preventExtensions(defineTarget);
  const defineProxy: any = new Proxy(defineTarget, {
    defineProperty: function () { return true; },
  });
  out += throwsTypeError(function () {
    Object.defineProperty(defineProxy, "newKey", { value: 1 });
  }) * 256;

  return out;
}
`;

const BOUNDARY_INVARIANT_SOURCE = `
function throwsTypeError(f: () => void): number {
  try { f(); } catch (error) { return error instanceof TypeError ? 1 : 0; }
  return 0;
}

export function test(target: any, falsePrototype: any): number {
  let out = 0;

  const fixedGetProxy: any = new Proxy(target, {
    get: function () { return 2; },
  });
  out += throwsTypeError(function () { const value = fixedGetProxy.fixed; });

  const duplicateKeysProxy: any = new Proxy(target, {
    ownKeys: function () { return ["fixed", "fixed"]; },
  });
  out += throwsTypeError(function () { Reflect.ownKeys(duplicateKeysProxy); }) * 2;

  const missingKeyProxy: any = new Proxy(target, {
    ownKeys: function () { return []; },
  });
  out += throwsTypeError(function () { Reflect.ownKeys(missingKeyProxy); }) * 4;

  const extraKeyProxy: any = new Proxy(target, {
    ownKeys: function () { return ["fixed", "extra"]; },
  });
  out += throwsTypeError(function () { Reflect.ownKeys(extraKeyProxy); }) * 8;

  const hiddenDescriptorProxy: any = new Proxy(target, {
    getOwnPropertyDescriptor: function () { return undefined; },
  });
  out += throwsTypeError(function () {
    Object.getOwnPropertyDescriptor(hiddenDescriptorProxy, "fixed");
  }) * 16;

  const prototypeProxy: any = new Proxy(target, {
    getPrototypeOf: function () { return falsePrototype; },
  });
  out += throwsTypeError(function () { Object.getPrototypeOf(prototypeProxy); }) * 32;

  const setPrototypeProxy: any = new Proxy(target, {
    setPrototypeOf: function () { return true; },
  });
  out += throwsTypeError(function () { Object.setPrototypeOf(setPrototypeProxy, falsePrototype); }) * 64;

  const deleteProxy: any = new Proxy(target, {
    deleteProperty: function () { return true; },
  });
  out += throwsTypeError(function () { delete deleteProxy.fixed; }) * 128;

  const defineProxy: any = new Proxy(target, {
    defineProperty: function () { return true; },
  });
  out += throwsTypeError(function () {
    Object.defineProperty(defineProxy, "newKey", { value: 1 });
  }) * 256;

  return out;
}
`;

async function compileAndRun(
  source: string,
  options: { target?: "standalone"; semanticProviders?: "native-first" },
): Promise<{ result: Awaited<ReturnType<typeof compile>>; exports: Record<string, (...args: any[]) => any> }> {
  const result = await compile(source, { fileName: "issue-4402-proxy-invariants.ts", ...options });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);

  if (options.target === "standalone") {
    expect(result.imports ?? [], "standalone module must import nothing").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return { result, exports: instance.exports as Record<string, (...args: any[]) => any> };
  }

  expect(result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual([]);
  expect(result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return { result, exports: wrapCompiledExports(result, instance) };
}

describe("#4402 native Proxy MOP invariants", () => {
  it.each([
    ["standalone", { target: "standalone" as const }],
    ["native-first JavaScript", { semanticProviders: "native-first" as const }],
  ])("enforces descriptor, key-set, prototype, delete, and define invariants in %s", async (_lane, options) => {
    const { exports } = await compileAndRun(NATIVE_INVARIANT_SOURCE, options);
    expect(exports.test()).toBe(511);
  });

  it("enforces native invariants when the Proxy target is an admitted caller-owned JS object", async () => {
    const { exports } = await compileAndRun(BOUNDARY_INVARIANT_SOURCE, { semanticProviders: "native-first" });
    const actualPrototype = {};
    const falsePrototype = {};
    const target = {};
    Object.setPrototypeOf(target, actualPrototype);
    Object.defineProperty(target, "fixed", {
      value: 1,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    Object.preventExtensions(target);
    expect(exports.test(target, falsePrototype)).toBe(511);
  });
});
