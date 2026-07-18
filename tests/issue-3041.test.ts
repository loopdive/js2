import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #3041 — a get-accessor reached through an `any`-typed receiver on a class
// declared INSIDE a function returned NaN/undefined: the dynamic property-GET
// path (`__get_member_<name>` dispatcher + the `isExternObj` any-read terminal
// in property-access-dispatch.ts) had struct-field arms and #2963 method arms
// but NO arm for a get-accessor, whose value is COMPUTED by a getter function
// rather than stored in a slot. So the read fell straight to `__extern_get` →
// `undefined` (→ NaN in an f64 context). The fix mirrors the static
// `compilePropertyAccess` accessor branch on the dynamic path: dispatcher
// accessor arms `ref.cast` the receiver to the class struct, `call` the getter,
// and box the return up to the dispatcher's uniform externref.
async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as unknown as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!();
}

describe("#3041 get-accessor via any receiver on a nested class", () => {
  it("constant getter (no capture) invoked through an any receiver", async () => {
    expect(
      await run(`
        function make() { class K { get v(): number { return 42; } } return new K(); }
        export function test(): number { const o: any = make(); return o.v; }`),
    ).toBe(42);
  });

  it("own-field getter invoked through an any receiver", async () => {
    expect(
      await run(`
        function make() { class K { x: number = 7; get v() { return this.x; } } return new K(); }
        export function test(): number { const o: any = make(); return o.v; }`),
    ).toBe(7);
  });

  it("captured-variable getter invoked through an any receiver", async () => {
    expect(
      await run(`
        function make(n: number) { class K { get v(): number { return n * 2; } } return new K(); }
        export function test(): number { const o: any = make(21); return o.v; }`),
    ).toBe(42);
  });

  it("string-returning getter invoked through an any receiver", async () => {
    expect(
      await run(`
        function make() { class K { get s(): string { return "hi"; } } return new K(); }
        export function test(): number { const o: any = make(); return o.s === "hi" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("boolean-returning getter preserves the boolean brand through the dynamic read", async () => {
    expect(
      await run(`
        function make() { class K { get b(): boolean { return true; } } return new K(); }
        export function test(): number { const o: any = make(); return o.b === true ? 1 : 0; }`),
    ).toBe(1);
  });

  it("getter overriding a superclass getter resolves the override via an any receiver", async () => {
    expect(
      await run(`
        function make() {
          class B { get v(): number { return 1; } }
          class D extends B { get v(): number { return 2; } }
          return new D();
        }
        export function test(): number { const o: any = make(); return o.v; }`),
    ).toBe(2);
  });

  it("inherited getter resolves via an any receiver on the subclass instance", async () => {
    expect(
      await run(`
        function make() {
          class B { get v(): number { return 9; } }
          class D extends B {}
          return new D();
        }
        export function test(): number { const o: any = make(); return o.v; }`),
    ).toBe(9);
  });

  it("static (typed) getter dispatch still works (regression guard)", async () => {
    expect(
      await run(`
        function make() { class K { get v(): number { return 42; } } return new K(); }
        export function test(): number { const o = make(); return o.v; }`),
    ).toBe(42);
  });

  it("method (not getter) via an any receiver still works (regression guard)", async () => {
    expect(
      await run(`
        function make() { class K { v(): number { return 42; } } return new K(); }
        export function test(): number { const o: any = make(); return o.v(); }`),
    ).toBe(42);
  });
});
