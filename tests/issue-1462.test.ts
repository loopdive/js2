/**
 * Tests for issue #1462: spec gap in the Object.* descriptor "read side".
 *
 * Acceptance criteria (excerpt from the issue file):
 *   1. Object.getOwnPropertyDescriptor(primitive, key) boxes via ToObject
 *      and returns a spec-shaped descriptor.
 *   2. Data-property defaults are reflected:
 *      {value, writable:true, enumerable:true, configurable:true} for
 *      regular assignments; string-index descriptors give the spec's
 *      non-writable, non-configurable shape; global built-in fn
 *      descriptors give non-enumerable.
 *   3. Object.create(proto, propMap) walks own enumerable keys of propMap
 *      and applies descriptors via the defineProperty path.
 *   4. Object.create(null, propMap) produces a null-prototype object.
 *   7. Object.freeze/seal/preventExtensions and their is* predicates
 *      accept primitive inputs without throwing (per ES2015+).
 *
 * The big-bucket spec gap addressed here:
 *   - Object.isFrozen/isSealed on a primitive must return TRUE, not false.
 *   - Object.isExtensible on a primitive must return FALSE, not true.
 *     (ES2015+ §19.1.2.12–14: "If Type(O) is not Object, return …".)
 *   - Object.getPrototypeOf(null/undefined) must throw TypeError per
 *     ToObject; previously returned null silently.
 *   - Object.create(primitive) must not produce a malformed Wasm module
 *     — coerceType is now used in place of a bare extern.convert_any on
 *     f64, which previously failed validation with "expected anyref,
 *     found f64.const".
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).test!();
}

describe("issue #1462: Object.* descriptor read side + create propMap", () => {
  // ── Acceptance #2: data-property defaults round-trip ────────────────
  it("getOwnPropertyDescriptor returns spec-shaped descriptor for plain data property", async () => {
    const src = `
export function test(): number {
  const obj: any = {x: 42};
  const d: any = Object.getOwnPropertyDescriptor(obj, "x");
  if (d == null) return 300;
  if (d.value !== 42) return 301;
  if (d.writable !== true) return 302;
  if (d.enumerable !== true) return 303;
  if (d.configurable !== true) return 304;
  return 1;
}`;
    expect(await runTest(src)).toBe(1);
  });

  // ── Acceptance #2: string exotic index descriptor shape ─────────────
  it("getOwnPropertyDescriptor on string index returns spec-correct flags", async () => {
    const src = `
export function test(): number {
  const d: any = Object.getOwnPropertyDescriptor("foo", "0");
  if (d == null) return 200;
  if (d.value !== "f") return 201;
  if (d.writable !== false) return 202;
  if (d.enumerable !== true) return 203;
  if (d.configurable !== false) return 204;
  return 1;
}`;
    expect(await runTest(src)).toBe(1);
  });

  // ── Acceptance #2: global built-in function descriptors ─────────────
  it("getOwnPropertyDescriptor(globalThis, builtinFn) is non-enumerable, configurable", async () => {
    const src = `
export function test(): number {
  const d: any = Object.getOwnPropertyDescriptor(globalThis, "isNaN");
  if (d == null) return 500;
  if (d.enumerable !== false) return 501;
  if (d.configurable !== true) return 502;
  if (d.writable !== true) return 503;
  return 1;
}`;
    expect(await runTest(src)).toBe(1);
  });

  // ── Acceptance #1: primitive arg routes through ToObject ────────────
  it("getOwnPropertyDescriptor(primitive, missing-key) returns undefined (no throw)", async () => {
    const src = `
export function test(): number {
  const d: any = Object.getOwnPropertyDescriptor(-2, "foo");
  return d === undefined ? 1 : 100;
}`;
    expect(await runTest(src)).toBe(1);
  });

  it("getOwnPropertyDescriptor returns undefined for missing own key", async () => {
    const src = `
export function test(): number {
  const obj: any = {x: 1};
  const d: any = Object.getOwnPropertyDescriptor(obj, "y");
  return d === undefined ? 1 : 100;
}`;
    expect(await runTest(src)).toBe(1);
  });

  // ── Acceptance #3: Object.create(proto, propMap) honours descriptors ─
  it("Object.create with descriptor map applies non-default flags", async () => {
    const src = `
export function test(): number {
  const o: any = Object.create({}, {x: {value: 42, enumerable: false, configurable: false, writable: false}});
  const d: any = Object.getOwnPropertyDescriptor(o, "x");
  if (d == null) return 400;
  if (d.value !== 42) return 401;
  if (d.enumerable !== false) return 402;
  if (d.configurable !== false) return 403;
  if (d.writable !== false) return 404;
  return 1;
}`;
    expect(await runTest(src)).toBe(1);
  });

  // ── Acceptance #4: Object.create(null) produces null-proto object ───
  it("Object.create(null) yields a null-prototype object", async () => {
    const src = `
export function test(): number {
  const o: any = Object.create(null);
  if (Object.getPrototypeOf(o) !== null) return 800;
  return 1;
}`;
    expect(await runTest(src)).toBe(1);
  });

  // ── Acceptance #7: primitive isFrozen/isSealed/isExtensible per spec ─
  it("Object.isFrozen(primitive) returns true (ES2015+ §19.1.2.13)", async () => {
    const src = `
export function test(): number {
  if (!Object.isFrozen(5)) return 100;
  if (!Object.isFrozen("x")) return 101;
  if (!Object.isFrozen(true)) return 102;
  if (!Object.isFrozen(null as any)) return 103;
  if (!Object.isFrozen(undefined as any)) return 104;
  return 1;
}`;
    expect(await runTest(src)).toBe(1);
  });

  it("Object.isSealed(primitive) returns true (ES2015+ §19.1.2.14)", async () => {
    const src = `
export function test(): number {
  if (!Object.isSealed(5)) return 100;
  if (!Object.isSealed("x")) return 101;
  if (!Object.isSealed(true)) return 102;
  if (!Object.isSealed(null as any)) return 103;
  return 1;
}`;
    expect(await runTest(src)).toBe(1);
  });

  it("Object.isExtensible(primitive) returns false (ES2015+ §19.1.2.12)", async () => {
    const src = `
export function test(): number {
  if (Object.isExtensible(5)) return 100;
  if (Object.isExtensible("x")) return 101;
  if (Object.isExtensible(true)) return 102;
  if (Object.isExtensible(null as any)) return 103;
  return 1;
}`;
    expect(await runTest(src)).toBe(1);
  });

  it("Object.freeze/seal/preventExtensions(primitive) return the value without throwing", async () => {
    const src = `
export function test(): number {
  if (Object.freeze(5) !== 5) return 100;
  if (Object.seal("x") !== "x") return 101;
  if (Object.preventExtensions(7) !== 7) return 102;
  return 1;
}`;
    expect(await runTest(src)).toBe(1);
  });

  // ── Object.create on primitives no longer crashes the compiler ──────
  it("Object.create(primitive) throws TypeError instead of producing an invalid module (#1462 codegen)", async () => {
    const src = `
export function test(): number {
  const proto: any = 5;
  try { Object.create(proto); return 0; } catch (e) { return 1; }
}`;
    expect(await runTest(src)).toBe(1);
  });

  // ── Object.getPrototypeOf(null/undefined) throws per ToObject ───────
  it("Object.getPrototypeOf(null) throws TypeError", async () => {
    const src = `
export function test(): number {
  try { Object.getPrototypeOf(null as any); return 0; } catch (e) { return 1; }
}`;
    expect(await runTest(src)).toBe(1);
  });

  // ── Sanity: keys/values/entries on primitives don't throw ───────────
  it("Object.keys/values/entries on primitive return the right size array", async () => {
    const src = `
export function test(): number {
  const k: any = Object.keys("ab");
  if (k.length !== 2) return 100 + k.length;
  const v: any = Object.values("ab");
  if (v.length !== 2) return 200 + v.length;
  const e: any = Object.entries(5);
  if (e.length !== 0) return 300 + e.length;
  return 1;
}`;
    expect(await runTest(src)).toBe(1);
  });

  it("Object.getOwnPropertyNames on a string returns indices + length", async () => {
    const src = `
export function test(): number {
  const a: any = Object.getOwnPropertyNames("abc");
  return a.length === 4 ? 1 : 100 + a.length;
}`;
    expect(await runTest(src)).toBe(1);
  });
});
