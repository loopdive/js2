// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7364 — constructs the Prepared path has no provider for refuse by name at the build stage instead of throwing
// an invariant out of `compile()`. The Prepared producer has no selector, so the builder meets the selector's own
// rule where the value is built: a RegExp literal on a lane with neither the host constructor nor its in-module
// engine, and an `Object.defineProperty` the `Object` statics table did not admit.
import { describe, expect, it } from "vitest";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";

const options = (): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

describe("#7364 — Prepared-path refusals instead of invariant crashes", () => {
  it.each([
    ["a literal's .exec", 'var m = /a/.exec("a");'],
    ["a literal's .test in a function", 'function f() { return /a/.test("a"); }\nf();'],
    ["a literal's .source", "var s = /a/.source;"],
    ["a discarded literal", "/a/;"],
    ["a literal bound to a var", "var r = /a/;"],
  ])("refuses a RegExp literal without a provider: %s", async (_label, source) => {
    const result = await compile(source, options());
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => [error.code, error.message])).toEqual([
      ["regexp-constructor-unsupported", expect.stringContaining("RegExp literal has no provider")],
    ]);
  });

  it("refuses an unadmitted Object.defineProperty by the selector's code", async () => {
    const source = 'function f() { var o = {}; Object.defineProperty(o, "x", { value: 1 }); }\nf();';
    const result = await compile(source, options());
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => [error.code, error.message])).toEqual([
      [
        "call-resolution-unsupported",
        expect.stringContaining("Object.defineProperty is not an admitted Object static"),
      ],
    ]);
  });
});
