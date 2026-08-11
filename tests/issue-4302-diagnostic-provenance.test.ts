// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4302 — backend refusals in package graphs must retain the owning file.
 *
 * TypeScript diagnostics already carried `CompileError.file` (#1929), but
 * codegen diagnostics lost it while crossing CodegenError -> CompileError.
 * Large npm graphs therefore reported only an ambiguous line/column pair.
 */
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

describe("#4302 codegen diagnostic source provenance", () => {
  it("attributes an unsupported async suspension to the imported package file", async () => {
    const result = await compileMulti(
      {
        "entry.js": 'import { run } from "./package.js"; export async function test() { return run(); }',
        "package.js": `
async function pending() { return 1; }
export async function run(flag) {
  try {
    return flag ? 0 : 1 + await pending();
  } finally {
    flag = false;
  }
}`,
      },
      "entry.js",
      { allowJs: true },
    );

    expect(result.success).toBe(false);
    const refusal = result.errors.find((error) => error.message.includes("#3587"));
    expect(refusal, result.errors.map((error) => error.message).join("\n")).toBeDefined();
    expect(refusal).toMatchObject({
      file: "package.js",
      line: 5,
      severity: "error",
    });
    expect(refusal!.column).toBeGreaterThan(0);
  });
});
