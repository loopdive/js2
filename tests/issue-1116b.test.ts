// #1116b — Wasm-class-as-JS-ctor bridge for Promise subclasses.
//
// A `class MyPromise extends Promise` is externref-backed (#1366a/b): its
// instances are real host Promises, but the class *identifier* has no
// class-object singleton, so `Promise.all.call(MyPromise, iter)` used to push
// null/opaque as thisArg and V8 threw "[object Object] is not a constructor".
//
// The fix (src/codegen/expressions/calls.ts `resolvePromiseSubclassThisArg` +
// src/runtime.ts `__promise_subclass_ctor`) resolves the identifier to a
// runtime-synthesized JS subclass of Promise, keyed on class name, so the
// combinator's NewPromiseCapability + @@species resolution succeed.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(src: string): Promise<WebAssembly.Exports> {
  const r = await compile(src);
  if (!r.success) throw new Error("compile failed: " + JSON.stringify(r.errors));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const m = await WebAssembly.instantiate(r.binary, imports);
  const setExports = (imports as unknown as { setExports?: (e: WebAssembly.Exports) => void }).setExports;
  if (typeof setExports === "function") setExports(m.instance.exports);
  return m.instance.exports;
}

describe("#1116b — Promise subclass as combinator thisArg", () => {
  it("Promise.all.call(Subclass, iter) does not throw 'is not a constructor'", async () => {
    const ex = await instantiate(`
      class MyPromise extends Promise<number> {}
      export async function main(): Promise<number> {
        await Promise.all.call(MyPromise, [Promise.resolve(1), Promise.resolve(2)]);
        return 1;
      }
    `);
    const result = await (ex.main as () => Promise<number>)();
    expect(result).toBe(1);
  });

  it("Promise.race.call(Subclass, iter) resolves", async () => {
    const ex = await instantiate(`
      class P extends Promise<number> {}
      export async function main(): Promise<number> {
        await Promise.race.call(P, [Promise.resolve(5), Promise.resolve(9)]);
        return 1;
      }
    `);
    const result = await (ex.main as () => Promise<number>)();
    expect(result).toBe(1);
  });

  it("Promise.allSettled.call(Subclass, mixed) resolves", async () => {
    const ex = await instantiate(`
      class P extends Promise<number> {}
      export async function main(): Promise<number> {
        await Promise.allSettled.call(P, [Promise.resolve(1), Promise.reject(2)]);
        return 1;
      }
    `);
    const result = await (ex.main as () => Promise<number>)();
    expect(result).toBe(1);
  });

  it("Promise.any.call(Subclass, iter) resolves to first-fulfilled", async () => {
    const ex = await instantiate(`
      class P extends Promise<number> {}
      export async function main(): Promise<number> {
        await Promise.any.call(P, [Promise.reject(1), Promise.resolve(2)]);
        return 1;
      }
    `);
    const result = await (ex.main as () => Promise<number>)();
    expect(result).toBe(1);
  });

  it("E1: subclass static Sub.all(iter) resolves without throwing", async () => {
    const ex = await instantiate(`
      class P extends Promise<number> {}
      export async function main(): Promise<number> {
        await P.all([Promise.resolve(1), Promise.resolve(2)]);
        return 1;
      }
    `);
    const result = await (ex.main as () => Promise<number>)();
    expect(result).toBe(1);
  });

  it("regression: plain Promise.all (no subclass) still works", async () => {
    const ex = await instantiate(`
      export async function main(): Promise<number> {
        await Promise.all([Promise.resolve(1)]);
        return 7;
      }
    `);
    const result = await (ex.main as () => Promise<number>)();
    expect(result).toBe(7);
  });

  it("regression: Promise.all.call(undefined, []) still rejects with TypeError", async () => {
    // PR #436 behavior must be preserved — the guard returns false for a
    // non-Promise-subclass thisArg, so the existing TypeError path fires.
    const ex = await instantiate(`
      export async function main(): Promise<number> {
        try {
          await Promise.all.call(undefined as any, [] as Promise<number>[]);
          return 0;
        } catch (e) {
          return 99;
        }
      }
    `);
    const result = await (ex.main as () => Promise<number>)();
    expect(result).toBe(99);
  });
});
