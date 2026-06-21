/**
 * Tests for issue #2026 (PR-3a): spread arguments in the dynamic-`new` fallback
 * (`new K(...)` where `K` is a value-bound class identifier).
 *
 * PR-1 shipped the core tag-dispatch but its per-arg eval loop compiled a
 * `SpreadElement` verbatim — the spread expression yields an i32 (array length)
 * / ref, not a boxed externref, so the downstream `extern.convert_any` rejected
 * it and the whole module failed to instantiate (INVALID Wasm).
 *
 * PR-3a:
 * - Flattens an array-LITERAL spread (`new K(...[a, b])`, `new K(a, ...[b])`)
 *   via the shared `flattenCallArgs` before the loop — now constructs correctly.
 * - A non-flattenable (variable) spread (`new K(...someVar)`) cannot be driven
 *   by the compile-time-fixed-arity tag dispatch and would otherwise fall to the
 *   legacy `__new_` path, which in standalone/WASI trips a `global index out of
 *   range` binary-emit crash. PR-3a **refuses loudly** with a clear compile
 *   diagnostic instead, so the deferral is explicit, not a silent wrong result.
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

describe("issue #2026 (PR-3a): dynamic-new spread arguments", () => {
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

  it("array-literal spread feeding more args than declared params", async () => {
    const src = `
class P { x: number; constructor(a: number) { this.x = a; } }
function make(K: any): any { return new K(...[7, 99]); }
export function test(): number { const p = make(P); return p.x; }
`;
    expect(await runTest(src)).toBe(7);
  });

  it("variable (non-array-literal) spread now constructs via the runtime argv path (#2026 #53)", async () => {
    // PR-3a refused a non-array-literal spread loudly; #2026/#53 (this PR)
    // supersedes that with a runtime `$ObjVecArr` argv so `new K(...args)`
    // actually constructs rather than refusing — producing the correct value,
    // not crashing and not silently emitting a wrong result.
    const src = `
class P { x: number; constructor(a: number) { this.x = a; } }
function make(K: any, args: number[]): any { return new K(...args); }
export function test(): number { const p = make(P, [3]); return p.x; }
`;
    expect(await runTest(src)).toBe(3);
  });

  it("regression guard: plain-arg dynamic new still works (PR-1, unchanged)", async () => {
    const src = `
class P { x: number; y: number; constructor(a: number, b: number) { this.x = a; this.y = b; } }
function make(K: any): any { return new K(7, 9); }
export function test(): number { const p = make(P); return p.x + p.y; }
`;
    expect(await runTest(src)).toBe(16);
  });
});

describe("issue #2026 (PR-3b): new.target in the dynamic-new ctor", () => {
  // `new.target === A` is an i32 boolean inside the ctor; surfaced through the
  // externref boundary it reads as 1 (true) / 0 (false). PR-1 left it 0 on the
  // dynamic path because the new-target global was never set. PR-3b sets it to
  // the dispatched class id before the ctor call (the static path already does).
  it("sets new.target to the dispatched class inside the dynamic ctor", async () => {
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
});
