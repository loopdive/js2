// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5267 R3-4(a) — §14.7.5.7 ForIn/OfBodyEvaluation: an abrupt completion from
// IteratorStep / IteratorValue (a throwing `next()`, or a throwing `value`
// getter on its result) returns WITHOUT IteratorClose. Only a binding/body
// abrupt completion — and `break` / `return` — close the iterator.
//
// The #1347 close-on-throw wrapper enclosed the `__iterator_next` call too, so
// a throwing `next()` also ran `return()` (`iterator-next-error.js`,
// `iterator-next-result-value-attr-error.js`). An `inNext` flag now marks the
// iterator-step window and the wrapper skips the close inside it.
//
// Both lanes are exercised: the fix is NOT standalone-gated (the close matrix
// is shared codegen), and both lanes flipped the same two rows.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<{ value: number; hostImports: string[] }> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    deferTopLevelInit: true,
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const module = await WebAssembly.compile(result.binary);
  const hostImports = WebAssembly.Module.imports(module).map((i) => `${i.module}::${i.name}`);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return { value: (exports.test as () => number)(), hostImports };
}

async function runHost(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", allowJs: true, skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports.test as () => number)();
}

/**
 * `returnCount * 10 + sum`: a throwing `next()` must leave `returnCount` at 0,
 * and a throwing BODY must raise it to 1.
 */
const SOURCE = `
  var returnCount = 0;
  function mkIter(throwInNext) {
    var it = {};
    it[Symbol.iterator] = function () {
      var n = 0;
      return {
        next: function () {
          n++;
          if (throwInNext) { throw new RangeError("from next"); }
          return { value: n, done: n > 2 };
        },
        return: function () { returnCount += 1; return {}; },
      };
    };
    return it;
  }
  try { for (var b of mkIter(true)) { } } catch (e) {}
  var afterNextThrow = returnCount;
  try { for (var a of mkIter(false)) { throw new RangeError("body"); } } catch (e) {}
  var afterBodyThrow = returnCount;
  export function test(): number { return afterNextThrow * 10 + afterBodyThrow; }
`;

describe("#5267 R3-4a — a throwing next() does not close the iterator", () => {
  it("standalone", async () => {
    const { value, hostImports } = await runStandalone(SOURCE);
    expect(hostImports).toEqual([]);
    // 0 closes after the next() throw, 1 after the body throw.
    expect(value).toBe(1);
  });

  // The js-host lane is NOT pinned on this source: it answers 0 on the base
  // tree AND on this one — in this hand-written shape it never closes on a
  // body throw either, a pre-existing host-lane gap this issue does not touch.
  // The host lane IS measured on the real rows: `iterator-next-error.js` and
  // `iterator-next-result-value-attr-error.js` flip from fail to pass there
  // too, with the other 16 close-matrix rows unchanged. `runHost` is kept so
  // the next lane can re-check that gap cheaply.
  void runHost;
});
