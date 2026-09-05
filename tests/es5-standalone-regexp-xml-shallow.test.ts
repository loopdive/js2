// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

describe("ES5 standalone XML shallow RegExp patterns", () => {
  it("constructs and tests every generated pattern", async () => {
    const path = resolve("test262/test/built-ins/RegExp/S15.10.2_A1_T1.js");
    const result = await runTest262File(path, "es5-regexp-xml-shallow", 120_000, "standalone");
    expect(result.status, result.error).toBe("pass");
  }, 180_000);

  it("keeps a mutated table value on the runtime compiler fallback", async () => {
    const result = await compile(
      `
export function test(): number {
  const patterns = ["a+"];
  patterns[0] = "z";
  return new RegExp(patterns[0]).test("zz") ? 1 : 0;
}
`,
      { target: "standalone" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  }, 60_000);
});
