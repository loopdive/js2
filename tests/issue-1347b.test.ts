// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1347b — for-await-of must obtain the async iterator from a WasmGC-closure-valued
// `[Symbol.asyncIterator]`, mirroring the sync for-of path.
//
// The `__async_iterator` host import (src/runtime.ts) previously did
// `asyncIter.call(obj)` unconditionally. When compiled code assigns a closure to
// `obj[Symbol.asyncIterator] = function(){...}`, the stored value is a WasmGC
// closure struct, not a JS function — so `.call` threw
// "asyncIter.call is not a function" before the loop body ever ran. The sync
// `__iterator` path already dispatched WasmGC closures via __call_fn_0; this
// mirrors that into the async path (and its sync-iterator fallback).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function exportsOf(source: string): Promise<Record<string, Function>> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  const imports: any = buildImports(r.imports, undefined, r.stringPool);
  const inst = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(inst.instance.exports);
  return inst.instance.exports as Record<string, Function>;
}

describe("#1347b — for-await-of obtains async iterator from closure-valued Symbol.asyncIterator", () => {
  /**
   * Headline test262 cluster shape (iterator-close-*-get-method-non-callable):
   * a closure assigned to [Symbol.asyncIterator]. Before the fix, the host
   * threw "asyncIter.call is not a function" and the loop body never ran.
   * After the fix, the iterator IS obtained and the loop body runs at least
   * once (the subsequent non-callable `return` close is a separate concern).
   */
  it("loop body executes — closure asyncIterator is invoked, not '.call is not a function'", async () => {
    const exports = await exportsOf(`
      async function test(): Promise<number> {
        let count = 0;
        const asyncIterable: any = {};
        asyncIterable[Symbol.asyncIterator] = function() {
          return {
            next: function() { return { done: count >= 1, value: null }; },
          };
        };
        for await (const x of asyncIterable) { count += 1; }
        return count;
      }
      export { test };
    `);
    // The compiled async fn currently returns a plain number (sync async-model
    // limitation), or a Promise. Either way the key invariant is: it does NOT
    // throw "asyncIter.call is not a function", and the loop body ran (count>=1).
    const res = (exports.test as any)();
    const value = res && typeof res.then === "function" ? await res : res;
    expect(value).toBe(1);
  });

  /**
   * Regression guard: a real async generator (proper async iterator) still
   * iterates correctly — the new closure branch must not shadow the
   * already-working `typeof asyncIter === "function"` path.
   */
  it("async generator still iterates (regression guard)", async () => {
    const exports = await exportsOf(`
      async function* gen() { yield 1; yield 2; yield 3; }
      async function test(): Promise<number> {
        let count = 0;
        for await (const x of gen()) { count += 1; }
        return count;
      }
      export { test };
    `);
    const res = (exports.test as any)();
    const value = res && typeof res.then === "function" ? await res : res;
    expect(value).toBe(3);
  });
});
