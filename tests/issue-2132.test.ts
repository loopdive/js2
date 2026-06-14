// #2132 — a non-optional method call on a statically-nullable receiver
// (`C | null`, incl. laundered through `as any` / `!`) must throw a CATCHABLE
// `TypeError` on null, not a bare `ref.as_non_null` Wasm trap. A Wasm null-deref
// trap bypasses the module's own exception tags and aborts uncatchably, so a
// user `try/catch` around the call could not recover.
//
// Fix (src/codegen/expressions/calls.ts): detect receiver nullability from the
// static type (peeling `as`/`!`/parens so `as any` doesn't hide it), compile the
// receiver with a NULLABLE param-0 hint so it stays nullable on the stack, then
// the existing `ref_null` null-guard throws a catchable TypeError. Non-null
// receivers dispatch unchanged.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors.map((e) => e.message).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(result.binary, imports as never);
  if (typeof imports.setExports === "function") {
    (imports.setExports as (e: unknown) => void)(instance.exports);
  }
  return (instance.exports as { test(): unknown }).test();
}

describe("#2132 method call on a null receiver throws a catchable TypeError", () => {
  it("catches the TypeError from `(c as any).m()` on a null receiver", async () => {
    const got = await run(`
      class C { m(): number { return 1; } }
      export function test(): number {
        const c: C | null = null;
        try { (c as any).m(); return 0; } catch (e) { return 99; }
      }`);
    expect(got).toBe(99); // node: TypeError caught → 99 (was: uncatchable trap)
  });

  it("catches the TypeError from `c!.m()` on a null receiver", async () => {
    const got = await run(`
      class C { m(): number { return 1; } }
      export function test(): number {
        const c: C | null = null;
        try { c!.m(); return 0; } catch (e) { return 99; }
      }`);
    expect(got).toBe(99); // node: 99
  });

  it("catches the TypeError on an `undefined` receiver too", async () => {
    const got = await run(`
      class C { m(): number { return 1; } }
      export function test(): number {
        const c: C | undefined = undefined;
        try { (c as any).m(); return 0; } catch (e) { return 99; }
      }`);
    expect(got).toBe(99); // node: 99
  });

  it("a non-null receiver dispatches normally (no added trap)", async () => {
    const got = await run(`
      class C { m(): number { return 7; } }
      export function test(): number {
        const c: C | null = new C();
        return (c as any).m();
      }`);
    expect(got).toBe(7); // node: 7
  });

  it("a method with arguments on a non-null nullable-typed receiver works", async () => {
    const got = await run(`
      class C { add(a: number, b: number): number { return a + b; } }
      export function test(): number {
        const c: C | null = new C();
        return c!.add(3, 4);
      }`);
    expect(got).toBe(7); // node: 7
  });
});
