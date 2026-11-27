import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// #1819: logical assignment (??= ||= &&=) on a module-level / captured global
// read the global's type from `ctx.mod.globals[absIdx]` using the *absolute*
// Wasm global index instead of the module-local index. When import globals are
// present (e.g. the string-constant pool from any string literal), the
// module-globals array is offset by `numImportGlobals`, so the lookup landed on
// the wrong slot — or off the end. That produced a wrong `varType` (falling
// back to f64), which either:
//   - skipped the null/undefined short-circuit branch (wrong runtime value), or
//   - emitted an `if` condition typed f64 where i32 was expected (invalid Wasm).
//
// Fix: wrap both lookups with `localGlobalIdx(ctx, …)` (= absIdx -
// numImportGlobals), matching every other global access in assignment.ts.
// Repro requires at least one string literal so the string-constant import
// globals shift the module-globals array.

async function run(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "t.ts" });
  expect(r.success, `Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(true);
  const instance = await instantiateWithRuntime(r);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("#1819 logical assignment reads module/captured globals at the right index", () => {
  it("??= on a module string|null global takes the null branch (string pool present)", async () => {
    const out = await run(`
      let g: string | null = null;
      const pad = "xyz"; // forces string-constant import globals
      export function test(): string {
        g ??= "set";
        return (g as string) + pad;
      }
    `);
    expect(out).toBe("setxyz");
  });

  it("??= on an already-set module global keeps the existing value", async () => {
    const out = await run(`
      let g: string | null = "orig";
      const pad = "_q";
      export function test(): string {
        g ??= "fallback";
        return (g as string) + pad;
      }
    `);
    expect(out).toBe("orig_q");
  });

  it("||= on a module number global compiles to valid Wasm and short-circuits", async () => {
    const out = await run(`
      let n = 0;
      const pad = "abc";
      export function test(): number {
        n ||= 42;
        return n;
      }
    `);
    expect(out).toBe(42);
  });

  it("||= on a truthy module number global keeps the existing value", async () => {
    const out = await run(`
      let n = 7;
      const pad = "abc";
      export function test(): number {
        n ||= 42;
        return n;
      }
    `);
    expect(out).toBe(7);
  });

  it("&&= on a truthy module number global assigns the RHS", async () => {
    const out = await run(`
      let m = 7;
      const pad = "abc";
      export function test(): number {
        m &&= 99;
        return m;
      }
    `);
    expect(out).toBe(99);
  });

  it("&&= on a falsy module number global short-circuits to the existing value", async () => {
    const out = await run(`
      let m = 0;
      const pad = "abc";
      export function test(): number {
        m &&= 99;
        return m;
      }
    `);
    expect(out).toBe(0);
  });

  it("??= on a captured global inside a closure takes the null branch", async () => {
    const out = await run(`
      const pad = "zzz";
      let g: string | null = null;
      function inner(): string {
        g ??= "viaClosure";
        return (g as string) + pad;
      }
      export function test(): string {
        return inner();
      }
    `);
    expect(out).toBe("viaClosurezzz");
  });
});
