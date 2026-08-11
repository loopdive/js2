// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4367 — Webpack wraps Object.defineProperty descriptor literals in
 * parentheses. The emitter unwraps them, so the import collector must make the
 * same decision before the getter body requests __make_getter_callback.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#4367 parenthesized accessor descriptor imports", () => {
  it("registers the getter callback bridge for Jest's Webpack export shape", async () => {
    const result = await compile(
      `
const moduleExports: Record<string, unknown> = {};
const dependency = { run: 42 };
Object.defineProperty(moduleExports, "run", ({
  enumerable: true,
  get: function () {
    return dependency.run;
  }
}));
export function test(): number {
  return moduleExports.run as number;
}`,
      { fileName: "webpack-export.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.imports).toContainEqual(expect.objectContaining({ module: "env", name: "__make_getter_callback" }));
  });

  it("recognizes TypeScript-transparent wrappers around the descriptor", async () => {
    const result = await compile(
      `
const target: Record<string, unknown> = {};
Object.defineProperty(target, "value", ({
  get: () => 7
} satisfies PropertyDescriptor)!);
export function test(): number { return target.value as number; }
`,
      { fileName: "wrapped-descriptor.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });
});
