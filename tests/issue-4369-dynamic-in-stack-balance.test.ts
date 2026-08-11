// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

const SOURCE = `
  class Registry {
    options = 1;
    parser = 2;
  }

  export function has(key) {
    return key in new Registry();
  }

  export function hasFromEnumeration(input) {
    for (const key in input) {
      if (key in new Registry()) return 1;
    }
    return 0;
  }

  export function hidesCompilerTag() {
    const key = /** @type {any} */ ("__tag");
    return key in new Registry();
  }
`;

async function compileAndRun(): Promise<Record<string, (...args: any[]) => any>> {
  const result = await compile(SOURCE, {
    fileName: "dynamic-in-internal-field.js",
    skipSemanticDiagnostics: true,
    experimentalIR: false,
  });

  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  await expect(WebAssembly.compile(result.binary)).resolves.toBeInstanceOf(WebAssembly.Module);

  const importObject = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures }) as Record<string, (...args: any[]) => any>;
}

describe("#4369 — dynamic `in` checks ignore compiler-only struct fields", () => {
  it("keeps every dynamic comparison stack-balanced and returns the public-field answer", async () => {
    const exports = await compileAndRun();

    expect(exports.has!("options")).toBe(1);
    expect(exports.has!("parser")).toBe(1);
    expect(exports.has!("missing")).toBe(0);
    expect(exports.hidesCompilerTag!()).toBe(0);
  });

  it("handles the for-in-fed key shape used by Marked", async () => {
    const exports = await compileAndRun();

    expect(exports.hasFromEnumeration!({ options: true })).toBe(1);
    expect(exports.hasFromEnumeration!({ missing: true })).toBe(0);
  });
});
