// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

async function run(source: string, target: Target): Promise<{ value: unknown; envImports: string[] }> {
  const result = await compile(source, { target, skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const imports = target === "standalone" ? {} : buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if ("setExports" in imports && typeof imports.setExports === "function") {
    imports.setExports(instance.exports);
  }
  return {
    value: (instance.exports as Record<string, () => unknown>).test(),
    envImports: result.imports.filter((i) => i.module === "env").map((i) => i.name),
  };
}

const INTRINSIC_RELATIONS = `
  export function test(): number {
    let n = 0;
    if (Object.getPrototypeOf(Object) === Function.prototype) n++;
    if (Object.getPrototypeOf(Function) === Function.prototype) n++;
    if (Object.getPrototypeOf(Array) === Function.prototype) n++;
    if (Object.getPrototypeOf(String) === Function.prototype) n++;
    if (Object.getPrototypeOf(Boolean) === Function.prototype) n++;
    if (Object.getPrototypeOf(Number) === Function.prototype) n++;
    if (Object.getPrototypeOf(Date) === Function.prototype) n++;
    if (Object.getPrototypeOf(RegExp) === Function.prototype) n++;
    if (Object.getPrototypeOf(Error) === Function.prototype) n++;
    if (Object.getPrototypeOf(EvalError) === Error) n++;
    if (Object.getPrototypeOf(RangeError) === Error) n++;
    if (Object.getPrototypeOf(ReferenceError) === Error) n++;
    if (Object.getPrototypeOf(SyntaxError) === Error) n++;
    if (Object.getPrototypeOf(TypeError) === Error) n++;
    if (Object.getPrototypeOf(URIError) === Error) n++;
    if (Object.getPrototypeOf(Math) === Object.prototype) n++;
    if (Object.getPrototypeOf(JSON) === Object.prototype) n++;
    if (Object.getPrototypeOf(true) === Boolean.prototype) n++;
    if (Object.getPrototypeOf("x") === String.prototype) n++;
    if (Object.getPrototypeOf(1) === Number.prototype) n++;
    return n;
  }
`;

const VALUE_FLOW_RELATIONS = `
  function Base() {}
  function Derived() {}
  Derived.prototype = new Base();

  function args() { return arguments; }

  export function test(): number {
    let n = 0;
    const objectValue = {};
    const arrayValue = [1, 2];
    const functionValue = function () { return 1; };
    const derivedValue = new Derived();
    const derivedProto = Object.getPrototypeOf(derivedValue);

    if (Object.getPrototypeOf(objectValue) === Object.prototype) n++;
    if (Object.getPrototypeOf(arrayValue) === Array.prototype) n++;
    if (Object.getPrototypeOf(functionValue) === Function.prototype) n++;
    if (Object.getPrototypeOf(new String("x")) === String.prototype) n++;
    if (Object.getPrototypeOf(new Boolean(true)) === Boolean.prototype) n++;
    if (Object.getPrototypeOf(new Number(1)) === Number.prototype) n++;
    if (Object.getPrototypeOf(new Date(0)) === Date.prototype) n++;
    if (Object.getPrototypeOf(new RegExp("x")) === RegExp.prototype) n++;
    if (Object.getPrototypeOf(new Error("x")) === Error.prototype) n++;
    if (Object.getPrototypeOf(args()) === Object.prototype) n++;
    if (derivedProto.isPrototypeOf(derivedValue) === true) n++;
    return n;
  }
`;

const NULLISH_ERRORS = `
  export function test(): number {
    let n = 0;
    try { Object.getPrototypeOf(null); } catch (_) { n++; }
    try { Object.getPrototypeOf(undefined); } catch (_) { n++; }
    try { Object.getPrototypeOf(); } catch (_) { n++; }
    return n;
  }
`;

const SHADOWED_OBJECT = `
  export function test(): number {
    const Object = {
      getPrototypeOf(value: number): number {
        return value + 1;
      }
    };
    return Object.getPrototypeOf(41);
  }
`;

describe("#1472 ES5 Object.getPrototypeOf intrinsic and value-flow semantics", () => {
  for (const target of ["gc", "standalone"] as const) {
    it(`${target}: resolves ES5 intrinsic constructor, namespace, and primitive prototype identities`, async () => {
      const result = await run(INTRINSIC_RELATIONS, target);
      expect(result.value).toBe(20);
      if (target === "standalone") expect(result.envImports).toEqual([]);
    });

    it(`${target}: preserves prototype identity through ordinary values and constructor instances`, async () => {
      const result = await run(VALUE_FLOW_RELATIONS, target);
      expect(result.value).toBe(11);
      if (target === "standalone") expect(result.envImports).toEqual([]);
    });

    it(`${target}: throws for missing, null, and undefined operands`, async () => {
      const result = await run(NULLISH_ERRORS, target);
      expect(result.value).toBe(3);
      if (target === "standalone") expect(result.envImports).toEqual([]);
    });

    it(`${target}: leaves a shadowed Object.getPrototypeOf method untouched`, async () => {
      const result = await run(SHADOWED_OBJECT, target);
      expect(result.value).toBe(42);
      if (target === "standalone") expect(result.envImports).toEqual([]);
    });
  }
});
