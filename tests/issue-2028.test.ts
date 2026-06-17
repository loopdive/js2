import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2028 — new Promise(executor): the host-provided resolve/reject arrive into
// the executor as plain externref JS functions. Before the fix, calling them
// from wasm dispatched through the closure-struct call_ref path, nulled the
// cast, and trapped on a null deref ("dereferencing a null pointer"). The fix
// routes a Promise-executor resolve/reject param through __call_function.
//
// JS-host mode only (the __call_function arm is gated !standalone && !wasi).

async function instantiate(src: string): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const result = await compile(src);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  if (imports.setExports) imports.setExports(exports as Record<string, Function>);
  return exports;
}

describe("#2028 — new Promise(executor) host resolve/reject dispatch", () => {
  it("synchronous resolve(value) settles the promise to that value", async () => {
    const ex = await instantiate(`
      export function f(): any {
        return new Promise<string>((resolve) => { resolve("ok"); });
      }
    `);
    await expect(ex.f() as Promise<unknown>).resolves.toBe("ok");
  });

  it("synchronous reject(reason) rejects the promise with that reason", async () => {
    const ex = await instantiate(`
      export function f(): any {
        return new Promise<number>((_resolve, reject) => { reject(new Error("nope")); });
      }
    `);
    await expect(ex.f() as Promise<unknown>).rejects.toThrow("nope");
  });

  it("resolve-twice: first settlement wins (host [[AlreadyResolved]])", async () => {
    const ex = await instantiate(`
      export function f(): any {
        return new Promise<number>((resolve) => { resolve(1); resolve(2); });
      }
    `);
    await expect(ex.f() as Promise<unknown>).resolves.toBe(1);
  });

  it("resolve then await chains a derived value", async () => {
    const ex = await instantiate(`
      export async function f(): Promise<number> {
        const p = new Promise<number>((resolve) => { resolve(41); });
        const v = await p;
        return v + 1;
      }
    `);
    await expect(ex.f() as Promise<unknown>).resolves.toBe(42);
  });

  it("#1941 dual-mode guard: a pure local-closure callable param does NOT pull host imports", async () => {
    // `cb` is an ordinary callable parameter — lowered as externref but the
    // closure struct is recovered dynamically at the call site. It must keep the
    // closure-struct call_ref path and NOT pull __call_function/__js_array_new.
    const result = await compile(`
      function apply(cb: (x: number) => number, v: number): number { return cb(v); }
      export function f(): number { return apply((x) => x + 1, 10); }
    `);
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    expect(wat).not.toMatch(/import "env" "__call_function"/);
    expect(wat).not.toMatch(/import "env" "__js_array_new"/);
  });
});
