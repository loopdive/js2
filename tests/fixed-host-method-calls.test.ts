// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it } from "vitest";

import { compile, type ImportDescriptor } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

const previousKillSwitch = process.env.JS2WASM_FIXED_HOST_METHOD_CALLS;

afterEach(() => {
  if (previousKillSwitch === undefined) process.env.JS2WASM_FIXED_HOST_METHOD_CALLS = undefined;
  else process.env.JS2WASM_FIXED_HOST_METHOD_CALLS = previousKillSwitch;
});

describe("fixed-arity JS-host method calls", () => {
  it("emits one fixed import instead of building an argument array through imports", async () => {
    process.env.JS2WASM_FIXED_HOST_METHOD_CALLS = undefined;
    const result = await compile(`export function invoke(receiver: any): number { return receiver.add(2, 3); }`, {
      fileName: "fixed-host-method.ts",
    });
    expect(result.success, result.errors?.map((error) => error.message).join("\n")).toBe(true);
    const imports = WebAssembly.Module.imports(await WebAssembly.compile(result.binary)).map((entry) => entry.name);
    expect(imports).toContain("__extern_method_call_2");
    expect(imports).not.toContain("__extern_method_call");
    expect(imports).not.toContain("__js_array_new");
    expect(imports).not.toContain("__js_array_push");
  });

  it("keeps receiver binding, argument order, and the observed return value", async () => {
    process.env.JS2WASM_FIXED_HOST_METHOD_CALLS = undefined;
    const exports = await compileAndInstantiate(
      `export function invoke(receiver: any): number { return receiver.add(2, 3); }`,
      { fileName: "fixed-host-method.ts" },
    );
    const receiver = {
      base: 7,
      add(this: { base: number }, a: number, b: number): number {
        return this.base * 100 + a * 10 + b;
      },
    };
    expect((exports.invoke as (receiver: unknown) => number)(receiver)).toBe(723);
  });

  it("supports arities zero through four through the canonical dispatcher", () => {
    const descriptors: ImportDescriptor[] = [0, 1, 2, 3, 4].map((arity) => ({
      module: "env",
      name: `__extern_method_call_${arity}`,
      kind: "func",
      intent: { type: "builtin", name: `__extern_method_call_${arity}` },
      paramCount: 2 + arity,
    }));
    const built = buildImports(descriptors);
    const receiver = {
      base: 5,
      m0(): number {
        return this.base;
      },
      m1(a: number): number {
        return this.base + a;
      },
      m2(a: number, b: number): number {
        return this.base + a * 10 + b;
      },
      m3(a: number, b: number, c: number): number {
        return this.base + a * 100 + b * 10 + c;
      },
      m4(a: number, b: number, c: number, d: number): number {
        return this.base * 10000 + a * 1000 + b * 100 + c * 10 + d;
      },
    };
    expect(built.env.__extern_method_call_0!(receiver, "m0")).toBe(5);
    expect(built.env.__extern_method_call_1!(receiver, "m1", 2)).toBe(7);
    expect(built.env.__extern_method_call_2!(receiver, "m2", 2, 3)).toBe(28);
    expect(built.env.__extern_method_call_3!(receiver, "m3", 2, 3, 4)).toBe(239);
    expect(built.env.__extern_method_call_4!(receiver, "m4", 2, 3, 4, 5)).toBe(52345);
  });

  it("uses a fresh fallback pack when a host callback re-enters the same fixed import", () => {
    const descriptor: ImportDescriptor = {
      module: "env",
      name: "__extern_method_call_2",
      kind: "func",
      intent: { type: "builtin", name: "__extern_method_call_2" },
      paramCount: 4,
    };
    const call = buildImports([descriptor]).env.__extern_method_call_2!;
    const receiver = {
      inner(a: number, b: number): number {
        return a * 10 + b;
      },
      outer(a: number, b: number): number {
        return call(this, "inner", a + 1, b + 1) + a * 100 + b;
      },
    };
    expect(call(receiver, "outer", 2, 3)).toBe(237);
    expect(call(receiver, "inner", 4, 5)).toBe(45);
  });

  it("retains the array-building fallback behind the default-on kill switch", async () => {
    process.env.JS2WASM_FIXED_HOST_METHOD_CALLS = "0";
    const result = await compile(`export function invoke(receiver: any): number { return receiver.add(2, 3); }`, {
      fileName: "fixed-host-method-kill-switch.ts",
    });
    expect(result.success, result.errors?.map((error) => error.message).join("\n")).toBe(true);
    const imports = WebAssembly.Module.imports(await WebAssembly.compile(result.binary)).map((entry) => entry.name);
    expect(imports).toContain("__extern_method_call");
    expect(imports).toContain("__js_array_new");
    expect(imports).toContain("__js_array_push");
    expect(imports).not.toContain("__extern_method_call_2");
  });
});
