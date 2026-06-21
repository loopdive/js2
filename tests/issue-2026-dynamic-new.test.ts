/**
 * Tests for issue #2026 (PR-1): `new K()` where `K` is a value-bound class
 * identifier (a class flowing through a parameter / variable of type `any`).
 *
 * Before this slice: `function make(K: any) { return new K(); }` threw
 * `No dependency provided for extern class "K"` at runtime — the constructee
 * was not a statically known class, so `compileNewExpression` fell through to
 * the unknown-ctor host import which the runtime could not resolve.
 *
 * Fix (PR-1): a dynamic-new fallback in `compileNewExpression`'s `!className`
 * branch. The value bound to `K` is the `__class_<Name>` class-object singleton
 * (the same `$ClassName` struct type as instances), carrying the class id in
 * its `__tag` field. We read the tag (pure-Wasm, no host import) and dispatch
 * by a flat tag-equality chain to the matching `<Class>_new`, threading the
 * (boxed) arguments. A non-class / no-match descriptor falls through to the
 * legacy `__new_` host import so genuine host builtins keep working. The static
 * `new C()` path is untouched.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(src: string, exportName = "test"): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const exp = instance.exports as Record<string, () => unknown>;
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return exp[exportName]!();
}

describe("issue #2026: dynamic new on a value-bound class", () => {
  it("new K() through a parameter constructs the class (repro → 6)", async () => {
    const src = `
const C = class { v = 3; m(): number { return this.v * 2; } };
function make(K: any): any { return new K(); }
export function test(): number { return make(C).m(); }
`;
    expect(await runTest(src)).toBe(6);
  });

  it("threads constructor arguments through the dynamic path", async () => {
    const src = `
class A { x: number; constructor(a: number) { this.x = a; } getX(): number { return this.x; } }
function mk(K: any, n: number): any { return new K(n); }
export function test(): number { return mk(A, 5).getX(); }
`;
    expect(await runTest(src)).toBe(5);
  });

  it("dispatches to the correct class among shape-colliding classes", async () => {
    // A {x:number} and B {y:number} canonicalize to the same WasmGC struct
    // shape; dispatch must use the class TAG, not the struct type, so each gets
    // its own constructor.
    const src = `
class A { x: number; constructor(a: number) { this.x = a; } getX(): number { return this.x; } }
class B { y: number; constructor(b: number) { this.y = b * 10; } getY(): number { return this.y; } }
function mk(K: any, n: number): any { return new K(n); }
export function test(): number {
  const a = mk(A, 5);
  const b = mk(B, 7);
  return a.getX() + b.getY(); // 5 + 70 = 75
}
`;
    expect(await runTest(src)).toBe(75);
  });

  it("constructs an empty class (no constructor) dynamically", async () => {
    const src = `
class A { x = 1; }
function mk(K: any): any { return new K(); }
export function test(): number { return (mk(A) as any).x; }
`;
    expect(await runTest(src)).toBe(1);
  });

  it("regression guard: static new C() is unchanged and still works", async () => {
    // The static `new A()` path must keep emitting a typed instance — verify it
    // produces the right value AND that a method call on it works (i.e. it did
    // not get widened to externref by the dynamic fallback).
    const src = `
class A { x: number; constructor(a: number) { this.x = a; } getX(): number { return this.x; } }
export function test(): number { return new A(5).getX(); }
`;
    expect(await runTest(src)).toBe(5);
  });

  it("host-builtin unknown ctor still falls through (RangeError)", async () => {
    // With a user class present, a genuine builtin constructor used in the
    // program must still route through the host path, not the tag dispatch.
    const src = `
class A { x = 1; }
function mk(K: any): any { return new K(); }
export function test(): string {
  const a = (mk(A) as any).x;
  const e: any = new RangeError("hi");
  return a + ":" + e.message + ":" + (e instanceof RangeError);
}
`;
    expect(await runTest(src)).toBe("1:hi:true");
  });

  it("regression guard: value-bound builtin/externref ctor does not emit invalid Wasm (#2026)", async () => {
    // A class whose constructor is externref-backed must NOT be a tag-dispatch
    // candidate: tag dispatch reads the descriptor as a `$ClassName` struct and
    // boxes the result with `extern.convert_any`. If the ctor already returns
    // externref, the second convert is invalid Wasm (`extern.convert_any[0]
    // expected anyref, found externref`). This pattern broke ~20 test262 tests
    // where a value-bound TypedArray constructor reached the fallback
    // (`testWithTypedArrayConstructors(function(TA){ new TA(); })`). The presence
    // of an externref-returning-ctor class plus a value-bound `new K()` in the
    // same module must still compile to valid Wasm.
    const src = `
class Wrapped extends Error { tag = 1; }
class Plain { v = 7; }
function mk(K: any): any { return new K(); }
export function test(): number { return (mk(Plain) as any).v; }
`;
    // The key assertion is that this compiles to valid Wasm at all (no
    // CompileError); the value check confirms the dispatch still works.
    expect(await runTest(src)).toBe(7);
  });
});
