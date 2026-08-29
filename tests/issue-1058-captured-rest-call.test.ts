// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

describe("#1058 — direct calls to captured rest functions", () => {
  it("keeps hidden captures ahead of supplied and missing fixed parameters", async () => {
    const result = await compileMulti(
      {
        "./main.ts": `
export function test(): number {
  let state = 10;

  function read(_prefix?: number, ...values: number[]): number {
    state += values.length;
    return values.length > 0 ? state + values[0] : state;
  }

  const supplied = read(2, 3, 4);
  const omitted = read();
  return supplied * 100 + omitted;
}
`,
      },
      "./main.ts",
      { target: "gc" },
    );

    expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject as WebAssembly.Imports);
    expect((instance.exports.test as () => number)()).toBe(1512);
  });
});
