import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { optimizeBinaryAsync } from "../src/optimize.js";

describe("wasm-opt optimization pass", () => {
  const source = `
    export function add(a: number, b: number): number {
      return a + b;
    }
    export function fib(n: number): number {
      if (n <= 1) return n;
      return fib(n - 1) + fib(n - 2);
    }
  `;
  const compactImportSource = `
    class A { x = 1; }
    class B { y = "a"; }
    export function f(n: number): any { return n ? new A() : new B(); }
  `;

  it("compiles successfully without optimize flag", async () => {
    const result = await compile(source);
    expect(result.success).toBe(true);
    expect(result.binary.byteLength).toBeGreaterThan(0);
  });

  it("compiles successfully with optimize: true", async () => {
    const result = await compile(source, { optimize: true });
    expect(result.success).toBe(true);
    expect(result.binary.byteLength).toBeGreaterThan(0);
    // When wasm-opt is not available, we should get the original binary back
    // with a warning. When it IS available, we get an optimized binary.
    // Either way, compilation should succeed.
  });

  it("compiles successfully with optimize: 1", async () => {
    const result = await compile(source, { optimize: 1 });
    expect(result.success).toBe(true);
    expect(result.binary.byteLength).toBeGreaterThan(0);
  });

  it("gracefully handles missing wasm-opt with a warning", async () => {
    // This test verifies the graceful fallback behavior.
    // If wasm-opt is not installed, the result should still be successful
    // but may contain a warning about wasm-opt not being available.
    const result = await compile(source, { optimize: true });
    expect(result.success).toBe(true);

    const hasOptWarning = result.errors.some((e) => e.severity === "warning" && e.message.includes("wasm-opt"));

    // If optimization was not applied (no binaryen npm package, no system binary),
    // there should be a warning. If it WAS applied, no warning.
    // We just verify the contract: success is true in both cases.
    if (hasOptWarning) {
      // Verify the binary is the same as without optimization
      const unoptimized = await compile(source);
      expect(result.binary.byteLength).toBe(unoptimized.binary.byteLength);
    }
  });

  it("produces valid wasm binary header with optimize flag", async () => {
    const result = await compile(source, { optimize: true });
    expect(result.success).toBe(true);
    // Wasm magic number: \0asm
    expect(result.binary[0]).toBe(0x00);
    expect(result.binary[1]).toBe(0x61);
    expect(result.binary[2]).toBe(0x73);
    expect(result.binary[3]).toBe(0x6d);
  });

  it("does not affect WAT output (WAT is from pre-optimization IR)", async () => {
    const withOpt = await compile(source, { optimize: true });
    const withoutOpt = await compile(source);
    // WAT should be the same regardless of optimize flag,
    // because WAT is emitted from the IR, not from the binary
    expect(withOpt.wat).toBe(withoutOpt.wat);
  });

  it("keeps Binaryen 132 compact-import rewrites loadable by Node", async () => {
    const raw = await compile(compactImportSource);
    expect(raw.success).toBe(true);
    expect(WebAssembly.validate(raw.binary)).toBe(true);

    // Exclude any system wasm-opt so this exercises the binaryen package path
    // used by clean benchmark runners. Keep Node on PATH for Binaryen's
    // /usr/bin/env node launcher.
    const previousPath = process.env.PATH;
    process.env.PATH = [resolve(process.cwd(), "node_modules", ".bin"), dirname(process.execPath)].join(delimiter);
    try {
      const optimized = await optimizeBinaryAsync(raw.binary, { level: 4 });
      expect(optimized.optimized, optimized.warning).toBe(true);
      expect(WebAssembly.validate(optimized.binary)).toBe(true);
    } finally {
      if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = previousPath;
    }
  });

  it("does not pass compact-import flags to an older system wasm-opt", async () => {
    const raw = await compile(compactImportSource);
    expect(raw.success).toBe(true);

    const fakeRoot = mkdtempSync(join(tmpdir(), "js2-wasm-opt-old-"));
    const fakeWasmOpt = join(fakeRoot, "wasm-opt");
    const capturedArgs = join(fakeRoot, "args.json");
    writeFileSync(
      fakeWasmOpt,
      `#!/usr/bin/env node
const { copyFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("old wasm-opt help");
  process.exit(0);
}
writeFileSync(process.env.JS2WASM_FAKE_WASM_OPT_ARGS, JSON.stringify(args));
copyFileSync(args[0], args[args.indexOf("-o") + 1]);
`,
    );
    chmodSync(fakeWasmOpt, 0o755);

    const previousPath = process.env.PATH;
    const previousCapture = process.env.JS2WASM_FAKE_WASM_OPT_ARGS;
    process.env.PATH = [fakeRoot, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
    process.env.JS2WASM_FAKE_WASM_OPT_ARGS = capturedArgs;
    try {
      const optimized = await optimizeBinaryAsync(raw.binary, { level: 4 });
      expect(optimized.optimized, optimized.warning).toBe(true);
      const args = JSON.parse(readFileSync(capturedArgs, "utf8")) as string[];
      expect(args).toContain("--all-features");
      expect(args).toContain("--disable-custom-descriptors");
      expect(args).not.toContain("--disable-compact-imports");
    } finally {
      if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = previousPath;
      if (previousCapture === undefined) Reflect.deleteProperty(process.env, "JS2WASM_FAKE_WASM_OPT_ARGS");
      else process.env.JS2WASM_FAKE_WASM_OPT_ARGS = previousCapture;
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("reports rejected optimizer output instead of claiming wasm-opt is missing", async () => {
    const raw = await compile(compactImportSource);
    expect(raw.success).toBe(true);

    const fakeRoot = mkdtempSync(join(tmpdir(), "js2-wasm-opt-invalid-"));
    const fakeWasmOpt = join(fakeRoot, "wasm-opt");
    writeFileSync(
      fakeWasmOpt,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("--disable-compact-imports");
  process.exit(0);
}
writeFileSync(args[args.indexOf("-o") + 1], Buffer.from([0]));
`,
    );
    chmodSync(fakeWasmOpt, 0o755);

    const previousPath = process.env.PATH;
    const binaryenSpecifierKey = "__js2wasmBinaryenModuleSpecifier";
    const globalObject = globalThis as Record<string, unknown>;
    const previousBinaryenSpecifier = globalObject[binaryenSpecifierKey];
    process.env.PATH = [fakeRoot, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
    globalObject[binaryenSpecifierKey] = `file://${join(fakeRoot, "missing-binaryen.mjs")}`;
    try {
      const optimized = await optimizeBinaryAsync(raw.binary, { level: 4 });
      expect(optimized.optimized).toBe(false);
      expect(optimized.binary).toEqual(raw.binary);
      expect(optimized.warning).toContain("wasm-opt produced an invalid binary");
      expect(optimized.warning).toContain("Runtime validation:");
      expect(optimized.warning).not.toContain("wasm-opt not available");
    } finally {
      if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = previousPath;
      if (previousBinaryenSpecifier === undefined) Reflect.deleteProperty(globalObject, binaryenSpecifierKey);
      else globalObject[binaryenSpecifierKey] = previousBinaryenSpecifier;
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
