// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

/**
 * #1504 — wrapExports marshals struct / array return values to plain JS.
 *
 * Before this change, `exports.makeUser()` returned an opaque WasmGC handle:
 * `typeof === "object"`, but `obj.name` threw "WebAssembly objects are opaque",
 * `JSON.stringify(obj)` returned `"{}"`, and arrays were entirely unreadable.
 *
 * wrapExports now routes struct/vec returns through `_wasmToPlain` so callers
 * get plain JS objects / arrays. Closure returns (#1308) still come back as
 * JS-callable functions.
 */

async function run(src: string): Promise<Record<string, any>> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setInstance?.(instance);
  return wrapExports(instance);
}

async function runRaw(src: string): Promise<Record<string, any>> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setInstance?.(instance);
  return wrapExports(instance, { marshal: false });
}

describe("#1504 — wrapExports marshals struct/array returns to plain JS", () => {
  it("struct return: field access works (was opaque)", async () => {
    const exports = await run(`
      export function makeUser(): { id: number; name: string } {
        return { id: 7, name: "Alice" };
      }
    `);
    const u = exports.makeUser();
    expect(u).not.toBeNull();
    expect(u.id).toBe(7);
    expect(u.name).toBe("Alice");
  });

  it("struct return: JSON.stringify produces real JSON (was '{}')", async () => {
    const exports = await run(`
      export function makeUser(): { id: number; name: string } {
        return { id: 7, name: "Alice" };
      }
    `);
    const u = exports.makeUser();
    expect(JSON.stringify(u)).toBe('{"id":7,"name":"Alice"}');
  });

  it("array return: indexing + length work (was unreadable)", async () => {
    const exports = await run(`
      export function listIds(): number[] {
        return [10, 20, 30];
      }
    `);
    const ids = exports.listIds();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBe(3);
    expect(ids[0]).toBe(10);
    expect(ids[2]).toBe(30);
    expect(ids).toEqual([10, 20, 30]);
  });

  it("closure return still callable (regression guard for #1308)", async () => {
    const exports = await run(`
      export function makeFn(): () => number {
        return () => 42;
      }
    `);
    const fn = exports.makeFn();
    expect(typeof fn).toBe("function");
    expect(fn()).toBe(42);
  });

  it("primitive return unchanged", async () => {
    const exports = await run(`
      export function add(a: number, b: number): number {
        return a + b;
      }
      export function greet(): string {
        return "hi";
      }
    `);
    expect(exports.add(2, 3)).toBe(5);
    expect(exports.greet()).toBe("hi");
  });

  it("{ marshal: false } opt-out keeps raw WasmGC handles", async () => {
    const exports = await runRaw(`
      export function makeUser(): { id: number; name: string } {
        return { id: 7, name: "Alice" };
      }
    `);
    const u = exports.makeUser();
    // Raw WasmGC handle: typeof object but Object.keys is empty + dot access
    // either throws or returns undefined depending on the runtime path.
    expect(typeof u).toBe("object");
    expect(u).not.toBeNull();
    // With marshal disabled we should NOT receive a plain object with the
    // user-visible fields populated by _wasmToPlain.
    expect((u as { name?: string }).name).not.toBe("Alice");
  });
});
