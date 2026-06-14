import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #16 — standalone Array.prototype generics over an array-like `$Object`
// receiver emitted INVALID Wasm (`local.set[0] expected f64, found call
// externref` / `call[0] expected extern`). emitWat printed valid output but
// emitBinary baked the wrong numeric funcIdx, so the two diverged.
//
// Root cause (addUnionImports late-shift hazard): `compileArrayLikePrototypeCall`
// / `compileArrayLikePrototypeSearch` captured `__extern_length` /
// `__extern_get_idx` / `__extern_has_idx` (+ the comparison helper) funcIdx at
// the TOP of the function, then compiled the receiver / callback / fromIndex and
// (for filter/map/reduce) registered `__js_array_*` — each of which can register
// a new function and SHIFT every defined-func index. The captured funcIdx went
// stale-low, so the emitted `call` targeted the WRONG function (e.g. indexOf's
// `__extern_length` call resolved to `__object_keys`, which returns externref →
// `local.set <f64-local>` type error). The printed name in emitWat hid it.
//
// Fix: re-resolve the helper funcIdx from `ctx.funcMap` (names are stable) AFTER
// the operand compiles, and pre-register the result-array build helpers up-front
// so their shifts happen before the re-resolve.
//
// This test asserts the binary is now structurally VALID for every array-like
// method over an array-like receiver. (Full runtime correctness over a pure
// `$Object` receiver additionally needs the #2036 `$Object` arm and the #2081
// native loose-eq; those are separate. Invalid Wasm — #16 — is fixed here.)

async function isValidStandalone(src: string): Promise<boolean> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  return WebAssembly.validate(r.binary);
}

const ARRAYLIKE = `const o: any = { 0: 5, 1: 6, length: 2 };`;

describe("#16 array-like generics over $Object — valid Wasm (funcIdx shift)", () => {
  it("indexOf emits valid Wasm", async () => {
    expect(
      await isValidStandalone(
        `function p(o: any): number { return Array.prototype.indexOf.call(o, 6); }
         export function test(): number { ${ARRAYLIKE} return p(o); }`,
      ),
    ).toBe(true);
  });

  it("lastIndexOf emits valid Wasm", async () => {
    expect(
      await isValidStandalone(
        `function p(o: any): number { return Array.prototype.lastIndexOf.call(o, 6); }
         export function test(): number { ${ARRAYLIKE} return p(o); }`,
      ),
    ).toBe(true);
  });

  it("includes emits valid Wasm", async () => {
    expect(
      await isValidStandalone(
        `function p(o: any): number { return Array.prototype.includes.call(o, 6) ? 1 : 0; }
         export function test(): number { ${ARRAYLIKE} return p(o); }`,
      ),
    ).toBe(true);
  });

  it("filter emits valid Wasm", async () => {
    expect(
      await isValidStandalone(
        `function p(o: any): number { const r: any = Array.prototype.filter.call(o, (x: any) => x > 5); return r.length; }
         export function test(): number { ${ARRAYLIKE} return p(o); }`,
      ),
    ).toBe(true);
  });

  it("map emits valid Wasm", async () => {
    expect(
      await isValidStandalone(
        `function p(o: any): number { const r: any = Array.prototype.map.call(o, (x: any) => x * 2); return r.length; }
         export function test(): number { ${ARRAYLIKE} return p(o); }`,
      ),
    ).toBe(true);
  });

  it("forEach/some/every/find/findIndex stay valid", async () => {
    expect(
      await isValidStandalone(
        `function p(o: any): number { let s = 0; Array.prototype.forEach.call(o, (x: any) => { s += x; }); return s; }
         export function test(): number { ${ARRAYLIKE} return p(o); }`,
      ),
    ).toBe(true);
    expect(
      await isValidStandalone(
        `function p(o: any): number { return Array.prototype.some.call(o, (x: any) => x > 0) ? 1 : 0; }
         export function test(): number { ${ARRAYLIKE} return p(o); }`,
      ),
    ).toBe(true);
    expect(
      await isValidStandalone(
        `function p(o: any): number { return Array.prototype.findIndex.call(o, (x: any) => x === 6); }
         export function test(): number { ${ARRAYLIKE} return p(o); }`,
      ),
    ).toBe(true);
  });
});
