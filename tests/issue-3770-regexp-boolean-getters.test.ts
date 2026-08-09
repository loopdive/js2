// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-3770.js",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#3770 standalone RegExp boolean getters", { timeout: 60_000 }, () => {
  it("preserves false and true as booleans across an untyped call boundary", async () => {
    expect(
      await runStandalone(`
        function classify(value) {
          if (value === false) return 0;
          if (value === true) return 1;
          if (value === 0) return 2;
          if (value === 1) return 3;
          return 4;
        }

        export function test() {
          if (classify(/./.unicodeSets) !== 0) return 1;
          if (classify(/./v.unicodeSets) !== 1) return 2;
          return 0;
        }
      `),
    ).toBe(0);
  });

  it("passes the maintained Test262 UnicodeSets getter case", async () => {
    const result = await runTest262File(
      resolve("test262/test/built-ins/RegExp/prototype/unicodeSets/this-val-regexp.js"),
      "built-ins/RegExp",
      45_000,
      "standalone",
    );
    expect(result.status, result.error ?? result.reason).toBe("pass");
  });
});
