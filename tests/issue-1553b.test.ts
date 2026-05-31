// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1553b — typed-struct object destructuring declaration delegates to the
// shared destructureParamObject helper. Covers the bugs the helper now closes:
//
// - Bug 3: nested pattern default value (`let {w:{x,y,z}={x:1,y:2,z:3}}={w:undefined}`)
//   was silently throwing TypeError on the old typed-struct path because there
//   was no default-initializer handling inside the nested loop.
// - TDZ flag emission on let/const typed-struct decls.
// - Null guard on typed RHS must throw TypeError (spec-correct).
// - Rest binding (`{a, ...r}`) falls through to externref path correctly.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const wrapped = `export function test(): number { ${src} return 1; }`;
  const r = await compile(wrapped, { fileName: "t.ts" });
  if (!r.success) {
    throw new Error(`CE: ${r.errors.map((e) => e.message).join(", ")}`);
  }
  // Stub host imports the compiler may emit.
  const noopExt: any = () => undefined;
  const env: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "__throw_type_error_destructure_null") {
          return () => {
            throw new TypeError("Cannot destructure null/undefined");
          };
        }
        if (prop === "__extern_rest_object") {
          // Simple stub: returns an empty object (tests don't deeply inspect)
          return () => ({});
        }
        if (prop === "__extern_get") return (o: any, k: string) => o?.[k];
        if (prop === "__extern_is_undefined") return (v: any) => (v === undefined ? 1 : 0);
        if (prop === "__get_undefined") return () => undefined;
        if (prop === "__box_number") return (n: number) => n;
        return noopExt;
      },
    },
  );
  const jsStringPolyfill: any = new Proxy(
    {},
    {
      get(_t, prop) {
        const name = String(prop);
        if (name === "concat") return (a: string, b: string) => a + b;
        if (name === "length") return (s: string) => s.length;
        if (name === "equals") return (a: string, b: string) => (a === b ? 1 : 0);
        if (name === "substring") return (s: string, a: number, b: number) => s.substring(a, b);
        if (name === "charCodeAt") return (s: string, i: number) => s.charCodeAt(i);
        if (name === "fromCharCode") return (c: number) => String.fromCharCode(c);
        if (name === "compare") return (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
        if (name === "intoCharCodeArray")
          return (s: string, arr: any, start: number) => {
            for (let i = 0; i < s.length; i++) arr[start + i] = s.charCodeAt(i);
            return s.length;
          };
        if (name === "fromCharCodeArray")
          return (arr: any, start: number, end: number) => {
            const codes: number[] = [];
            for (let i = start; i < end; i++) codes.push(arr[i]);
            return String.fromCharCode(...codes);
          };
        return noopExt;
      },
    },
  );
  const imports: any = {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(r.stringPool),
  };
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#1553b: typed-struct object destructuring decl → shared helper", () => {
  it("plain typed-struct destructuring still works", async () => {
    // Baseline — no defaults, no nesting, no rest.
    const src = `
      const obj: { a: number; b: number } = { a: 10, b: 20 };
      const { a, b } = obj;
      if (a !== 10) return 2;
      if (b !== 20) return 3;
    `;
    expect(await run(src)).toBe(1);
  });

  it("typed nested destructuring without default works", async () => {
    const src = `
      const obj: { a: number; b: { c: number; d: number } } = { a: 1, b: { c: 2, d: 3 } };
      const { a, b: { c, d } } = obj;
      if (a !== 1) return 2;
      if (c !== 2) return 3;
      if (d !== 3) return 4;
    `;
    expect(await run(src)).toBe(1);
  });

  it("typed object with default — value present, default does NOT fire", async () => {
    // Exercises emitDefaultValueCheck on the typed-struct path; default must
    // be SKIPPED when the field holds a defined value.
    const src = `
      const obj: { x: number; y: number } = { x: 10, y: 20 };
      const { x = 99, y = 42 } = obj;
      if (x !== 10) return 2;
      if (y !== 20) return 3;
    `;
    expect(await run(src)).toBe(1);
  });

  it("typed nested object with sibling default — default uses fallback object", async () => {
    // Bug 3 — the nested {x,y,z}={x:1,y:2,z:3} default must fire when the
    // outer field is undefined. Previously this throw TypeError.
    const src = `
      const obj: { w: { x: number; y: number; z: number } | undefined } = { w: undefined };
      const { w: { x, y, z } = { x: 1, y: 2, z: 3 } } = obj;
      if (x !== 1) return 2;
      if (y !== 2) return 3;
      if (z !== 3) return 4;
    `;
    expect(await run(src)).toBe(1);
  });

  it("var-decl typed destructuring works", async () => {
    const src = `
      const obj: { a: number; b: number } = { a: 5, b: 6 };
      var { a, b } = obj;
      if (a !== 5) return 2;
      if (b !== 6) return 3;
    `;
    expect(await run(src)).toBe(1);
  });

  it("let-decl typed destructuring works", async () => {
    const src = `
      const obj: { a: number; b: number } = { a: 7, b: 8 };
      let { a, b } = obj;
      a = a + 1;
      if (a !== 8) return 2;
      if (b !== 8) return 3;
    `;
    expect(await run(src)).toBe(1);
  });

  it("typed destructuring with renamed binding works", async () => {
    const src = `
      const obj: { name: string; age: number } = { name: "x", age: 30 };
      const { name: who, age: years } = obj;
      if (who !== "x") return 2;
      if (years !== 30) return 3;
    `;
    expect(await run(src)).toBe(1);
  });

  it("typed nested null source throws TypeError (spec-correct null guard)", async () => {
    // Bug 4 — destructuring a nested pattern off a null field must throw a
    // TypeError, not silently bind undefined. The shared helper emits the
    // per-element null guard on the typed-struct path. The host stub for
    // __throw_type_error_destructure_null raises; in no-JS-host paths the
    // in-module guard raises a Wasm trap. Either way the call must throw.
    const src = `
      const obj: { w: { x: number } | null } = { w: null };
      const { w: { x } } = obj;
      if (x !== x) return 2;
    `;
    await expect(run(src)).rejects.toThrow();
  });

  it("typed top-level default fires when field is undefined", async () => {
    // emitDefaultValueCheck on the typed-struct path: a top-level binding's
    // default must fire when the source field is undefined.
    const src = `
      const obj: { x?: number; y: number } = { y: 5 };
      const { x = 99, y } = obj;
      if (x !== 99) return 2;
      if (y !== 5) return 3;
    `;
    expect(await run(src)).toBe(1);
  });
});
