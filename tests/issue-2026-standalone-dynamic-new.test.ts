// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2026 (PR-1b) — `new K()` where `K` is a value-bound class identifier, in
 * the no-JS-host targets (`--target wasi` / `standalone`).
 *
 * PR-1 wired the dynamic-new uniform constructor ABI for the JS-host arm: the
 * value bound to `K` is the `__class_<Name>` class-object singleton (the same
 * `$ClassName` struct as instances, carrying the class id in field 0 `__tag`),
 * and `emitDynamicNewFallback` reads that tag and dispatches — pure Wasm, no
 * host import — to the matching `<Class>_new`. PR-1 left two no-JS-host gaps
 * that crashed the *standalone* compile of the very same source:
 *
 *   1. `collectUnknownConstructorImports` registered an `env.__new_<name>` host
 *      import for the value-bound callee. The strict-import allowlist gate
 *      rejected it at registration time, so a single `new K()` failed the whole
 *      standalone compile ("Host import env.__new_K …"). The import is never
 *      satisfiable with no JS host and the pure-Wasm fallback is the resolution
 *      path, so PR-1b skips registering it in no-JS-host mode.
 *   2. `__register_class_object` (a JS-host Proxy own-key notification) was
 *      registered under `--target wasi` (the skip guard only covered
 *      `standalone`). `emitLazyClassObjectGet` then took its CSV-notify branch
 *      and `global.get`'d the static-methods-CSV *string* global, which under
 *      nativeStrings is not a real module global — baking a `-1` global index
 *      and crashing binary emit the moment a class flowed as a value. PR-1b
 *      extends the skip to both no-JS-host targets.
 *
 * These tests compile with `--target wasi`, assert ZERO `env` host imports
 * (genuine standalone — instantiates with an empty import object), and check
 * the dynamic-new dispatch is value-correct.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, exportName = "test"): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const envImports = WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  expect(envImports, `expected no env host imports, got: ${envImports.join(", ")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exp = instance.exports as Record<string, () => unknown>;
  return exp[exportName]!();
}

describe("#2026 PR-1b: standalone dynamic new on a value-bound class", () => {
  it("repro: new K() through a parameter constructs the class (→ 6), pure Wasm", async () => {
    const src = `
const C = class { v: number = 3; m(): number { return this.v * 2; } };
function make(K: any): any { return new K(); }
export function test(): number { return make(C).m(); }
`;
    expect(await runStandalone(src)).toBe(6);
  });

  it("threads constructor arguments through the dynamic path", async () => {
    const src = `
class A { x: number; constructor(a: number) { this.x = a; } getX(): number { return this.x; } }
function mk(K: any, n: number): any { return new K(n); }
export function test(): number { return mk(A, 5).getX(); }
`;
    expect(await runStandalone(src)).toBe(5);
  });

  it("dispatches by class TAG among shape-colliding classes", async () => {
    // A {x:number} and B {y:number} canonicalize to the same WasmGC struct
    // shape — dispatch must key on the class tag, not the struct type.
    const src = `
class A { x: number; constructor(a: number) { this.x = a; } getX(): number { return this.x; } }
class B { y: number; constructor(b: number) { this.y = b * 10; } getY(): number { return this.y; } }
function mk(K: any, n: number): any { return new K(n); }
export function test(): number {
  const a: any = mk(A, 2);
  const b: any = mk(B, 3);
  return a.getX() + b.getY();
}
`;
    expect(await runStandalone(src)).toBe(32);
  });

  it("constructs an empty class (no explicit constructor) dynamically", async () => {
    const src = `
class P { n: number = 7; get(): number { return this.n; } }
function make(K: any): any { return new K(); }
export function test(): number { return make(P).get(); }
`;
    expect(await runStandalone(src)).toBe(7);
  });

  it("regression guard: a class flowing as a plain value compiles standalone", async () => {
    // The class-object descriptor read (the #2026 PR-1b root cause: a -1 global
    // index from the wasi __register_class_object CSV branch) must not fire even
    // when the class is only *passed*, never `new`'d dynamically.
    const src = `
class A { x: number = 3; }
function use(K: any): number { return 1; }
export function test(): number { return use(A); }
`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("regression guard: static new C() still works alongside the dynamic path", async () => {
    const src = `
class C { v: number; constructor(v: number) { this.v = v; } get(): number { return this.v; } }
function make(K: any): any { return new K(42); }
export function test(): number {
  const direct = new C(10).get();      // static path — typed instance
  const dyn = make(C).get();           // dynamic path — externref instance
  return direct + dyn;                 // 10 + 42
}
`;
    expect(await runStandalone(src)).toBe(52);
  });
});
