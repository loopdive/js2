// (#1116) Promise aggregator (all/race/allSettled/any) — Promise.X.call(non-object, …)
// must throw TypeError per ECMA-262 §27.2.4.X step 2 ("If Type(C) is not Object,
// throw a TypeError exception"). Previously our runtime defaulted thisArg=null/
// undefined to globalThis.Promise, masking this spec-mandated throw.
//
// The fix routes a `directCall` flag from codegen → runtime:
//   - `Promise.all(iter)` (bare)      → directCall=1, runtime uses Promise
//   - `Promise.all.call(C, iter)`     → directCall=0, runtime forwards C to V8
//
// Bare `Promise.all(...)` behavior is unchanged; the `.call(…)` family now
// produces a spec-compliant TypeError for non-Object thisArg.
//
// Test262 coverage:
//   test/built-ins/Promise/all/ctx-non-object.js
//   test/built-ins/Promise/race/ctx-non-object.js
//   test/built-ins/Promise/allSettled/ctx-non-object.js
//   test/built-ins/Promise/any/ctx-non-object.js

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(src: string): Promise<{ result: any; errors: string[]; compileOk: boolean }> {
  const r = await compile(src, { fileName: "test.ts" });
  const errors = r.errors.map((e) => `L${e.line}: ${e.message}`);
  if (!r.success) return { result: undefined, errors, compileOk: false };
  try {
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const v = (instance.exports as any).test();
    // Unwrap promise if a Promise was returned by test().
    const awaited = v && typeof v.then === "function" ? await v : v;
    return { result: awaited, errors, compileOk: true };
  } catch (e: any) {
    return { result: "IE:" + (e?.message?.slice(0, 200) ?? String(e)), errors, compileOk: true };
  }
}

describe("#1116 -- Promise.X.call(non-object) throws TypeError", () => {
  it("Promise.all.call(undefined, []) throws TypeError", async () => {
    const { result } = await compileAndRun(`
      let threw = "no-throw";
      try {
        Promise.all.call(undefined, []);
      } catch (e: any) {
        threw = (e && e.name) || String(e);
      }
      export function test(): string { return threw; }
    `);
    expect(result).toContain("TypeError");
  });

  it("Promise.all.call(null, []) throws TypeError", async () => {
    const { result } = await compileAndRun(`
      let threw = "no-throw";
      try {
        Promise.all.call(null, []);
      } catch (e: any) {
        threw = (e && e.name) || String(e);
      }
      export function test(): string { return threw; }
    `);
    expect(result).toContain("TypeError");
  });

  it("Promise.all.call(86, []) throws TypeError", async () => {
    const { result } = await compileAndRun(`
      let threw = "no-throw";
      try {
        Promise.all.call(86, []);
      } catch (e: any) {
        threw = (e && e.name) || String(e);
      }
      export function test(): string { return threw; }
    `);
    expect(result).toContain("TypeError");
  });

  it("Promise.race.call(undefined, []) throws TypeError", async () => {
    const { result } = await compileAndRun(`
      let threw = "no-throw";
      try {
        Promise.race.call(undefined, []);
      } catch (e: any) {
        threw = (e && e.name) || String(e);
      }
      export function test(): string { return threw; }
    `);
    expect(result).toContain("TypeError");
  });

  it("Promise.allSettled.call(null, []) throws TypeError", async () => {
    const { result } = await compileAndRun(`
      let threw = "no-throw";
      try {
        Promise.allSettled.call(null, []);
      } catch (e: any) {
        threw = (e && e.name) || String(e);
      }
      export function test(): string { return threw; }
    `);
    expect(result).toContain("TypeError");
  });

  it("Promise.any.call(undefined, []) throws TypeError", async () => {
    const { result } = await compileAndRun(`
      let threw = "no-throw";
      try {
        Promise.any.call(undefined, []);
      } catch (e: any) {
        threw = (e && e.name) || String(e);
      }
      export function test(): string { return threw; }
    `);
    expect(result).toContain("TypeError");
  });

  // Negative control — bare `Promise.X(iter)` must NOT throw (directCall=1 keeps
  // the implicit-Promise behavior). We just verify the call site doesn't raise.
  it("Promise.all([…]) does NOT throw on bare call (directCall=1 path)", async () => {
    const { result } = await compileAndRun(`
      let threw = "no-throw";
      try {
        Promise.all([Promise.resolve(1), Promise.resolve(2)]);
      } catch (e: any) {
        threw = (e && e.name) || String(e);
      }
      export function test(): string { return threw; }
    `);
    expect(result).toBe("no-throw");
  });

  it("Promise.race([…]) does NOT throw on bare call (directCall=1 path)", async () => {
    const { result } = await compileAndRun(`
      let threw = "no-throw";
      try {
        Promise.race([Promise.resolve(7), Promise.resolve(42)]);
      } catch (e: any) {
        threw = (e && e.name) || String(e);
      }
      export function test(): string { return threw; }
    `);
    expect(result).toBe("no-throw");
  });
});
