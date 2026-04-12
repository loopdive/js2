/**
 * Issue #862 — Empty error message failures: iterator/destructuring step-err tests
 *
 * Root cause: array destructuring of externref values used indexed access
 * (__extern_get) instead of the iterator protocol. Generators and custom
 * iterators passed to destructuring patterns never had .next() called,
 * so thrown errors didn't propagate.
 *
 * Fix: add __extern_to_array host import that converts iterables via
 * Array.from() before indexed access. Iterator .next() throws propagate
 * naturally as catchable JS exceptions.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { readFileSync } from "fs";
import { parseMeta, wrapTest } from "./test262-runner.ts";
import { buildImports } from "../src/runtime.ts";

async function runTest262File(path: string): Promise<{ pass: boolean; error?: string }> {
  const resolved = path.startsWith("/") ? path : `/workspace/${path}`;
  const src = readFileSync(resolved, "utf-8");
  const meta = parseMeta(src);
  const { source } = wrapTest(src, meta);
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    return { pass: false, error: `CE: ${r.errors[0]?.message}` };
  }
  try {
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const ret = (instance.exports as any).test();
    return { pass: ret === 1, error: ret !== 1 ? `returned ${ret}` : undefined };
  } catch (e: any) {
    return { pass: false, error: e.message };
  }
}

function compileAndRun(source: string): { success: boolean; result?: number; error?: string } {
  const compiled = compile(source, { fileName: "test.ts" });
  if (!compiled.success) return { success: false, error: compiled.errors[0]?.message };
  try {
    const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
    const mod = new WebAssembly.Module(compiled.binary);
    const inst = new WebAssembly.Instance(mod, imports);
    const ret = (inst.exports as any).test();
    return { success: true, result: ret };
  } catch (e: any) {
    return { success: false, error: `${e.constructor.name}: ${e.message}` };
  }
}

describe("Issue #862: iterator/destructuring step-err", () => {
  it("ary-ptrn-elision-step-err (generator throws on .next() during elision)", async () => {
    // Debug: show what wrapTest produces
    const src = readFileSync(
      `/workspace/test262/test/language/expressions/arrow-function/dstr/ary-ptrn-elision-step-err.js`,
      "utf-8",
    );
    const meta = parseMeta(src);
    const { source } = wrapTest(src, meta);
    console.log("=== WRAPPED SOURCE ===");
    console.log(source);
    console.log("=== END ===");
    const result = await runTest262File(
      "test262/test/language/expressions/arrow-function/dstr/ary-ptrn-elision-step-err.js",
    );
    expect(result.pass, `error=${result.error}`).toBe(true);
  });

  it("ary-ptrn-rest-id-iter-step-err (generator throws on .next() during rest)", async () => {
    const result = await runTest262File(
      "test262/test/language/expressions/arrow-function/dstr/ary-ptrn-rest-id-iter-step-err.js",
    );
    expect(result.pass, result.error).toBe(true);
  });

  it("dflt-ary-ptrn-elision-step-err (default + elision step error)", async () => {
    const result = await runTest262File(
      "test262/test/language/expressions/arrow-function/dstr/dflt-ary-ptrn-elision-step-err.js",
    );
    console.log("dflt result:", result);
    expect(result.pass, `error=${result.error}`).toBe(true);
  });

  it("generator throw deferred to .next() is catchable", () => {
    const r = compileAndRun(`
      export function test(): number {
        function* gen(): Generator<number> { throw new Error("boom"); }
        const iter = gen();
        let caught = 0;
        try { iter.next(); } catch (e) { caught = 1; }
        return caught;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("normal generator still works after fix", () => {
    const r = compileAndRun(`
      export function test(): number {
        function* gen(): Generator<number> { yield 42; yield 99; }
        const iter = gen();
        const v1 = iter.next();
        const v2 = iter.next();
        const v3 = iter.next();
        return 1;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("exact test262 pattern without type annotations", () => {
    // The exact same pattern from the test262 test, but without `: any`
    const r = compileAndRun(`
      class Test262Error { message: string; constructor(msg: string) { this.message = msg; } }
      function assert_throws_inner(fn: () => void): number {
        try { fn(); } catch (e) { return 1; }
        return 0;
      }
      export function test(): number {
        var following = 0;
        var iter = function* () { throw new Test262Error(""); following += 1; }();
        var f = ([,]) => {};
        const caught = assert_throws_inner(function() { f(iter); });
        if (!caught) return 0;
        iter.next();
        return following === 0 ? 1 : 0;
      }
    `);
    if (!r.success) {
      expect.fail(`CE: ${r.error}`);
    }
    expect(r.result, `result=${r.result} error=${r.error}`).toBe(1);
  });

  it("debug: check compile output for generator destructuring", () => {
    const compiled = compile(
      `
      export function test(): number {
        var iter = function* () { yield 1; }();
        var f = ([x]) => { return x; };
        f(iter);
        return 1;
      }
    `,
      { fileName: "test.ts" },
    );
    expect(compiled.success, compiled.errors?.[0]?.message).toBe(true);
    const imports = compiled.imports;
    // Check what imports were generated
    const importNames = imports.map((i: any) => `${i.module}.${i.name}`);
    console.log("All env imports:", importNames);
    expect(importNames, "should have __extern_to_array for iterator conversion").toContain("env.__extern_to_array");

    // Validate the Wasm binary
    expect(WebAssembly.validate(compiled.binary), "Wasm validation failed").toBe(true);
  });

  it("debug: extern.convert_any on generator struct", () => {
    // Test that extern.convert_any works on a generator struct
    const r = compileAndRun(`
      export function test(): number {
        var iter = function* () { yield 1; }();
        // Just test that iter exists without destructuring
        return iter ? 1 : 0;
      }
    `);
    if (!r.success) {
      expect.fail(`CE: ${r.error}`);
    }
    expect(r.result).toBe(1);
  });

  it("debug: generator destructuring with [x] no type annotation", () => {
    const compiled = compile(
      `
      export function test(): number {
        var iter = function* () { yield 1; }();
        var f = ([x]) => { return x; };
        f(iter);
        return 1;
      }
    `,
      { fileName: "test.ts" },
    );
    if (!compiled.success) {
      expect.fail(`CE: ${compiled.errors?.map((e: any) => e.message).join("; ")}`);
      return;
    }
    const valid = WebAssembly.validate(compiled.binary);
    expect(valid, "WebAssembly.validate failed").toBe(true);
    const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
    const mod = new WebAssembly.Module(compiled.binary);
    const inst = new WebAssembly.Instance(mod, imports);
    try {
      const ret = (inst.exports as any).test();
      expect(ret).toBe(1);
    } catch (e: any) {
      // Dump the .wat file for debugging
      const { writeFileSync } = require("fs");
      writeFileSync("/tmp/debug-862.wasm", compiled.binary);
      expect.fail(`Runtime error: ${e.constructor.name}: ${e.message}`);
    }
  });

  it("generator passed to arrow with elision destructuring throws (direct try/catch)", () => {
    const r = compileAndRun(`
      export function test(): number {
        const iter = (function* () { throw new Error("step-err"); })();
        const f = ([,]: any) => {};
        let caught = 0;
        try { f(iter); } catch (e) { caught = 1; }
        return caught;
      }
    `);
    expect(r.success, r.error).toBe(true);
    expect(r.result).toBe(1);
  });

  it("generator passed to arrow with binding destructuring throws", () => {
    const r = compileAndRun(`
      export function test(): number {
        const iter = (function* () { throw new Error("step-err"); })();
        const f = ([x]: any) => {};
        let caught = 0;
        try { f(iter); } catch (e) { caught = 1; }
        return caught;
      }
    `);
    expect(r.success, r.error).toBe(true);
    expect(r.result).toBe(1);
  });

  it("array destructuring of regular array still works", () => {
    const r = compileAndRun(`
      export function test(): number {
        const arr = [10, 20, 30];
        const [a, b, c] = arr;
        return a === 10 && b === 20 && c === 30 ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });
});
