// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2011 — object-literal getter/setter closures at MODULE scope captured the
// wrong representation. A `const o = { get x() {...} }` declared at top level
// was registered as a WasmGC *struct* global (resolveWasmType), while the
// literal itself compiled through the JS-host plain-object/accessor path
// (compileObjectLiteral routes any accessor literal to
// compileObjectLiteralWithAccessors). The two disagreed: `o.x` reads then
// mis-routed to __extern_get against a struct and returned undefined → NaN,
// and outer captures never re-synced.
//
// The function-local pre-pass (index.ts walkStmtForLetConst / hoistVarDecl)
// already forced externref + tagged externrefAccessorVars for accessor
// literals; the module-level registration path (declarations.ts) did not.
// The fix mirrors that override for module-level let/const/var.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "test"): Promise<unknown> {
  const r = await compile(source);
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  // Accessor callbacks dispatch through __cb_N exports — the imports object
  // must be wired back to the instance via setExports or every getter/setter
  // bridge silently returns undefined.
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports as any)[fn]();
}

describe("#2011 — module-level object-literal accessor closures", () => {
  it("getter reads a module-level let (read-only capture)", async () => {
    const out = await run(`
      let val = 42;
      const obj = { get v(): number { return val; } };
      export function test(): number { return obj.v; }
    `);
    expect(out).toBe(42);
  });

  it("getter reads a module-level const (read-only capture)", async () => {
    const out = await run(`
      const val = 42;
      const obj = { get v(): number { return val; } };
      export function test(): number { return obj.v; }
    `);
    expect(out).toBe(42);
  });

  it("getter increments a module-level var; outer scope observes the writes", async () => {
    const out = await run(`
      let count = 0;
      const obj = { get v(): number { count = count + 1; return count; } };
      export function test(): number { obj.v; obj.v; return count; }
    `);
    expect(out).toBe(2);
  });

  it("setter writes a module-level var through the accessor", async () => {
    const out = await run(`
      let captured = 0;
      const o: any = { set x(v: number) { captured = v * 2; } };
      export function test(): number { o.x = 10; return captured; }
    `);
    expect(out).toBe(20);
  });

  it("module-level get/set pair shares the captured backing", async () => {
    const out = await run(`
      let backing = 100;
      const o: any = {
        get x(): number { return backing; },
        set x(v: number) { backing = v; },
      };
      export function test(): string { o.x = 105; return o.x + "," + backing; }
    `);
    expect(out).toBe("105,105");
  });

  it("repro: distinct getter reads return distinct values; count is observed", async () => {
    const out = await run(`
      let count = 0;
      const o: any = { get x(): number { count = count + 1; return count; } };
      export function test(): string {
        const a = o.x; const b = o.x;
        return a + "," + b + "," + count;
      }
    `);
    expect(out).toBe("1,2,2");
  });

  it("plain (non-accessor) module-level literal still uses the struct path", async () => {
    // Guard against over-broad externref forcing: a literal with only data
    // properties must remain a typed struct read, not a host get.
    const out = await run(`
      const o = { a: 3, b: 4 };
      export function test(): number { return o.a + o.b; }
    `);
    expect(out).toBe(7);
  });
});
