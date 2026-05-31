// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1471 — eliminate JS-host numeric boxing/unboxing for standalone Wasm.
 *
 * In standalone (and WASI) mode the compiler must not emit `env::__box_number`
 * / `env::__unbox_number` (and the related typeof / is_truthy) host imports,
 * because a pure-Wasm engine cannot satisfy them. The dual-mode path
 * (`addUnionImportsAsNativeFuncs`, gated on `ctx.wasi || ctx.standalone`)
 * provides in-module WasmGC `$BoxedNumber`-struct helpers instead. This
 * mirrors the #679 (strings) / #682 (RegExp) dual-backend pattern.
 *
 * These tests assert two things per case:
 *   1. The compiled standalone module instantiates with an EMPTY import object
 *      (proving no host import is required).
 *   2. The boxed-then-unboxed value round-trips to the correct number.
 *
 * A control case proves the default (JS-host) path is unchanged — it still
 * emits the host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const BOX_UNBOX_IMPORT_RE = /__box_|__unbox_|__to_primitive|__to_boolean|__typeof|__is_truthy/;

async function compileStandalone(src: string): Promise<{ binary: Uint8Array; hostImports: string[] }> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const hostImports = WebAssembly.Module.imports(mod)
    .filter((i) => BOX_UNBOX_IMPORT_RE.test(i.name))
    .map((i) => `${i.module}::${i.name}`);
  return { binary: r.binary, hostImports };
}

async function runStandalone(src: string): Promise<unknown> {
  const { binary, hostImports } = await compileStandalone(src);
  // No host imports → instantiate with an empty import object.
  expect(hostImports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#1471 standalone numeric box/unbox — no JS host imports", () => {
  it("boxes and unboxes an integer through `any`", async () => {
    expect(
      await runStandalone(`export function test(): number { let x: any = 1 + 2; let y: number = x; return y; }`),
    ).toBe(3);
  });

  it("round-trips a positive integer with arithmetic", async () => {
    expect(
      await runStandalone(`export function test(): number { let x: any = 42; let y: number = x; return y * 2; }`),
    ).toBe(84);
  });

  it("round-trips a negative integer", async () => {
    expect(
      await runStandalone(`export function test(): number { let a: any = -5; let b: number = a; return b; }`),
    ).toBe(-5);
  });

  it("round-trips a float", async () => {
    expect(
      await runStandalone(`export function test(): number { let a: any = 3.5; let b: number = a; return b + 0.5; }`),
    ).toBe(4);
  });

  it("evaluates a truthy `any` in an if-condition (is_truthy native helper)", async () => {
    expect(
      await runStandalone(`export function test(): number { let x: any = 1; if (x) { return 11; } return 0; }`),
    ).toBe(11);
  });

  it("evaluates a falsy `any` in an if-condition", async () => {
    expect(
      await runStandalone(`export function test(): number { let x: any = 0; if (x) { return 11; } return 22; }`),
    ).toBe(22);
  });

  it("emits zero box/unbox/typeof host imports for a mixed `any` program", async () => {
    const { hostImports } = await compileStandalone(`
      export function test(): number {
        let x: any = 10;
        let y: any = 20;
        let z: number = x;
        let w: number = y;
        if (x) { return z + w; }
        return 0;
      }
    `);
    expect(hostImports).toEqual([]);
  });
});

describe("#1471 default (JS-host) path is unchanged", () => {
  it("still emits the __box_number / __unbox_number host imports in default mode", async () => {
    const r = await compile(`export function test(): number { let x: any = 1 + 2; let y: number = x; return y; }`, {
      fileName: "test.ts",
    });
    expect(r.success).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    const names = WebAssembly.Module.imports(mod).map((i) => i.name);
    expect(names).toContain("__box_number");
    expect(names).toContain("__unbox_number");
  });
});
