// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1665 — generator / iterator bridge slice.
 *
 * Full Wasm-native generator state machines remain the long-term standalone
 * track. This slice fixes the host-mode prototype bridge that issue #1665
 * identified as the shared design point: compiled generators keep their own
 * `%IteratorPrototype%` identity, but helper methods resolve through the
 * helper-bearing `Iterator.prototype` surface.
 */
import { describe, expect, it } from "vitest";

import { HOST_IMPORT_ALLOWLIST } from "../src/codegen/host-import-allowlist.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

async function makeCompiledGenerator(): Promise<IterableIterator<number>> {
  const exports = await compileAndInstantiate(`
    export function make(): any {
      function* gen() {
        yield 1;
        yield 2;
      }
      return gen();
    }
  `);
  return (exports.make as () => IterableIterator<number>)();
}

describe("#1665 generator iterator bridge", () => {
  // (#6979 S7-f / #7259) An exported generator's next() result reaches JS with
  // no value/done since #7010 retired the eager buffer; fails identically on main.
  it.fails("compiled generators resolve Iterator.prototype helpers", async () => {
    const iter = await makeCompiledGenerator();

    expect(typeof (iter as any).map).toBe("function");
    expect((iter as any).map((x: number) => x * 2).toArray()).toEqual([2, 4]);
  });

  // (#6979 S7-f / #7259) An exported generator's next() result reaches JS with
  // no value/done since #7010 retired the eager buffer; fails identically on main.
  it.fails("preserves the compiler-owned %IteratorPrototype% object while linking helpers above it", async () => {
    const iter = await makeCompiledGenerator();
    const generatorFunctionPrototype = Object.getPrototypeOf(iter);
    const generatorPrototype = Object.getPrototypeOf(generatorFunctionPrototype);
    const compilerIteratorPrototype = Object.getPrototypeOf(generatorPrototype);

    expect(Object.prototype.hasOwnProperty.call(compilerIteratorPrototype, Symbol.iterator)).toBe(true);
    expect(compilerIteratorPrototype[Symbol.iterator].call(iter)).toBe(iter);

    const hostIterator = (globalThis as any).Iterator;
    if (typeof hostIterator === "function" && hostIterator.prototype !== compilerIteratorPrototype) {
      expect(Object.getPrototypeOf(compilerIteratorPrototype)).toBe(hostIterator.prototype);
    } else {
      expect(typeof compilerIteratorPrototype.map).toBe("function");
      expect(hostIterator?.prototype).toBe(compilerIteratorPrototype);
    }
  });

  it("tracks generator host-scheduler imports under #1665, not the stale #1376 IR gate", () => {
    const generatorEntries = HOST_IMPORT_ALLOWLIST.filter(
      (entry) =>
        entry.name === "__gen_" || entry.name === "__create_generator" || entry.name === "__create_async_generator",
    );

    expect(generatorEntries.map((entry) => [entry.name, entry.trackingIssue])).toEqual([
      ["__gen_", 1665],
      ["__create_generator", 1665],
      ["__create_async_generator", 1665],
    ]);
  });
});
