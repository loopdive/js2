import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * (#5203) A STATIC method reached dynamically off a class VALUE was
 * uncallable from top-level code — the CLOSURE facet of the #5193/#5202
 * module-init window.
 *
 * #5202 closed instance-method dispatch, which the runtime answers by export
 * NAME (`__class_call_*`). A static never uses that surface: it is handed to
 * the host as a raw closure struct via `__register_class_static_method`, and
 * `_wrapWasmClosureUnknownArity` turns it into a callable — but that function
 * bailed on `if (!exports) return null`, because invoking a closure needs the
 * `__call_fn_*` dispatchers, which are exports and therefore unreachable while
 * the wasm `start` section runs.
 *
 * jsbi calls `JSBI.__clz30(t)` exactly this way during module init.
 *
 * Every case pairs an AT-INIT call with an after-init CONTROL: the control is
 * what fails to prove anything if a fix ever regresses into "statics stopped
 * working entirely".
 */
async function run(source: string): Promise<{ atInit: unknown; afterInit: unknown }> {
  const result = await compile(source, { fileName: "issue-5203.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const exports = instance.exports as Record<string, () => unknown>;
  return { atInit: exports.atInit(), afterInit: exports.test() };
}

describe("#5203 — dynamic static-method dispatch during module init", () => {
  it("calls a static reached through an any-typed class value at init", async () => {
    // The reduced repro from the issue — jsbi's `JSBI.__clz30(t)` shape.
    expect(
      await run(`
        class D extends Array {
          constructor(n: number) { super(n); }
          static clz(): number { return 9; }
        }
        function g(c: any): number { return c.clz(); }
        const A: number = g(D);
        export function atInit(): number { return A; }
        export function test(): number { return g(D); }
      `),
    ).toEqual({ atInit: 9, afterInit: 9 });
  });

  it("keeps the static's own arguments at init", async () => {
    // Guards against a fix that finds the closure but dispatches at the wrong
    // arity — the arity bridge is exactly what the start-export channel had to
    // carry.
    expect(
      await run(`
        class D extends Array {
          constructor(n: number) { super(n); }
          static add(a: number, b: number): number { return a + b; }
        }
        function g(c: any): number { return c.add(4, 5); }
        const A: number = g(D);
        export function atInit(): number { return A; }
        export function test(): number { return g(D); }
      `),
    ).toEqual({ atInit: 9, afterInit: 9 });
  });

  it("dispatches a static on a plain (non-builtin-derived) class at init", async () => {
    expect(
      await run(`
        class P {
          static v(): number { return 11; }
        }
        function g(c: any): number { return c.v(); }
        const A: number = g(P);
        export function atInit(): number { return A; }
        export function test(): number { return g(P); }
      `),
    ).toEqual({ atInit: 11, afterInit: 11 });
  });

  it("keeps a statically-resolved static call working at init", async () => {
    // `D.clz()` written directly never went through the closure bridge and
    // always worked; this is the control that the registration did not
    // perturb it.
    expect(
      await run(`
        class D extends Array {
          constructor(n: number) { super(n); }
          static clz(): number { return 9; }
        }
        const A: number = D.clz();
        export function atInit(): number { return A; }
        export function test(): number { return D.clz(); }
      `),
    ).toEqual({ atInit: 9, afterInit: 9 });
  });

  it("calls a plain compiled function value through an any-typed alias at init", async () => {
    // The same closure bridge, reached without any class at all — the
    // narrowest statement of what the start-export channel now carries.
    expect(
      await run(`
        function h(): number { return 6; }
        function g(f: any): number { return f(); }
        const A: number = g(h);
        export function atInit(): number { return A; }
        export function test(): number { return g(h); }
      `),
    ).toEqual({ atInit: 6, afterInit: 6 });
  });
});
