import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// #1320 — Array.from(obj) where obj is a plain JS object whose own
// [Symbol.iterator] compiles to a Wasm closure struct (typeof "object", not a
// JS function). Native Array.from rejects such an object with
// "items[Symbol.iterator] … must be a function"; the runtime bridge must drive
// the closure-backed iterator protocol manually instead.
async function run(src: string, fn = "test"): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("CE: " + (r.errors?.[0]?.message ?? "unknown"));
  const imports = buildImports(r.imports, undefined, r.stringPool) as never as {
    env: Record<string, Function>;
    setExports?: (e: Record<string, Function>) => void;
  } & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>)[fn]?.();
}

describe("#1320 Array.from over a closure-backed @@iterator", () => {
  it("does not throw 'iterator is not a function' for an empty closure iterator", async () => {
    const src = `
      var items: any = {};
      items[Symbol.iterator] = function() {
        return { next: function() { return { done: true, value: undefined }; } };
      };
      export function test(): number { return Array.from(items).length; }
    `;
    // Empty iterator → zero-length array, and crucially no TypeError thrown.
    await expect(run(src)).resolves.toBe(0);
  });

  it("invokes the closure @@iterator exactly once (callCount observable)", async () => {
    const src = `
      var callCount = 0;
      var items: any = {};
      items[Symbol.iterator] = function() {
        callCount++;
        return { next: function() { return { done: true, value: undefined }; } };
      };
      export function test(): number {
        Array.from(items);
        return callCount;
      }
    `;
    await expect(run(src)).resolves.toBe(1);
  });

  it("drains closure iterables before Array.from.call constructs the result", async () => {
    const src = `
      let thisVal: any;
      let args: any;
      let result: any;
      export function test(): number {
        var callCount = 0;
        var C = function() {
          thisVal = this;
          args = arguments;
          callCount += 1;
        };
        var items = {};
        items[Symbol.iterator] = function() {
          return { next: function() { return { done: true }; } };
        };
        result = Array.from.call(C, items);
        return (result instanceof C ? 1000 : 0)
          + (result.constructor === C ? 100 : 0)
          + (thisVal === result ? 10 : 0)
          + (args.length === 0 ? 1 : 0)
          + callCount;
      }
    `;
    await expect(run(src)).resolves.toBe(1112);
  });

  it("reads iterator result objects returned through closure-captured variables", async () => {
    const src = `
      var items: any = {};
      var nextIterResult: any;
      var lastIterResult: any;
      items[Symbol.iterator] = function() {
        return {
          next: function() {
            var result = nextIterResult;
            nextIterResult = lastIterResult;
            return result;
          }
        };
      };
      export function test(): number {
        nextIterResult = { done: false };
        lastIterResult = { done: true };
        return Array.from(items).length;
      }
    `;
    await expect(run(src)).resolves.toBe(1);
  });

  it("preserves this for prototype-installed primitive iterators used by Array.from", async () => {
    const original = (Number.prototype as any)[Symbol.iterator];
    const src = `
      export function test(): number {
        Number.prototype[Symbol.iterator] = function* () {
          let i = 0;
          let target = this >>> 0;
          while (i < target) {
            yield i;
            ++i;
          }
        };
        return Array.from(5).length;
      }
    `;
    try {
      await expect(run(src)).resolves.toBe(5);
    } finally {
      if (original === undefined) delete (Number.prototype as any)[Symbol.iterator];
      else (Number.prototype as any)[Symbol.iterator] = original;
    }
  });

  it("Iterator.from rejects non-string primitives but accepts boxed primitive iterables", async () => {
    const original = (Number.prototype as any)[Symbol.iterator];
    const src = `
      function* g() {
        yield 0;
      }
      export function test(): number {
        Number.prototype[Symbol.iterator] = function* () {
          let i = 0;
          let target = this >>> 0;
          while (i < target) {
            yield i;
            ++i;
          }
        };
        var primitiveThrows = 0;
        try {
          Iterator.from(5);
        } catch (e) {
          primitiveThrows = 1;
        }
        var flatMapThrows = 0;
        try {
          for (let unused of g().flatMap(v => 5)) {}
        } catch (e) {
          flatMapThrows = 1;
        }
        return primitiveThrows * 100
          + flatMapThrows * 10
          + Array.from(Iterator.from(new Number(5))).length;
      }
    `;
    try {
      await expect(run(src)).resolves.toBe(115);
    } finally {
      if (original === undefined) delete (Number.prototype as any)[Symbol.iterator];
      else (Number.prototype as any)[Symbol.iterator] = original;
    }
  });
});
