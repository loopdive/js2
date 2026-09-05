// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

async function run(body: string): Promise<number> {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "es5-call-deepequal.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const instance = await instantiateTest262Module(
    result.binary,
    {},
    { target: "standalone", providerLabel: "es5-call-deepequal" },
  );
  return (instance.exports as { test(): number }).test();
}

describe("ES5 call/apply and deepEqual property-key crossings", () => {
  it("does not cast a Symbol property key as a native string", async () => {
    expect(
      await run(`
        var value: any = {};
        var key: any = Symbol.iterator;
        return value[key] === undefined ? 1 : 0;
      `),
    ).toBe(1);
  });
});
