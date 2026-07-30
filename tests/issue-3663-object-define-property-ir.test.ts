// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
export function run(): number {
  const target = /target/;
  const descriptor = /descriptor/;
  Object.defineProperty(target, "x", descriptor);
  return 1;
}
`;

const STANDALONE_SOURCE = `
export function run(): number {
  const target = { x: 0 };
  const descriptor = { value: 7, writable: true, configurable: true };
  Object.defineProperty(target, "x", descriptor);
  return 1;
}
`;

describe("#3663 Object.defineProperty IR routing", () => {
  it.each([
    ["legacy", false],
    ["IR", true],
  ] as const)("%s host path preserves inherited descriptor fields", async (_label, experimentalIR) => {
    const result = await compile(SOURCE, {
      fileName: "issue-3663-object-define-property-ir.ts",
      experimentalIR,
      trackFallbacks: true,
    });
    if (!result.success) {
      throw new Error(result.errors.map((error) => error.message).join("\n"));
    }

    if (experimentalIR) {
      expect(result.irCompiledFuncs ?? []).toContain("run");
    } else {
      expect(result.irCompiledFuncs ?? []).not.toContain("run");
    }
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool) as Record<
      string,
      Record<string, CallableFunction>
    >;
    const original = imports.env?.__defineProperty_desc;
    expect(original).toBeTypeOf("function");
    let definedTarget: { x?: unknown } | undefined;
    const defineProperty = vi.fn((...args: unknown[]) => {
      const value = original!(...args);
      definedTarget = args[0] as { x?: unknown };
      return value;
    });
    imports.env!.__defineProperty_desc = defineProperty as CallableFunction;

    const priorValue = Object.getOwnPropertyDescriptor(RegExp.prototype, "value");
    const priorWritable = Object.getOwnPropertyDescriptor(RegExp.prototype, "writable");
    (RegExp.prototype as { value?: unknown }).value = 7;
    (RegExp.prototype as { writable?: unknown }).writable = true;
    try {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
      expect((instance.exports.run as CallableFunction)()).toBe(1);
      expect(defineProperty).toHaveBeenCalledTimes(1);
      expect(definedTarget?.x).toBe(7);
      definedTarget!.x = 9;
      expect(definedTarget?.x).toBe(9);
    } finally {
      if (priorValue) Object.defineProperty(RegExp.prototype, "value", priorValue);
      else Reflect.deleteProperty(RegExp.prototype, "value");
      if (priorWritable) Object.defineProperty(RegExp.prototype, "writable", priorWritable);
      else Reflect.deleteProperty(RegExp.prototype, "writable");
    }
  });

  it("keeps standalone on legacy until typed descriptor reification is an IR operation", async () => {
    const result = await compile(STANDALONE_SOURCE, {
      fileName: "issue-3663-object-define-property-ir-standalone.ts",
      target: "standalone",
      experimentalIR: true,
      trackFallbacks: true,
    });
    if (!result.success) {
      throw new Error(result.errors.map((error) => error.message).join("\n"));
    }

    expect(result.irCompiledFuncs ?? []).not.toContain("run");
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {});
    expect((instance.exports.run as CallableFunction)()).toBe(1);
  });
});
