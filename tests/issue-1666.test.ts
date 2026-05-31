// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1666 — `--target wasi` must emit VALID (instantiable) Wasm for number
 * formatting methods. Signature B of the issue: the RangeError-validation
 * throw path in `Number.prototype.{toString(radix),toFixed,toPrecision,
 * toExponential}` emitted `global.get <-1>` (an unbound late-global sentinel)
 * because `addStringConstantGlobal` records native-strings literals with the
 * `-1` "materialize inline" sentinel rather than a real string-constant
 * global. The fix materializes the error message via
 * `stringConstantExternrefInstrs`, which inlines a native string and converts
 * to externref for the exception tag — mode-agnostic and valid under WASI.
 *
 * Acceptance: each construct compiles to a module that passes
 * `WebAssembly.compile` validation under `--target wasi`.
 */
describe("#1666 — number-format methods emit valid Wasm under --target wasi", () => {
  const cases: Array<[string, string]> = [
    ["toFixed", "export function test(): number { return (3.14159).toFixed(2).length; }"],
    ["toString(radix)", "export function test(): number { return (255).toString(16).length; }"],
    ["toPrecision", "export function test(): number { return (123.456).toPrecision(4).length; }"],
    ["toExponential", "export function test(): number { return (12345).toExponential(2).length; }"],
  ];

  for (const [name, src] of cases) {
    it(`${name} produces an instantiable module (no unbound global)`, async () => {
      const r = await compile(src, { fileName: `${name}.ts`, target: "wasi" });
      expect(r.success, r.errors[0]?.message).toBe(true);
      // The bug surfaced as a CompileError: "Invalid global index: 4294967295".
      await expect(WebAssembly.compile(r.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
    });
  }

  it("the JS-host (default) path is unchanged and still validates", async () => {
    const r = await compile("export function test(): number { return (3.14).toFixed(1).length; }", {
      fileName: "gc.ts",
    });
    expect(r.success).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
  });
});
