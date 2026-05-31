// Regression test for #1589A (parent #1589 hot spot A):
//
// `Array.prototype.{indexOf,lastIndexOf}.call(obj, target)` on an object
// literal whose values are empty `{}` objects and whose `length` is the
// 2^32 boundary used to hang for ~30s and pin the test262 compile_timeout
// budget. Two compounding bugs:
//
//   Bug 1 (codegen): an empty-object (`{}`) property value was registered as
//   a ref-to-empty-struct field type. At construction the value is a host
//   externref, so the externref→(ref null struct) coercion failed the
//   ref.test and stored ref.null. Reading the field back yielded null,
//   losing the value. Fixed in ensureStructForType (src/codegen/index.ts):
//   a zero-own-property value type is now widened to externref.
//
//   Bug 2 (runtime): `__extern_has_idx` treated "struct getter returns null"
//   as "property absent" (`if (v != null) return 1`). Spec HasProperty
//   (§7.3.12) is true for any own property regardless of value. Fixed so a
//   getter that returns at all (even null) reports presence; only a throw
//   means "field not defined on this variant".
//
// Affected test262:
//   built-ins/Array/prototype/indexOf/15.4.4.14-3-28.js
//   built-ins/Array/prototype/indexOf/15.4.4.14-3-29.js
//   built-ins/Array/prototype/lastIndexOf/15.4.4.15-3-28.js

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("compile failed: " + r.errors?.[0]?.message);
  const imports = buildImports((r as any).imports ?? [], undefined, (r as any).stringPool ?? []);
  const { instance } = await WebAssembly.instantiate(r.binary!, imports);
  (imports as any).setExports?.(instance.exports);
  return (instance.exports as any).test?.();
}

describe("#1589A — Array.prototype.{indexOf,lastIndexOf}.call on empty-object-valued array-likes", () => {
  it("indexOf finds an empty-object value at index 0", async () => {
    const out = await compileAndRun(`
      export function test(): number {
        var targetObj = {};
        var obj = { 0: targetObj, 1: targetObj, length: 2 };
        return Array.prototype.indexOf.call(obj, targetObj);
      }
    `);
    expect(out).toBe(0);
  });

  it("indexOf finds an empty-object value at a non-zero index", async () => {
    const out = await compileAndRun(`
      export function test(): number {
        var t = {};
        var obj = { 0: {}, 1: t, length: 2 };
        return Array.prototype.indexOf.call(obj, t);
      }
    `);
    expect(out).toBe(1);
  });

  it("indexOf returns -1 when the empty-object value is not present", async () => {
    const out = await compileAndRun(`
      export function test(): number {
        var t = {};
        var obj = { 0: {}, 1: {}, length: 2 };
        return Array.prototype.indexOf.call(obj, t);
      }
    `);
    expect(out).toBe(-1);
  });

  it("lastIndexOf finds an empty-object value", async () => {
    const out = await compileAndRun(`
      export function test(): number {
        var t = {};
        var obj = { 0: t, 1: {}, length: 2 };
        return Array.prototype.lastIndexOf.call(obj, t);
      }
    `);
    expect(out).toBe(0);
  });

  it("indexOf on a length=2^32 array-like short-circuits at index 0 (no hang)", async () => {
    // The test262 shape: target lives at index 0 so HasProperty must report
    // present on the first iteration and the loop returns 0 immediately
    // instead of scanning 4.29B indices.
    const out = await compileAndRun(`
      export function test(): number {
        var targetObj = {};
        var obj = { 0: targetObj, 4294967294: targetObj, 4294967295: targetObj, length: 4294967296 };
        return Array.prototype.indexOf.call(obj, targetObj);
      }
    `);
    expect(out).toBe(0);
  });

  it("regression guard: a thrown Error (named struct) still constructs and reads back", async () => {
    // Bug 1's widening must only fire for zero-own-property values, never for
    // named structs like Error. This exercises the dedup-collapse path the
    // architect flagged as the high-risk collateral.
    const out = await compileAndRun(`
      export function test(): number {
        try {
          throw new Error("boom");
        } catch (e: any) {
          return e.message === "boom" ? 1 : 0;
        }
      }
    `);
    expect(out).toBe(1);
  });
});
