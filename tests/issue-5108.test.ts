// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#5108) Computed-only object literals with statically folded keys must keep
// their value and binding representations aligned in the standalone lane.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5108.js",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#5108 computed-only object key carriers", () => {
  it("keeps arithmetic computed keys readable in a self-contained module", async () => {
    await expect(
      runStandalone(`
        let object = { [1 + 1]: 2 };
        export function test() {
          return object[1 + 1] === 2 && object[String(1 + 1)] === 2 ? 1 : 0;
        }
      `),
    ).resolves.toBe(1);
  });

  it("keeps mixed named and computed literals on their existing struct path", async () => {
    await expect(
      runStandalone(`
        let object = { named: 3, [1 + 1]: 4 };
        export function test() { return object.named + object[2] === 7 ? 1 : 0; }
      `),
    ).resolves.toBe(1);
  });

  it("keeps genuinely runtime computed keys on the dynamic path", async () => {
    await expect(
      runStandalone(`
        function key() { return 1; }
        let object = { [key()]: 5 };
        export function test() { return object[key()] === 5 ? 1 : 0; }
      `),
    ).resolves.toBe(1);
  });

  it("keeps the host lane passing for the arithmetic shape", async () => {
    const result = await compile(
      `
        export function test() { return ({ [1 + 1]: 2 })[1 + 1] === 2 ? 1 : 0; }
      `,
      { allowJs: true, fileName: "issue-5108-host.js", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(1);
  });
});

const TEST262_ROOT = resolve(__dirname, "..", "test262");
const HAS_TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const ROWS = [
  "language/expressions/object/cpn-obj-lit-computed-property-name-from-additive-expression-add.js",
  "language/expressions/object/cpn-obj-lit-computed-property-name-from-additive-expression-subtract.js",
  "language/expressions/object/cpn-obj-lit-computed-property-name-from-multiplicative-expression-div.js",
  "language/expressions/object/cpn-obj-lit-computed-property-name-from-multiplicative-expression-mult.js",
] as const;

describe.skipIf(!HAS_TEST262)("#5108 selected Test262 cohort", () => {
  for (const row of ROWS) {
    it(row, { timeout: 120_000 }, async () => {
      const { runTest262File } = await import("./test262-runner.js");
      const result = await runTest262File(join(TEST262_ROOT, "test", row), "issue-5108", 120_000, "standalone");
      expect(`${result.status}: ${result.error ?? result.reason ?? ""}`).toBe("pass: ");
    });
  }
});
