// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

describe("strict unresolved array assignment iterator ordering", () => {
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "js-host";
    for (const file of [
      "array-elem-iter-thrw-close-skip.js",
      "array-elem-put-unresolvable-strict.js",
      "array-elem-iter-nrml-close-skip.js",
    ]) {
      it(`${lane}: original ${file}`, async () => {
        const result = await runTest262File(
          resolve("test262/test/language/expressions/assignment/dstr", file),
          "language",
          30_000,
          target,
        );
        expect(result.status, JSON.stringify(result)).toBe("pass");
      }, 60_000);
    }

    for (const done of [false, true]) {
      for (const closeThrows of [false, true]) {
        it(`${lane}: closes only unfinished iterators and preserves ReferenceError (done=${done}, closeThrows=${closeThrows})`, async () => {
          const result = await compile(
            `
          export function test(): number {
            "use strict";
            var nextCount = 0;
            var returnCount = 0;
            var iterable = {};
            iterable[Symbol.iterator] = function() {
              return {
                next: function() { nextCount += 1; return { done: ${done}, value: 1 }; },
                return: function() { returnCount += 1; ${closeThrows ? 'throw new TypeError("close");' : "return {};"} }
              };
            };
            var caught = 0;
            try { [unresolvable] = iterable; }
            catch (error) { if (error instanceof ReferenceError) caught = 1; }
            return 100 * caught + 10 * nextCount + returnCount;
          }
        `,
            { fileName: "iterator-order.ts", inferModuleStrictArguments: false, ...(target ? { target } : {}) },
          );
          expect(result.success, JSON.stringify(result.errors)).toBe(true);
          const imports = target ? {} : buildImports(result.imports, undefined, result.stringPool);
          if (target) expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
          const { instance } = await WebAssembly.instantiate(result.binary, imports);
          (imports as { setInstance?: (instance: WebAssembly.Instance) => void }).setInstance?.(instance);
          expect((instance.exports as { test(): number }).test()).toBe(done ? 110 : 111);
        }, 60_000);
      }
    }
  }
});
