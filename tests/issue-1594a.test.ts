// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1594A Slice A — closure-aware __typeof for block-hoisted function declarations.
//
// Per spec in plan/issues/1594-annexb-strict-function-code-tdz-referenceerror.md,
// `hoistFunctionDeclarations` lifts a block-scoped `function f(){}` to function
// scope and exposes it through `funcMap`. Identifier reads of `f` wrap the
// funcref in a closure struct via `emitFuncRefAsClosure`. A closure struct is
// a WasmGC struct with a null prototype — when handed to the runtime
// `__typeof` shim, `typeof <opaque struct>` returns `"object"`. This is the
// `typeof after === "object"` failure pattern across the annexB function-code
// suite.
//
// Fix: `__typeof` (and `__any_typeof` in the gcref arm) consult the
// `__is_closure` export — already the authoritative discriminator used by
// `_maybeWrapCallableUnknownArity` (src/runtime.ts:1024) — and report
// `"function"` for closure structs.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(src: string): Promise<Record<string, Function>> {
  const r = compile(src, { fileName: "t.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as Record<string, any>;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return instance.exports as Record<string, Function>;
}

describe("#1594A Slice A — closure-aware __typeof", () => {
  it("typeof of block-hoisted fn read at outer scope is 'function'", { timeout: 15000 }, async () => {
    const exports = await instantiate(`
      export function getResult(): string {
        let after: any;
        { function f() { return 'decl'; } }
        after = f;
        return typeof after;
      }
    `);
    expect(exports.getResult!()).toBe("function");
  });

  it("typeof of an externref-erased function decl is 'function'", { timeout: 15000 }, async () => {
    const exports = await instantiate(`
      function f() { return 1; }
      export function getResult(): string {
        const g: any = f;
        return typeof g;
      }
    `);
    expect(exports.getResult!()).toBe("function");
  });

  it("typeof of plain object stays 'object' (regression: non-closure struct)", { timeout: 15000 }, async () => {
    const exports = await instantiate(`
      export function getResult(): string {
        const o: any = { x: 1 };
        return typeof o;
      }
    `);
    expect(exports.getResult!()).toBe("object");
  });

  it("typeof of null stays 'object' (regression)", { timeout: 15000 }, async () => {
    const exports = await instantiate(`
      export function getResult(): string {
        const x: any = null;
        return typeof x;
      }
    `);
    expect(exports.getResult!()).toBe("object");
  });

  it("typeof of array stays 'object' (regression)", { timeout: 15000 }, async () => {
    const exports = await instantiate(`
      export function getResult(): string {
        const a: any = [1, 2, 3];
        return typeof a;
      }
    `);
    expect(exports.getResult!()).toBe("object");
  });
});
