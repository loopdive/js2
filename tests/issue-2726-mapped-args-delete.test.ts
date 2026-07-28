// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2726 group (e) — `delete arguments[i]` on a mapped, configurable index.
//
// ECMA-262 §10.4.4.5 (mapped-arguments [[Delete]]) → OrdinaryDelete: a
// SUCCESSFUL `delete arguments[i]` of a configurable mapped index both
//   (1) severs the param↔arguments map (later parameter writes no longer
//       mirror into `arguments[i]`), and
//   (2) removes the slot — a subsequent `arguments[i]` read observes
//       `undefined`.
//
// Previously only (1) was implemented (the `unmappedIndices` bookkeeping): the
// delete returned `true` (via the generic `__delete_property` path) but the
// WasmGC-vec-backed slot was never cleared, so `arguments[i]` still read the
// original argument. This flips test262 `11.4.1-4.a-17` fail→pass.
//
// Mapped arguments require a SIMPLE parameter list in SLOPPY mode; the synthetic
// `export function test()` wrapper makes TypeScript flag the source as a module
// (strict), so `inferModuleStrictArguments: false` restores the script-goal
// sloppy strictness the test262 harness uses for `noStrict` tests.

async function run(source: string, target?: "standalone"): Promise<unknown> {
  const result = await compile(source, { inferModuleStrictArguments: false, ...(target ? { target } : {}) });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = target ? {} : buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if (!target) {
    (imports as ReturnType<typeof buildImports>).setExports?.(
      instance.exports as Record<string, (...a: unknown[]) => unknown>,
    );
  }
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>).test();
}

describe("#2726 (e) — delete arguments[i] on a mapped configurable index", () => {
  // test262 11.4.1-4.a-17: `delete arguments[0]` returns true AND the slot then
  // reads `undefined`.
  it("returns true and the slot reads undefined afterward", async () => {
    const src = `
      export function test(): number {
        function foo(a, b) {
          var d = delete arguments[0];
          if (d !== true) return 10;
          if (arguments[0] !== undefined) return 20;
          return 1;
        }
        return foo(1, 2);
      }`;
    expect(await run(src)).toBe(1);
  });

  // A delete of one index must not disturb the sibling mapped slots.
  it("leaves other mapped slots intact", async () => {
    const src = `
      export function test(): number {
        function foo(a, b) {
          delete arguments[0];
          if (arguments[1] !== 2) return 10;
          return 1;
        }
        return foo(1, 2);
      }`;
    expect(await run(src)).toBe(1);
  });

  // After a successful delete the map is severed: a later parameter write must
  // NOT resurrect the deleted arguments slot (§10.4.4.2).
  it("severs the param->arguments map so a later param write does not resurrect the slot", async () => {
    const src = `
      export function test(): number {
        function foo(a, b) {
          delete arguments[0];
          a = 99;
          if (arguments[0] !== undefined) return 10;
          return 1;
        }
        return foo(1, 2);
      }`;
    expect(await run(src)).toBe(1);
  });

  const strictUnmappedSource = `
    export function test(): number {
      function foo(a, b) {
        "use strict";
        var d = delete arguments[0];
        if (d !== true) return 10;
        if (arguments[0] !== undefined) return 20;
        return 1;
      }
      return foo(1, 2);
    }`;

  it("clears a strict unmapped arguments slot after delete (host)", async () => {
    expect(await run(strictUnmappedSource)).toBe(1);
  });

  it("clears a strict unmapped arguments slot after delete (standalone)", async () => {
    expect(await run(strictUnmappedSource, "standalone")).toBe(1);
  });
});
