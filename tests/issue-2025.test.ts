// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2025 — calling an extracted method (`const f = a.m; f()`) whose body
// dereferences `this` trapped uncatchably ("dereferencing a null pointer")
// instead of throwing a catchable TypeError. The method-extraction trampoline
// (`buildTrampolineThisSlot` in closures.ts) forwarded `ref.null` for `this`,
// so the method's `this.x` `struct.get` trapped and escaped the user's
// try/catch. The fix: when the method body actually reads `this` (`local.get 0`),
// the trampoline's null-receiver arm throws a catchable JS TypeError; methods
// that never touch `this` keep forwarding the harmless null so extraction of a
// `this`-free method still works.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function compileSrc(source: string, opts: Record<string, unknown> = {}) {
  const result = await compile(source, opts as never);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  return result;
}

async function run(source: string, fn = "test", opts: Record<string, unknown> = {}): Promise<unknown> {
  const result = await compileSrc(source, opts);
  const imports = buildImports(result.imports, ENV_STUB, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!();
}

describe("#2025 — extracted-method null-this throws a catchable TypeError", () => {
  it("extracting a this-using method and calling it is catchable (not a trap)", async () => {
    const src = `
      class A { x = 42; m(): number { return this.x; } }
      export function test(): string {
        const a = new A();
        const f = a.m;
        try { return "got:" + f(); } catch (e) { return "threw"; }
      }
    `;
    // Node: TypeError "Cannot read properties of undefined" → "threw".
    // Previously this trapped uncatchably and the exception escaped to the host.
    expect(await run(src)).toBe("threw");
  });

  it("the caught value is a real TypeError instance", async () => {
    const src = `
      class A { x = 42; m(): number { return this.x; } }
      export function test(): string {
        const a = new A();
        const f = a.m;
        try { f(); return "no-throw"; }
        catch (e) { return (e instanceof TypeError) ? "TypeError" : "other"; }
      }
    `;
    expect(await run(src)).toBe("TypeError");
  });

  it("extracted this-using method with arguments still throws catchably", async () => {
    const src = `
      class A { x = 5; m(n: number): number { return this.x + n; } }
      export function test(): string {
        const a = new A();
        const f = a.m;
        try { return "v" + f(10); } catch { return "threw"; }
      }
    `;
    expect(await run(src)).toBe("threw");
  });

  it("direct method calls are unchanged (valid receiver)", async () => {
    const src = `
      class A { x = 42; m(): number { return this.x; } }
      export function test(): number {
        const a = new A();
        return a.m();
      }
    `;
    expect(await run(src)).toBe(42);
  });

  it("extracting a method that does NOT use this still works (no spurious throw)", async () => {
    const src = `
      class A { m(): number { return 7; } }
      export function test(): number {
        const a = new A();
        const f = a.m;
        return f();
      }
    `;
    expect(await run(src)).toBe(7);
  });

  it("method dispatch through a value receiver is unchanged", async () => {
    const src = `
      class A { x = 42; m(): number { return this.x; } }
      export function test(): number {
        const a = new A();
        const _extracted = a.m; // forces the extraction trampoline to exist
        const o: any = a;
        return o.m(); // dispatched with a real receiver → 42
      }
    `;
    expect(await run(src)).toBe(42);
  });

  it("standalone mode: extracted this-using method throws catchably", async () => {
    const src = `
      class A { x = 42; m(): number { return this.x; } }
      export function test(): string {
        const a = new A();
        const f = a.m;
        try { f(); return "no-throw"; } catch (e) { return "threw"; }
      }
    `;
    expect(await run(src, "test", { standalone: true })).toBe("threw");
  });
});
