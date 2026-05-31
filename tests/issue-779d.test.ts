// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #779d (narrow) — funcIdx off-by-one in object-literal method binding-default.
//
// `method({ x = thrower() })` where `thrower` is declared after the object
// literal previously compiled to an invalid module: the externref param
// destructuring path (destructureParamObject) emits a struct-fast-path `then`
// branch and an `__extern_get` `else` branch, each compiling the default
// initializer (`thrower()`) into a detached buffer via a manual fctx.body swap.
// When the *second* branch's compilation triggered a late/union import, the
// function indices shifted — but the *first* branch's buffer was detached from
// fctx.body at that moment, so the index-shift walk missed its forward `call`,
// leaving an off-by-one funcIdx ("not enough arguments on the stack for call").
//
// Fix: register both branch buffers in ctx.liveBodies (walked by every shift
// path) for the whole construction window.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<Record<string, Function>> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  // Instantiation validates the module — the funcIdx bug surfaced here as
  // "Compiling function ...: not enough arguments on the stack for call".
  const imports: any = buildImports(r.imports, undefined, r.stringPool);
  const inst = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(inst.instance.exports);
  return inst.instance.exports as Record<string, Function>;
}

describe("#779d — object-literal method binding-default funcIdx shift", () => {
  // The headline shape: a method with a destructured-param default that calls a
  // function declared AFTER the object literal. Enough surrounding functions /
  // late imports must exist for the index shift to fire mid-method-body. The
  // bug only reproduced once the module had grown large enough; we approximate
  // that here with several helper functions plus the forward `thrower`.
  it("method({ x = thrower() }) with thrower declared later instantiates", async () => {
    await expect(
      run(`
        function pad1(): number { return 1; }
        function pad2(): number { return 2; }
        const obj: any = {
          method({ x = thrower() }: any): any { return x; }
        };
        function thrower(): any { throw new Error("boom"); }
        export function test(): number { pad1(); pad2(); return 0; }
      `),
    ).resolves.toBeDefined();
  });

  it("generator method with forward-called binding default instantiates", async () => {
    await expect(
      run(`
        const obj: any = {
          *gen({ x = later() }: any): any { yield x; }
        };
        function later(): any { return "lateval"; }
        export function test(): number { return 0; }
      `),
    ).resolves.toBeDefined();
  });

  it("binding default that IS taken still evaluates the initializer (semantics intact)", async () => {
    const exports = await run(`
      function makeDefault(): number { return 99; }
      const obj: any = {
        method({ x = makeDefault() }: any): number { return x; }
      };
      export function test(): number {
        // Call with an object missing 'x' so the default fires.
        return obj.method({});
      }
    `);
    expect(exports.test!()).toBe(99);
  });
});
