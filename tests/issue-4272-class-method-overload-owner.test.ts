// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4272 — TypeScript method overloads are type-only signatures; the exact
// body-bearing method owns the one runtime callable and its Wasm body.
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
  return instance.exports;
}

describe("#4272 class method overload implementation ownership", () => {
  it("runs the one body-bearing instance method after type-only overloads", async () => {
    const result = await compile(
      `
class Calculator {
  compute(value: number): number;
  compute(value: number, offset?: number): number;
  compute(value: number, offset = 0): number {
    return value + offset;
  }
}

export function runCase(): number {
  return new Calculator().compute(40, 2);
}
`,
      { fileName: "method-overload.ts", trackIrOutcomes: true },
    );
    const exports = await instantiate(result);

    expect((exports.runCase as () => number)()).toBe(42);
    expect(result.irOutcomes?.filter((outcome) => outcome.displayName === "Calculator_compute")).toHaveLength(1);
  });
});
