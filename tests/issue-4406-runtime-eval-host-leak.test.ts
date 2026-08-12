// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#4406 — host direct eval does not reserve the standalone provider", () => {
  it("keeps a dynamic direct eval inside a closure on the env host seam", async () => {
    const result = await compile(
      `export function execute(source: string): unknown {
        const invoke = (): unknown => eval(source);
        return invoke();
      }`,
      { skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));

    expect(imports.some((entry) => entry.module === "js2wasm:runtime-eval")).toBe(false);
    expect(imports).toContainEqual({ module: "env", name: "__extern_eval", kind: "function" });
  });
});
