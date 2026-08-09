// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4270 — TypeScript constructor overloads are type-only signatures; the exact
// body-bearing constructor owns the one runtime allocator and its Wasm body.
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

describe("#4270 class constructor overload implementation ownership", () => {
  it("runs the one body-bearing constructor after type-only overloads", async () => {
    const result = await compile(
      `
class Counter {
  value: number;

  constructor(value: number);
  constructor(value: number, offset?: number);
  constructor(value: number, offset = 0) {
    this.value = value + offset;
  }
}

export function runCase(): number {
  return new Counter(40, 2).value;
}
`,
      { fileName: "constructor-overload.ts", trackIrOutcomes: true },
    );
    const exports = await instantiate(result);

    expect((exports.runCase as () => number)()).toBe(42);
    expect(result.irOutcomes?.filter((outcome) => outcome.displayName === "Counter_new")).toHaveLength(1);
  });
});
