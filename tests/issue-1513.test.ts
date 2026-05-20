// #1513 — Reflect: TypeError on non-object/Symbol target + abrupt-completion propagation.
//
// Reflect.X(non-object) must throw a JS TypeError per ECMA-262 §26.1.
// Before #1513 the synthetic rewrites to Object.X(target) silently returned
// undefined/false for primitive targets.
//
// Also tests:
//   - Reflect.defineProperty(frozen, ...) returns false instead of throwing
//   - Reflect.ownKeys ordering: integer keys ascending, then strings, then symbols
//   - Reflect.has via __reflect_has host import (prototype-chain aware)

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runWasm(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`Compile error: ${r.errors[0]?.message}`);
  }
  const built = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, built);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1513 Reflect type checks + boolean defineProperty + ownKeys ordering", () => {
  // Each method's "target is non-object → TypeError" cell. Returns 1 when a
  // TypeError was thrown, 0 when the call succeeded (regression), -1 otherwise.
  it.each([
    ["ownKeys(1)", `Reflect.ownKeys(1 as any);`],
    ["getPrototypeOf(undefined)", `Reflect.getPrototypeOf(undefined as any);`],
    ["has(1)", `Reflect.has(1 as any, "a");`],
    ["get(1)", `Reflect.get(1 as any, "a");`],
    ["set(1)", `Reflect.set(1 as any, "a", 2);`],
    ["defineProperty(1)", `Reflect.defineProperty(1 as any, "a", {});`],
    ["setPrototypeOf(undefined)", `Reflect.setPrototypeOf(undefined as any, null);`],
    ["deleteProperty(1)", `Reflect.deleteProperty(1 as any, "a");`],
    ["isExtensible(1)", `Reflect.isExtensible(1 as any);`],
    ["preventExtensions(1)", `Reflect.preventExtensions(1 as any);`],
    ["getOwnPropertyDescriptor(1)", `Reflect.getOwnPropertyDescriptor(1 as any, "a");`],
  ] as const)("%s throws TypeError", async (_label, snippet) => {
    const src = `export function test(): number {
      try { ${snippet} return 0; }
      catch (e: any) { return e instanceof TypeError ? 1 : -1; }
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.defineProperty returns false on define-failure (frozen target)", async () => {
    const src = `export function test(): number {
      const o: any = {};
      Object.freeze(o);
      return Reflect.defineProperty(o, "x", { value: 1 }) === false ? 1 : 0;
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.defineProperty returns true on success", async () => {
    const src = `export function test(): number {
      const o: any = {};
      return Reflect.defineProperty(o, "x", { value: 1 }) === true ? 1 : 0;
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.ownKeys returns integer keys ascending, then string keys", async () => {
    const src = `export function test(): number {
      const o: any = { 0: 1, "1": 2, a: 3, b: 4 };
      const k: any = Reflect.ownKeys(o);
      if (k.length !== 4) return -1;
      if (k[0] !== "0") return -2;
      if (k[1] !== "1") return -3;
      if (k[2] !== "a") return -4;
      if (k[3] !== "b") return -5;
      return 1;
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.ownKeys includes symbols after string keys", async () => {
    const src = `export function test(): number {
      const s: any = Symbol("x");
      const o: any = {};
      o.a = 1;
      o[s] = 2;
      const k: any = Reflect.ownKeys(o);
      if (k.length !== 2) return -k.length;
      if (k[0] !== "a") return -10;
      if (typeof k[1] !== "symbol") return -11;
      return 1;
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.get returns own property value", async () => {
    const src = `export function test(): number {
      const o: any = { a: 42 };
      return Reflect.get(o, "a") === 42 ? 1 : 0;
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.set writes a property", async () => {
    const src = `export function test(): number {
      const o: any = {};
      Reflect.set(o, "a", 7);
      return o.a === 7 ? 1 : 0;
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.has finds own properties", async () => {
    const src = `export function test(): number {
      const o: any = { a: 1 };
      // __reflect_has returns i32 1 for present, 0 for absent.
      return Reflect.has(o, "a") ? 1 : 0;
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.has returns falsy for absent keys", async () => {
    const src = `export function test(): number {
      const o: any = { a: 1 };
      return Reflect.has(o, "missing") ? 0 : 1;
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.deleteProperty removes a property", async () => {
    const src = `export function test(): number {
      const o: any = { a: 1 };
      Reflect.deleteProperty(o, "a");
      return "a" in o ? 0 : 1;
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.preventExtensions marks non-extensible", async () => {
    const src = `export function test(): number {
      const o: any = {};
      Reflect.preventExtensions(o);
      return Object.isExtensible(o) ? 0 : 1;
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.getPrototypeOf returns Object.prototype for plain object", async () => {
    const src = `export function test(): number {
      const o: any = {};
      return Reflect.getPrototypeOf(o) === Object.prototype ? 1 : 0;
    }`;
    expect(await runWasm(src)).toBe(1);
  });

  it("Reflect.getOwnPropertyDescriptor returns descriptor object", async () => {
    const src = `export function test(): number {
      const o: any = { a: 5 };
      const d: any = Reflect.getOwnPropertyDescriptor(o, "a");
      return d && d.value === 5 ? 1 : 0;
    }`;
    expect(await runWasm(src)).toBe(1);
  });
});
