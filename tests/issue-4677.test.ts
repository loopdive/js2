// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4677) Annex B String.prototype.trimLeft/trimRight in standalone mode.
// The aliases must use the native trim helpers and resolve to the exact
// canonical trimStart/trimEnd function objects.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "issue-4677.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  if (!result.success) {
    throw new Error(result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"));
  }
  expect(Object.keys(result.imports)).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4677 — standalone trimLeft/trimRight aliases", () => {
  it("trims leading whitespace through trimLeft", async () => {
    await expect(runStandalone(`return " \\t x \\n".trimLeft() === "x \\n" ? 1 : 0;`)).resolves.toBe(1);
  });

  it("trims trailing whitespace through trimRight", async () => {
    await expect(runStandalone(`return " \\t x \\n".trimRight() === " \\t x" ? 1 : 0;`)).resolves.toBe(1);
  });

  it("uses the canonical trimStart function object for trimLeft", async () => {
    await expect(
      runStandalone(`return String.prototype.trimLeft === String.prototype.trimStart ? 1 : 0;`),
    ).resolves.toBe(1);
  });

  it("uses the canonical trimEnd function object for trimRight", async () => {
    await expect(
      runStandalone(`return String.prototype.trimRight === String.prototype.trimEnd ? 1 : 0;`),
    ).resolves.toBe(1);
  });

  it("reports canonical names and zero arity for both aliases", async () => {
    await expect(
      runStandalone(
        `return String.prototype.trimLeft.name === "trimStart" && String.prototype.trimRight.name === "trimEnd" && String.prototype.trimLeft.length === 0 && String.prototype.trimRight.length === 0 ? 1 : 0;`,
      ),
    ).resolves.toBe(1);
  });

  it("supports borrowed alias calls without host imports", async () => {
    await expect(
      runStandalone(
        `return String.prototype.trimLeft.call("  x  ") === "x  " && String.prototype.trimRight.call("  x  ") === "  x" ? 1 : 0;`,
      ),
    ).resolves.toBe(1);
  });
});
