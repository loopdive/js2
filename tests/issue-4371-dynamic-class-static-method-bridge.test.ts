// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4371 — a declared static method carried through a dynamic class-object
// value must remain the real compiled callable. The old class-object registry
// recorded only the method name and exposed a descriptor-only JavaScript
// placeholder whose body deliberately threw.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

async function run(source: string): Promise<Record<string, any>> {
  const result = await compile(source, {
    fileName: "issue-4371.ts",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

describe("#4371 — dynamic class-object static method bridge", () => {
  it("calls a declared static method after the class crosses an object field", async () => {
    const exports = await run(`
      function carry(type: any): any { return { type }; }
      export function probe(): number {
        class Component {
          static someStaticMethod(): number { return 7; }
        }
        return carry(Component).type.someStaticMethod();
      }
    `);

    expect(exports.probe()).toBe(7);
  });

  it("keeps the extracted method callable and forwards arguments", async () => {
    const exports = await run(`
      function carry(type: any): any { return { type }; }
      export function probe(): number {
        class Component {
          static add(a: number, b: number): number { return a * 10 + b; }
        }
        const fn: any = carry(Component).type.add;
        return fn(4, 2);
      }
    `);

    expect(exports.probe()).toBe(42);
  });

  it("preserves static method descriptor attributes", async () => {
    const exports = await run(`
      function carry(type: any): any { return { type }; }
      export function flags(): number {
        class Component { static method(): number { return 1; } }
        const desc: any = Object.getOwnPropertyDescriptor(carry(Component).type, "method");
        return (desc.writable ? 100 : 0) + (desc.enumerable ? 10 : 0) + (desc.configurable ? 1 : 0);
      }
    `);

    expect(exports.flags()).toBe(101);
  });
});
