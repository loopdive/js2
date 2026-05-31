// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1491 — node:fs JS-host imports (readFileSync / writeFileSync) for non-WASI
// targets, gated behind { allowFs: true }.
//
// Verifies:
//   1. A program that imports fs.readFileSync from "node:fs" compiles when
//      allowFs is set and successfully round-trips a string from a real file.
//   2. writeFileSync compiles & writes to disk via the host import.
//   3. Without allowFs the compiler emits a compile-time error (capability gate).
//   4. The host bindings come from the `node_builtin_fn` ImportIntent and are
//      resolved by `buildImports` via `_getNodeRequire`.

import { mkdtempSync, readFileSync as nodeReadFileSync, rmSync, writeFileSync as nodeWriteFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const tmpDir = mkdtempSync(join(tmpdir(), "js2wasm-1491-"));
const fixturePath = join(tmpDir, "hello.txt");
const outPath = join(tmpDir, "upper.txt");
const FIXTURE = "hello, fs host imports!";

beforeAll(() => {
  nodeWriteFileSync(fixturePath, FIXTURE, "utf-8");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function compileAndInstantiate(source: string, opts: { allowFs?: boolean } = {}) {
  const r = await compile(source, { allowFs: opts.allowFs ?? false, fileName: "input.ts" });
  return r;
}

describe("#1491 — fs.readFileSync / writeFileSync as JS host imports (non-WASI)", () => {
  it("compiles a readFileSync call when allowFs is true and the import manifest contains node_builtin_fn", async () => {
    const r = await compileAndInstantiate(
      `
        import { readFileSync } from "node:fs";
        export function readFixture(path: string): string {
          return readFileSync(path, "utf-8");
        }
      `,
      { allowFs: true },
    );
    expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
    expect(r.success).toBe(true);

    const fsImports = r.imports.filter((imp) => imp.intent.type === "node_builtin_fn");
    expect(fsImports.length).toBeGreaterThan(0);
    const readImp = fsImports.find(
      (imp) =>
        imp.intent.type === "node_builtin_fn" && imp.intent.moduleName === "fs" && imp.intent.name === "readFileSync",
    );
    expect(readImp).toBeDefined();
  });

  it("at runtime: readFileSync reads a real file and returns the bytes as a string", async () => {
    const r = await compileAndInstantiate(
      `
        import { readFileSync } from "node:fs";
        export function readFixture(path: string): string {
          return readFileSync(path, "utf-8");
        }
      `,
      { allowFs: true },
    );
    expect(r.success).toBe(true);
    const built = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, built);
    if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
    const exports = instance.exports as { readFixture: (p: string) => string };
    const content = exports.readFixture(fixturePath);
    expect(content).toBe(FIXTURE);
  });

  it("at runtime: writeFileSync writes a real file via the host import", async () => {
    const r = await compileAndInstantiate(
      `
        import { writeFileSync } from "node:fs";
        export function writeAt(path: string, data: string): void {
          writeFileSync(path, data);
        }
      `,
      { allowFs: true },
    );
    expect(r.success).toBe(true);
    const built = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, built);
    if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
    const exports = instance.exports as { writeAt: (p: string, d: string) => void };
    exports.writeAt(outPath, "WROTE-FROM-WASM");
    const echoed = nodeReadFileSync(outPath, "utf-8");
    expect(echoed).toBe("WROTE-FROM-WASM");
  });

  it("round-trips a real file through readFileSync → toUpperCase → writeFileSync", async () => {
    const r = await compileAndInstantiate(
      `
        import { readFileSync, writeFileSync } from "node:fs";
        export function upperCopy(inPath: string, outPath: string): void {
          const data = readFileSync(inPath, "utf-8");
          writeFileSync(outPath, data.toUpperCase());
        }
      `,
      { allowFs: true },
    );
    expect(r.success).toBe(true);
    const built = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, built);
    if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
    const exports = instance.exports as { upperCopy: (a: string, b: string) => void };
    const roundTripOut = join(tmpDir, "roundtrip.txt");
    exports.upperCopy(fixturePath, roundTripOut);
    const echoed = nodeReadFileSync(roundTripOut, "utf-8");
    expect(echoed).toBe(FIXTURE.toUpperCase());
  });

  it("without allowFs: emits a compile error pointing at --allow-fs and refuses the import", async () => {
    const r = await compileAndInstantiate(
      `
        import { readFileSync } from "node:fs";
        export function readFixture(path: string): string {
          return readFileSync(path, "utf-8");
        }
      `,
      { allowFs: false },
    );
    const hardErrors = r.errors.filter((e) => e.severity === "error");
    expect(hardErrors.length).toBeGreaterThan(0);
    expect(hardErrors.some((e) => /--allow-fs/.test(e.message))).toBe(true);
    // No __node_fs_readFileSync should be registered when the capability is denied.
    const fsImports = r.imports.filter(
      (imp) => imp.intent.type === "node_builtin_fn" && imp.intent.moduleName === "fs",
    );
    expect(fsImports.length).toBe(0);
  });
});
