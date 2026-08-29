// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function envImportNames(bytes: Uint8Array): string[] {
  const mod = new WebAssembly.Module(bytes);
  return WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
}

async function compileStandaloneNumber(source: string, fast = false): Promise<{ value: number; env: string[] }> {
  const r = await compile(source, {
    fileName: "issue-1904.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
    fast,
  });

  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const env = envImportNames(r.binary);
  expect(env, `leaked env imports: ${env.join(", ")}`).not.toContain("__extern_is_array");
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { value: (instance.exports.test as () => number)(), env };
}

describe("#1904 standalone native __extern_is_array", () => {
  it("returns true for an any-typed compiled array without an env predicate import", async () => {
    const { value, env } = await compileStandaloneNumber(`
      let a: any;
      a = [1, 2, 3];
      export function test(): number {
        return Array.isArray(a) ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
    expect(env).toEqual([]);
  });

  it("returns false for standalone $Object and primitive carriers", async () => {
    const { value, env } = await compileStandaloneNumber(`
      export function test(): number {
        const o: any = { a: 1 };
        const n: any = 5;
        const s: any = "x";
        const z: any = null;
        return (Array.isArray(o) ? 1 : 0)
          + (Array.isArray(n) ? 2 : 0)
          + (Array.isArray(s) ? 4 : 0)
          + (Array.isArray(z) ? 8 : 0);
      }
    `);

    expect(value).toBe(0);
    expect(env).toEqual([]);
  });

  it("brands native $ObjVec enumeration results as arrays", async () => {
    const { value, env } = await compileStandaloneNumber(`
      export function test(): number {
        const o: any = { a: 1, b: 2 };
        const keys: any = Object.keys(o);
        return Array.isArray(keys) ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
    expect(env).toEqual([]);
  });

  it("fills the helper after arrays registered later in source order", async () => {
    const { value, env } = await compileStandaloneNumber(`
      function isArray(v: any): number {
        return Array.isArray(v) ? 1 : 0;
      }
      export function test(): number {
        const a: any = [1, 2, 3];
        return isArray(a);
      }
    `);

    expect(value).toBe(1);
    expect(env).toEqual([]);
  });

  it("preserves the array brand through an any-returning decoder", async () => {
    const { value, env } = await compileStandaloneNumber(`
      function decode(): any {
        const result: any[] = [];
        result.push(5);
        result.push(10);
        result.push(15);
        return result;
      }
      function classify(value: any): number {
        return Array.isArray(value) ? value.length : -1;
      }
      export function test(): number {
        return classify(decode());
      }
    `);

    expect(value).toBe(3);
    expect(env).toEqual([]);
  });

  it("runtime-tests erased any and unknown parameters in the boxed fast lane", async () => {
    const { value, env } = await compileStandaloneNumber(
      `
        function anyIsArray(value: any): number {
          return Array.isArray(value) ? 1 : 0;
        }
        function unknownIsArray(value: unknown): number {
          return Array.isArray(value) ? 1 : 0;
        }
        export function test(): number {
          return anyIsArray([1, 2]) + unknownIsArray([3, 4, 5]);
        }
      `,
      true,
    );

    expect(value).toBe(2);
    expect(env).toEqual([]);
  });
});
