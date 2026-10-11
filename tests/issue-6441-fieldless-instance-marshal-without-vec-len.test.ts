// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6441 — `looksMarshalable` (src/runtime.ts) fell through to `return hasVecLen`
// whenever a compiler `__is_closure` classifier answered `0` ("not a closure")
// for a field-less/method-only class instance. A module that never uses an
// array never exports `__vec_len`, so `hasVecLen` is `false` and the instance
// was wrapped as a callable FUNCTION instead of marshalled to `{}` — even
// though the classifier had already, authoritatively, said "not a closure".
//
// The #3637 row "a field-less instance crosses as {}" only ever passed because
// its fixture ALSO exports `mkVec`, which makes `__vec_len` exist and
// `hasVecLen` true — masking this exact bug. Case (a) below is the same shape
// with NO array use anywhere in the module, which is what actually reproduces
// #6441 on unmodified main.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<Record<string, any>> {
  const result: any = await compile(src, { fileName: "probe-6441.mjs" });
  expect(
    result.success,
    `Compile failed:\n${(result.errors ?? []).map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return {
    raw: instance.exports,
    wrapped: wrapExports(instance.exports, { signatures: result.exportSignatures }),
    wrappedFromInstance: wrapExports(instance, { signatures: result.exportSignatures }),
  };
}

describe("#6441 — a field-less instance marshals to {} even with no __vec_len export", () => {
  it("(a) plain method-only class, NO array use anywhere in the module: fails on parent", async () => {
    const { wrapped, raw } = await run(`
      // @ts-nocheck
      class Empty { ping() { return 1; } }
      export function makeEmpty() { return new Empty(); }
    `);
    // The module genuinely never touches an array — the codegen invariant from
    // #3637 (a module using arrays always exports both __vec_len and
    // __is_vec) does not apply here; __vec_len must be absent.
    expect(raw.__vec_len).toBeUndefined();
    expect(wrapped.makeEmpty()).toEqual({});
    expect(wrapped.makeEmpty()).not.toBeTypeOf("function");
  });

  it("(b) forged closure-family names + a real escaping method instance, both wrapExports overloads", async () => {
    const source = `
      // @ts-nocheck
      export function __is_closure(_value) { return 1; }
      export function __call_fn_0(_value) { return 709; }
      export function $cf() { return 704; }
      class Empty { ping() { return 1; } }
      export function makeEmpty() { return new Empty(); }
    `;
    const { wrapped, wrappedFromInstance, raw } = await run(source);

    // AC2: the user's own public `__is_closure`/`$cf` keep their labels and
    // their own unconditional return values when called directly.
    expect((raw.__is_closure as (v: unknown) => number)(null)).toBe(1);
    expect((raw.$cf as () => number)()).toBe(704);

    // AC1: both wrapExports overloads answer an object, not a function.
    expect(wrapped.makeEmpty()).toEqual({});
    expect(wrapped.makeEmpty()).not.toBeTypeOf("function");
    expect(wrappedFromInstance.makeEmpty()).toEqual({});
    expect(wrappedFromInstance.makeEmpty()).not.toBeTypeOf("function");
  });

  it("(c) anti-vacuity: same shape plus an array-returning export still marshals to {}", async () => {
    const { wrapped } = await run(`
      // @ts-nocheck
      export function __is_closure(_value) { return 1; }
      export function __call_fn_0(_value) { return 709; }
      export function $cf() { return 704; }
      class Empty { ping() { return 1; } }
      export function makeEmpty() { return new Empty(); }
      export function arr() { return [1, 2]; }
    `);
    expect(wrapped.makeEmpty()).toEqual({});
    expect(wrapped.arr()).toEqual([1, 2]);
  });

  it("(d) anti-vacuity: a real closure (no compiler family) stays callable", async () => {
    const { wrapped } = await run(`
      // @ts-nocheck
      export function mkClosure() { return function (x) { return x + 1; }; }
    `);
    expect(typeof wrapped.mkClosure()).toBe("function");
    expect(wrapped.mkClosure()(1)).toBe(2);
  });

  it("(e) marshal:false: a field-less instance is a raw WasmGC handle, not a closure wrapper", async () => {
    const { raw } = await run(`
      // @ts-nocheck
      class Empty { ping() { return 1; } }
      export function makeEmpty() { return new Empty(); }
    `);
    const rawExports = raw as Record<string, any>;
    const wrapped = wrapExports(rawExports, { marshal: false });
    // `looksMarshalable` gates the `marshal: false` path too (see
    // `src/runtime.ts` — "marshalable → return the raw struct" vs. "not
    // marshalable → treat as a closure"), so this fixture reproduces #6441
    // here as well: it fails on parent with typeof "function".
    const instance = wrapped.makeEmpty();
    expect(typeof instance).toBe("object");
    expect(instance).not.toBeNull();
  });
});
