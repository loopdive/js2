// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5267 R3-6 — `for (… of <array>)` must honour
// `delete Array.prototype[Symbol.iterator]`.
//
// §7.4.2 GetIterator reads `Array.prototype[Symbol.iterator]` after evaluating
// the receiver; with the method deleted that read is undefined and the loop
// throws a TypeError. The array fast path walks the vec directly, so it never
// consulted the deletion flag the pre-scan already raises (#5139 wired it into
// binding patterns only) and the loop ran normally.
//
// The guard emits zero bytes in a module without such a delete — the flag
// global is only rooted by the pre-scan that sees one — so this file also
// carries the negative case.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * `--target standalone`, the lane this guard is gated on. `deferTopLevelInit`
 * mirrors the test262 runner so top-level statements run from the exported
 * `__module_init` rather than from `(start)`.
 */
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

describe("#5267 R3-6 — for-of over an array honours a deleted Array.prototype[@@iterator]", () => {
  it("throws a catchable TypeError instead of iterating", async () => {
    const { value, hostImports } = await runStandalone(
      `delete Array.prototype[Symbol.iterator];
       var outcome = 0;
       try {
         var seen = 0;
         for (const x of [1, 2, 3]) seen += x;
         outcome = seen;
       } catch (e) {
         outcome = (e instanceof TypeError) ? 42 : 7;
       }
       export function test(): number { return outcome; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(42);
  });

  it("a module without the delete still iterates normally", async () => {
    const { value, hostImports } = await runStandalone(
      `export function test(): number {
         var seen = 0;
         for (const x of [1, 2, 3]) seen += x;
         return seen;
       }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(6);
  });
});
