import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("Promise.all / Promise.race", () => {
  it("Promise.all with resolved values", async () => {
    // Use Promise<any> return type so the unwrapped type is 'any' → externref
    const result = await compile(`
      declare namespace Host {
        class Source {
          constructor();
          getPromises(): Promise<number>[];
        }
      }
      export async function runAll(): Promise<any> {
        const src = new Host.Source();
        return await Promise.all(src.getPromises());
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);

    class MockSource {
      getPromises() {
        return [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)];
      }
    }
    const imports = buildImports(result.imports, { Source: MockSource }, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    const exports = instance.exports as any;
    // The Wasm function returns an externref (the Promise from Promise.all);
    // await from JS resolves it
    const out = await exports.runAll();
    expect(out).toEqual([1, 2, 3]);
  });

  it("Promise.race with resolved values", async () => {
    const result = await compile(`
      declare namespace Host {
        class Source {
          constructor();
          getPromises(): Promise<number>[];
        }
      }
      export async function runRace(): Promise<any> {
        const src = new Host.Source();
        return await Promise.race(src.getPromises());
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);

    class MockSource {
      getPromises() {
        return [Promise.resolve(10), Promise.resolve(20), Promise.resolve(30)];
      }
    }
    const imports = buildImports(result.imports, { Source: MockSource }, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    const exports = instance.exports as any;
    const out = await exports.runRace();
    expect(out).toBe(10);
  });

  it("Promise.all compiles correctly (compilation check)", async () => {
    const result = await compile(`
      declare function getArr(): Promise<number>[];
      export async function allNums(): Promise<any> {
        const a = getArr();
        return await Promise.all(a);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
    expect(result.wat).toContain("Promise_all");
  });

  it("Promise.race compiles correctly (compilation check)", async () => {
    const result = await compile(`
      declare function getArr(): Promise<number>[];
      export async function raceNums(): Promise<any> {
        const a = getArr();
        return await Promise.race(a);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
    expect(result.wat).toContain("Promise_race");
  });
});

// (#1694 A.i / #1632b-1) A COMPILED FUNCTION used as the capability constructor
// `this` of a combinator — `Promise.all.call(NotPromise, …)` where `NotPromise`
// is an ordinary `function` lowered to a Wasm closure struct. Spec
// §27.2.4.1 step 6 → NewPromiseCapability(C) → Construct(C, «executor»). Before
// the fix, the host wrapped the closure as a non-constructible proxy and V8
// threw "… is not a constructor". `_wrapCallableForHost` now makes it
// constructible (ordinary [[Construct]]), so the closure body runs.
describe("Promise combinators — compiled-fn capability constructor (#1694 A.i)", () => {
  // Instantiate + wire setExports so the host's __is_closure / __call_fn_*
  // dispatchers are live (raw WebAssembly.instantiate alone leaves them unset).
  async function instantiateWired(binary: Uint8Array, imports: any) {
    const mod = await WebAssembly.compile(binary);
    const inst = await WebAssembly.instantiate(mod, imports as WebAssembly.Imports);
    if (imports.setExports) imports.setExports(inst.exports);
    return inst.exports as any;
  }

  it("invokes a compiled function passed as the capability constructor", async () => {
    const result = await compile(`
      let ran = 0;
      function Cap(executor: any): void {
        ran = ran + 1;
        executor(function (v: any) {}, function (e: any) {});
      }
      export async function go(): Promise<number> {
        try { Promise.all.call(Cap as any, []); } catch (e) {}
        return ran;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);
    const imports = buildImports(result.imports, {}, result.stringPool);
    const exports = await instantiateWired(result.binary, imports);
    // Construct(Cap, «executor») must have run the compiled body → ran === 1.
    expect(await exports.go()).toBe(1);
  });

  it("still throws TypeError for a primitive capability this (ctx-non-object)", async () => {
    const result = await compile(`
      export async function go(): Promise<number> {
        try { Promise.all.call(5 as any, []); return 0; }
        catch (e) { return 1; }
      }
    `);
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports, {}, result.stringPool);
    const exports = await instantiateWired(result.binary, imports);
    // A non-object capability stays non-constructible → spec step-2 TypeError.
    expect(await exports.go()).toBe(1);
  });

  it("still throws TypeError for a plain-object capability this (ctx-non-ctor)", async () => {
    const result = await compile(`
      export async function go(): Promise<number> {
        try { Promise.all.call({} as any, []); return 0; }
        catch (e) { return 1; }
      }
    `);
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports, {}, result.stringPool);
    const exports = await instantiateWired(result.binary, imports);
    // A non-closure struct is not callable-wrapped → NewPromiseCapability throws.
    expect(await exports.go()).toBe(1);
  });

  it("class X extends Promise still resolves through X.all (B / A.ii unbroken)", async () => {
    const result = await compile(`
      class X extends Promise {}
      export async function go(): Promise<number> {
        const r = await X.all([]);
        return Array.isArray(r) ? 7 : -1;
      }
    `);
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports, {}, result.stringPool);
    const exports = await instantiateWired(result.binary, imports);
    expect(await exports.go()).toBe(7);
  });
});
