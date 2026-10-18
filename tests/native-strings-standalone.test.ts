import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Tests for the standalone `nativeStrings` compile option.
 *
 * These verify that native WasmGC strings can be activated independently
 * from fast mode (numbers remain f64, strings use WasmGC arrays).
 * This is the key scenario for non-browser runtimes (WASI, wasmtime, wasmer)
 * that cannot provide wasm:js-string imports.
 *
 * Note: runtime execution tests are in native-strings.test.ts (fast mode).
 * The __str_padStart helper has a pre-existing type error that prevents
 * instantiation of modules with native string helpers, so runtime tests
 * are deferred until that is fixed.
 */

describe("nativeStrings flag (standalone, no fast mode)", () => {
  it("compiles string literals using NativeString types", async () => {
    const result = await compile(`export function test(): string { return "hello"; }`, { nativeStrings: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.wat).toContain("NativeString");
    expect(result.wat).toContain("__str_data");
    // Must NOT have wasm:js-string or string_constants imports
    expect(result.wat).not.toContain("wasm:js-string");
    expect(result.wat).not.toContain("string_constants");
  });

  it("numbers remain f64 (not i32) when nativeStrings is on without fast", async () => {
    const result = await compile(`export function test(): number { return 42; }`, { nativeStrings: true });
    expect(result.success).toBe(true);
    // f64 numbers should be present, not i32
    expect(result.wat).toContain("f64.const");
  });

  it("string and number types coexist correctly", async () => {
    const src = `
      export function test(): number {
        const s = "hello";
        return s.length;
      }
    `;
    const result = await compile(src, { nativeStrings: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    // String uses native types
    expect(result.wat).toContain("NativeString");
    // Number result is f64
    expect(result.wat).toContain("(result f64)");
  });

  it("auto-enables native strings for WASI target", async () => {
    const result = await compile(`export function test(): string { return "hello"; }`, { target: "wasi" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.wat).toContain("NativeString");
    expect(result.wat).not.toContain("wasm:js-string");
  });

  it("fast mode still enables native strings", async () => {
    const result = await compile(`export function test(): string { return "hello"; }`, { fast: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.wat).toContain("NativeString");
    expect(result.wat).not.toContain("wasm:js-string");
  });

  it("non-fast non-nativeStrings mode uses externref strings", async () => {
    const result = await compile(`export function test(): string { return "hello"; }`);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("externref");
    expect(result.wat).toContain("string_constants");
    expect(result.wat).not.toContain("NativeString");
  });

  it("string equality compiles without wasm:js-string", async () => {
    const src = `
      export function test(): number {
        return "hello" === "world" ? 1 : 0;
      }
    `;
    const result = await compile(src, { nativeStrings: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.wat).not.toContain("wasm:js-string");
    expect(result.wat).not.toContain("string_constants");
  });

  it("string concatenation compiles without wasm:js-string", async () => {
    const src = `
      export function test(): number {
        const a = "hello";
        const b = " world";
        return (a + b).length;
      }
    `;
    const result = await compile(src, { nativeStrings: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.wat).not.toContain("wasm:js-string");
  });

  it("string methods compile without host imports", async () => {
    const src = `
      export function test(): number {
        return "hello world".indexOf("world");
      }
    `;
    const result = await compile(src, { nativeStrings: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.wat).not.toContain("wasm:js-string");
    expect(result.wat).not.toContain("string_indexOf");
  });

  it("nativeStrings: false with fast is rejected on the JS target (#6979)", async () => {
    // nativeStrings: false used to select the host-assisted profile (host
    // `wasm:js-string` strings), which #6979 removed — the compile now fails.
    await expect(
      (async () => {
        const result = await compile(`export function test(): string { return "hello"; }`, {
          fast: true,
          nativeStrings: false,
        });
        if (!result.success) throw new Error(result.errors.map((e) => e.message).join("\n"));
        return result;
      })(),
    ).rejects.toThrow(/nativeStrings: false selected the host-assisted semantic profile, which #6979 removed/);
  });
});
