/**
 * Tests for issue #2026 (PR-3): conformance edges of the dynamic-`new`
 * fallback (`new K(...)` where `K` is a value-bound class identifier).
 *
 * PR-1 shipped the core tag-dispatch (plain args, shape-collision, derived
 * classes). PR-3 covers the argument/meta edges that PR-1 left broken:
 *
 * - **Spread arguments** (`new K(...[a, b])`). The PR-1 arg-eval loop compiled a
 *   `SpreadElement` as a single argument, producing a non-externref (an i32
 *   array length) that the downstream `extern.convert_any` rejected — the whole
 *   module failed to instantiate (INVALID Wasm). PR-3a flattens an array-literal
 *   spread via the shared `flattenCallArgs` before the loop; a non-flattenable
 *   spread (`new K(...someVar)`) bails to the legacy path (a runtime error, NOT
 *   a broken module).
 * - **new.target** inside a dynamically-constructed ctor. PR-1 never set the
 *   new-target global on the dynamic path, so `new.target === K` read 0. PR-3b
 *   sets it to the dispatched class id before the ctor call (same as the static
 *   `new C()` path via `emitSetNewTargetBeforeCall`).
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

describe("issue #2026 (PR-3): dynamic-new argument & meta edges", () => {
  it("threads an array-literal spread into the dynamic ctor", async () => {
    // `new K(...[4, 5])` previously emitted INVALID Wasm. Now flattened.
    const src = `
class P { x: number; y: number; constructor(a: number, b: number) { this.x = a; this.y = b; } }
function make(K: any): any { return new K(...[4, 5]); }
export function test(): number { const p = make(P); return p.x + p.y; }
`;
    expect(await runTest(src)).toBe(9);
  });

  it("threads a mixed positional + array-literal spread", async () => {
    // `new K(4, ...[5])` previously returned a wrong (null) instance.
    const src = `
class P { x: number; y: number; constructor(a: number, b: number) { this.x = a; this.y = b; } }
function make(K: any): any { return new K(4, ...[5]); }
export function test(): number { const p = make(P); return p.x + p.y; }
`;
    expect(await runTest(src)).toBe(9);
  });

  it("a non-flattenable (variable) spread does not crash the module", async () => {
    // `new K(...someVar)` can't be flattened at compile time — it must degrade to
    // the legacy path (a runtime miss), NOT produce a module that fails to
    // instantiate. We assert the module COMPILES and instantiates (the dynamic
    // construction itself is a documented follow-up). A guard class keeps the
    // dynamic-new fallback active so we exercise the spread-bail path.
    const src = `
class P { x: number; constructor(a: number) { this.x = a; } }
function make(K: any, args: number[]): any {
  try { return new K(...args); } catch (e) { return null; }
}
export function test(): number { make(P, [3]); return 1; }
`;
    // The point of this test is that compile + instantiate succeed (runTest
    // would throw a CompileError / instantiate error otherwise).
    expect(await runTest(src)).toBe(1);
  });

  it("sets new.target to the dispatched class inside the dynamic ctor", async () => {
    // `new.target === A` is an i32 boolean inside the ctor; surfaced through the
    // externref boundary it reads as 1 (true) / 0 (false). PR-1 left it 0.
    const src = `
class A { hit: number; constructor() { this.hit = (new.target === A) ? 1 : 0; } }
function make(K: any): any { return new K(); }
export function test(): number { return make(A).hit; }
`;
    expect(await runTest(src)).toBe(1);
  });

  it("new.target discriminates between two dynamically-constructed classes", async () => {
    const src = `
class A { who: number; constructor() { this.who = (new.target === A) ? 1 : 0; } }
class B { who: number; constructor() { this.who = (new.target === B) ? 2 : 0; } }
function make(K: any): any { return new K(); }
export function test(): number { return make(A).who + make(B).who; } // 1 + 2 = 3
`;
    expect(await runTest(src)).toBe(3);
  });

  it("regression guard: plain-arg dynamic new still works (PR-1)", async () => {
    const src = `
class P { x: number; y: number; constructor(a: number, b: number) { this.x = a; this.y = b; } }
function make(K: any): any { return new K(7, 9); }
export function test(): number { const p = make(P); return p.x + p.y; }
`;
    expect(await runTest(src)).toBe(16);
  });
});
