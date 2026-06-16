import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2028 — `new Promise(executor)`: the `resolve`/`reject` parameters arrive as
// real host functions when native `new Promise` invokes the compiled executor
// body. Before the fix, the in-body call `resolve("ok")` was dispatched through
// the closure-struct `ref.test`/`ref.cast`/`struct.get`/`call_ref` path, which
// fails on a foreign callable (the cast nulls, then `struct.get` traps
// "dereferencing a null pointer"), so the promise rejected with a RuntimeError
// instead of fulfilling. The fix (calls.ts `calleeIsPromiseExecutorParam`)
// routes executor-param calls through the `__call_function` host arm.

async function instantiate(src: string): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const result = await compile(src);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  if (imports.setExports) imports.setExports(exports as Record<string, Function>);
  return exports;
}

describe("#2028 — Promise executor resolve/reject dispatch", () => {
  it("sync resolve fulfils the promise (§27.2.3.1)", async () => {
    const ex = await instantiate(
      `export function f(): any { return new Promise<string>((resolve) => { resolve("ok"); }); }`,
    );
    await expect(ex.f() as Promise<unknown>).resolves.toBe("ok");
  });

  it("sync reject rejects with the reason", async () => {
    const ex = await instantiate(
      `export function f(): any { return new Promise((_resolve, reject) => { reject(new Error("boom")); }); }`,
    );
    await expect(ex.f() as Promise<unknown>).rejects.toThrow("boom");
  });

  it("resolve-twice: first call wins, second is ignored ([[AlreadyResolved]] §27.2.1.3)", async () => {
    const ex = await instantiate(
      `export function f(): any { return new Promise<number>((resolve) => { resolve(1); resolve(2); }); }`,
    );
    await expect(ex.f() as Promise<unknown>).resolves.toBe(1);
  });

  it("resolve with a number value fulfils to that number", async () => {
    const ex = await instantiate(`export function f(): any { return new Promise<number>((resolve) => { resolve(42); }); }`);
    await expect(ex.f() as Promise<unknown>).resolves.toBe(42);
  });

  it("a .then chained off the resolved promise observes the value", async () => {
    const ex = await instantiate(
      `export function f(): any {
         const p = new Promise<number>((resolve) => { resolve(10); });
         return p.then((v: number) => v + 1);
       }`,
    );
    await expect(ex.f() as Promise<unknown>).resolves.toBe(11);
  });

  it("#1941 dual-mode guard: a pure local-closure callback param does NOT pull host imports", async () => {
    // `apply`'s `cb` param also lowers to an externref local, but it receives a
    // wasm closure at the call site (so `ref.test $closure` succeeds and the fast
    // `call_ref` path runs). The #2028 fix is scoped to Promise-executor params,
    // so this case must stay free of `__call_function` / `__js_array_new`.
    const result = await compile(
      `function apply(cb: (x: number) => number, v: number): number { return cb(v); }
       export function main(): number { return apply((x) => x + 1, 10); }`,
    );
    expect(result.success).toBe(true);
    expect(result.wat?.includes("__call_function")).toBe(false);
    expect(result.wat?.includes("__js_array_new")).toBe(false);
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    const exports = instance.exports as Record<string, () => number>;
    if (imports.setExports) imports.setExports(exports as Record<string, Function>);
    expect(exports.main()).toBe(11);
  });
});
