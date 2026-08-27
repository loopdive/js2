// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2864 C02 — a generator whose body reads the implicit `arguments` object
 * carries that object through the Wasm-native generator frame.
 *
 * The factory builds the §10.2.11 arguments vec at call time, stores it in a
 * dedicated state field, and the detached RESUME context reloads that same vec
 * (including mapped-parameter metadata) before compiling the body. The focused
 * pins below cover free declarations, function expressions, object/class
 * methods, extras, resume-after-yield, and host controls.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#2864 S2 generator × arguments", () => {
  it("JS-HOST: a generator reading arguments emits a VALID module and the right value", async () => {
    // Regression pin for the invalid-module bug. `compileToWasm` itself runs
    // `WebAssembly.validate`, so an invalid binary fails here rather than at
    // instantiate — the property that actually broke.
    const exports = await compileToWasm(`
      function* g(a: number, b: number) { const n = arguments.length; yield n; }
      export function test(): number { return g(7, 8).next().value as number; }
    `);
    expect(exports.test()).toBe(2);
  });

  it("JS-HOST: arguments read AFTER a yield also works", async () => {
    const exports = await compileToWasm(`
      function* g(a: number, b: number) { yield 0; yield arguments.length; }
      export function test(): number {
        const it = g(7, 8);
        it.next();
        return it.next().value as number;
      }
    `);
    expect(exports.test()).toBe(2);
  });

  it("JS-HOST: a generator NOT reading arguments still routes natively", async () => {
    // Guards the blast radius: the bail must not pull ordinary generators off
    // the native path. A native host-lane generator has no `__gen_*` imports.
    const r = await compile(`function* g(a: number, b: number) { yield a + b; }
export function test(): number { return g(7, 8).next().value as number; }`);
    expect(r.success).toBe(true);
    const names = (r.imports ?? []).map((i) => (i as { name: string }).name);
    expect(names.filter((n) => n.startsWith("__gen_") || n === "__create_generator")).toEqual([]);
  });

  it("standalone: frame carries arguments and stays host-free", async () => {
    const r = await compile(
      `function* g(a: number, b: number) { const n = arguments.length; yield n; }
export function test(): number { return g(7, 8).next().value as number; }`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(WebAssembly.Module.imports(mod)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(2);
  });

  it("standalone: frame carries call-site extras for a zero-formal generator", async () => {
    const r = await compile(
      `function* g() { yield arguments.length; }
export function test(): number { return g(7, 8, 9).next().value as number; }`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(WebAssembly.Module.imports(mod)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(3);
  });

  it("standalone: a generator NOT reading arguments is still host-free", async () => {
    const r = await compile(
      `function* g(a: number, b: number) { yield a + b; }
export function test(): number { return g(7, 8).next().value as number; }`,
      {
        fileName: "test.ts",
        target: "standalone",
      },
    );
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(WebAssembly.Module.imports(mod)).toEqual([]);
  });

  it("standalone: function-expression frame carries arguments", async () => {
    const r = await compile(
      `export function test(): number {
  let ref: any;
  ref = function*() { yield arguments.length; };
  return ref(7, 8).next().value as number;
}`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(WebAssembly.Module.imports(mod)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(2);
  });

  it("standalone: object and class methods share the arguments carrier", async () => {
    const r = await compile(
      `const obj = { *om(a: number, b: number) { yield arguments.length; } };
class C { *cm(a: number, b: number) { yield arguments.length; } }
export function test(): number {
  return (obj.om(7, 8).next().value as number) + (new C().cm(7, 8).next().value as number);
}`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    expect(WebAssembly.Module.imports(await WebAssembly.compile(r.binary))).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(4);
  });

  it("standalone: mapped arguments writes survive a yield", async () => {
    const r = await compile(
      `function* g(a: number) { arguments[0] = 9; yield a; }
export function test(): number { return g(1).next().value as number; }`,
      { fileName: "test.ts", target: "standalone", inferModuleStrictArguments: false },
    );
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(9);
  });

  it("JS-HOST: method arguments remain a correct control", async () => {
    const exports = await compileToWasm(`
      const obj = { *m(a: number, b: number) { yield arguments.length; } };
      export function test(): number { return obj.m(7, 8).next().value as number; }
    `);
    expect(exports.test()).toBe(2);
  });
});
