// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    nativeStrings: true,
    allowJs: true,
    fileName: "issue-2552-annexb-b33.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#2552 Annex B b33 residuals", () => {
  it("keeps the Annex-B outer closure callable after a block-local self write", async () => {
    await expect(
      runStandalone(`
        export function test() {
          let varBinding;
          { function f() { f = 7; return 1; } varBinding = f; f(); }
          return varBinding();
        }
      `),
    ).resolves.toBe(1);
  });

  it("preserves the implicit arguments object around a skipped Annex-B declaration", async () => {
    await expect(
      runStandalone(`
        export function test() {
          return (function(..._) {
            let score = arguments.toString() === "[object Arguments]" ? 1 : 0;
            { function arguments() {} }
            score += arguments.toString() === "[object Arguments]" ? 1 : 0;
            return score;
          }());
        }
      `),
    ).resolves.toBe(2);
  });

  it("resolves a block function named arguments only inside its declaring block", async () => {
    await expect(
      runStandalone(`
        export function test() {
          let score = 0;
          (function() {
            {
              if (arguments() === undefined) score++;
              function arguments() {}
              if (arguments() === undefined) score++;
            }
          }());
          return score;
        }
      `),
    ).resolves.toBe(2);
  });
});
