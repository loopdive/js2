// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4267 — TypeScript overload signatures are type-only declarations. The one
// body-bearing implementation is the sole runtime callable and must be the
// declaration owned by the source-callable Program ABI inventory.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setExports?.(instance.exports as Record<string, Function>);
  const init = instance.exports.__module_init;
  if (typeof init === "function") init();
  return instance.exports;
}

describe("#4267 top-level overload implementation ownership", () => {
  it("runs an internal generic overload through its body-bearing implementation", async () => {
    const result = await compile(
      `
function identity<T>(value: T): T;
function identity<T>(value: T): T { return value; }
export function runCase(): number { return identity(42); }
`,
      { fileName: "internal-overload.ts", trackIrOutcomes: true },
    );
    const exports = await instantiate(result);

    expect((exports.runCase as () => number)()).toBe(42);
    expect(result.irOutcomes?.map((outcome) => outcome.displayName)).toEqual(["identity", "runCase"]);
  });

  it("emits one runtime export for an exported overload set", async () => {
    const result = await compile(
      `
export function increment(value: number): number;
export function increment(value: number): number { return value + 1; }
export function runCase(): number { return increment(41); }
`,
      { fileName: "exported-overload.ts" },
    );
    const exports = await instantiate(result);

    expect((exports.increment as (value: number) => number)(9)).toBe(10);
    expect((exports.runCase as () => number)()).toBe(42);
    const wasmExports = WebAssembly.Module.exports(new WebAssembly.Module(result.binary));
    expect(wasmExports.filter((entry) => entry.name === "increment")).toHaveLength(1);
  });

  it("preserves an ordinary non-overloaded function", async () => {
    const result = await compile(
      `
function increment(value: number): number { return value + 1; }
export function runCase(): number { return increment(41); }
`,
      { fileName: "ordinary-function.ts" },
    );
    const exports = await instantiate(result);

    expect((exports.runCase as () => number)()).toBe(42);
  });
});
