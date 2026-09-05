// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4665 — the bounded standalone dynamic-RegExp grammar accepts balanced plain
// and non-capturing group envelopes. Keep the pattern runtime-built here: a
// literal or compile-time-folded concatenation would exercise the static
// regexp compiler instead of the dynamic token decoder.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4665 standalone dynamic RegExp group envelopes", () => {
  it("captures all 200 nested plain groups", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          var pattern = "";
          var i = 0;
          for (i = 0; i < 200; i++) pattern += "(";
          pattern += "hello";
          for (i = 0; i < 200; i++) pattern += ")";
          var match: any = new RegExp(pattern).exec("hello");
          return match !== null && match.length === 201 && match[0] === "hello" && match[200] === "hello" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps 200 nested non-capturing groups out of the capture array", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          var pattern = "";
          var i = 0;
          for (i = 0; i < 200; i++) pattern += "(?:";
          pattern += "hello";
          for (i = 0; i < 200; i++) pattern += ")";
          var match: any = new RegExp(pattern).exec("hello");
          return match !== null && match.length === 1 && match[0] === "hello" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
