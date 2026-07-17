// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3311 (G4 of the #2928 `CallBuiltin` prerequisite chain) — `string[]` push /
// pop on a genuinely-`any` receiver under `--target standalone` / `--target
// wasi`.
//
// Root cause: the carrier-generic `__vec_push` / `__vec_pop` helpers (built in
// vec-access-exports.ts) covered only the externref / f64 / i32 element
// carriers. The native-string vec carrier (`string[]` under nativeStrings lowers
// to a vec of `(ref null $AnyString)` elements, keyed `ref_<anyStrTypeIdx>`) was
// NOT in `mutEntries`, so `__vec_push` returned the `-1` unsupported-carrier
// sentinel → the #2927 `$__vec_base` brand arm mapped that to `undefined` (a
// silent no-op), and `__vec_pop` returned `undefined` for the same receivers.
//
// Fix (#3311): `mutEntries` admits the native-string carrier, and the
// `__vec_push`/`__vec_pop`/`__vec_set_elem` value-marshaling arms recover the GC
// string ref from the externref value (`any.convert_extern` +
// `ref.cast_null $AnyString`) / box a popped element back (`extern.convert_any`).
//
// The standalone assertions instantiate with an EMPTY import object and first
// assert the module declares ZERO function imports — the behaviour is truly
// HOST-FREE, not silently satisfied by a JS host bridge. String VALUE checks are
// done INSIDE the compiled function (returning a boolean) so no native string
// crosses the JS boundary.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runHost(source: string): Promise<unknown> {
  const result: any = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error("compile: " + result.errors.map((e: any) => e.message).join("; "));
  }
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

/** Compile host-free (`target: standalone`), assert 0 function imports, run. */
async function runStandaloneHostFree(source: string): Promise<unknown> {
  const result: any = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.success) {
    throw new Error("compile: " + result.errors.map((e: any) => e.message).join("; "));
  }
  const mod = await WebAssembly.compile(result.binary);
  const fnImports = WebAssembly.Module.imports(mod).filter((i) => i.kind === "function");
  // The whole point of the fix: this path is host-free. If a JS host bridge
  // import sneaks back in, the "standalone" result is a lie — fail loudly.
  expect(fnImports.map((i) => `${i.module}.${i.name}`)).toEqual([]);
  const instance: any = await WebAssembly.instantiate(mod, {});
  return instance.exports.test();
}

describe("#3311 — standalone any-receiver string[] .push/.pop mutates the native vec (host-free)", () => {
  it("push returns the new length (was undefined/no-op standalone)", async () => {
    const src = `function f(x: any, y: any): number { return x.push(y); }
                 export function test(): number { return f(["a", "b"], "c"); }`;
    expect(await runHost(src)).toBe(3);
    expect(await runStandaloneHostFree(src)).toBe(3);
  });

  it("push actually appends (x.length was stuck at 2 standalone)", async () => {
    const src = `function f(x: any, y: any): number { x.push(y); return x.length; }
                 export function test(): number { return f(["a", "b"], "c"); }`;
    expect(await runHost(src)).toBe(3);
    expect(await runStandaloneHostFree(src)).toBe(3);
  });

  it("pushed element is readable at its index and equals the pushed string", async () => {
    // Compare INSIDE the compiled function and return an explicit number (1/0) so
    // the result is unambiguous across host mode (raw i32 export) and standalone.
    const src = `function f(x: any, y: any): number { x.push(y); return x[2] === "c" ? 1 : 0; }
                 export function test(): number { return f(["a", "b"], "c"); }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("repeated push accumulates", async () => {
    const src = `function f(x: any): number { x.push("d"); x.push("e"); return x.length; }
                 export function test(): number { return f(["a", "b", "c"]); }`;
    expect(await runHost(src)).toBe(5);
    expect(await runStandaloneHostFree(src)).toBe(5);
  });

  it("pop returns the last element (was undefined standalone)", async () => {
    const src = `function f(x: any): number { return x.pop() === "c" ? 1 : 0; }
                 export function test(): number { return f(["a", "b", "c"]); }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("pop shrinks the array", async () => {
    const src = `function f(x: any): number { x.pop(); return x.length; }
                 export function test(): number { return f(["a", "b", "c"]); }`;
    expect(await runHost(src)).toBe(2);
    expect(await runStandaloneHostFree(src)).toBe(2);
  });

  it("push then pop round-trips the same string value", async () => {
    const src = `function f(x: any): number { x.push("z"); return x.pop() === "z" ? 1 : 0; }
                 export function test(): number { return f(["a", "b"]); }`;
    expect(await runHost(src)).toBe(1);
    expect(await runStandaloneHostFree(src)).toBe(1);
  });

  it("a genuinely-string[]-typed receiver push still works (typed control)", async () => {
    const src = `function f(x: string[]): number { x.push("c"); return x.length; }
                 export function test(): number { return f(["a", "b"]); }`;
    expect(await runHost(src)).toBe(3);
    expect(await runStandaloneHostFree(src)).toBe(3);
  });
});
