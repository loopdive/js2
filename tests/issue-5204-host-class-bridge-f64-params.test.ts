import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * (#5204) On a builtin-derived class (`class D extends Array`), instance
 * members beyond zero-arg methods never reached the host dispatch path — at
 * init AND after init, so this is a CAPABILITY gap, not the #5193/#5202/#5203
 * timing window.
 *
 * Three distinct root causes, all in the class-qualified bridge that an
 * externref-backed receiver must use (its instance is a real host object, so
 * the generic `__member_kind_<key>` ref.test cascade over WasmGC struct types
 * can never match it):
 *
 *   1. `supportsHostClassBridgeParam` rejected `f64`, so `add(x, y)` published
 *      no bridge at all — `add is not a function`.
 *   2. A rest-parameter method published only the STRUCT-path
 *      `__class_call_<key>_vararg`, never a class-qualified one — `sum is not
 *      a function`.
 *   3. An accessor was compiled with a WasmGC-struct receiver while methods of
 *      the same class were compiled with an externref receiver, so no getter
 *      bridge was emittable; and `_safeGet` consulted the class-member
 *      resolver only inside its `_isWasmStruct(obj)` block, which a host-object
 *      receiver never enters — `get g()` read `NaN`.
 *
 * Every case is measured BOTH at init and after init. The after-init arm is
 * what makes this issue distinguishable from its timing siblings; the at-init
 * arm is what keeps it fixed once #5203's channel is in place.
 */
async function run(source: string): Promise<{ atInit: unknown; afterInit: unknown }> {
  const result = await compile(source, { fileName: "issue-5204.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const exports = instance.exports as Record<string, () => unknown>;
  return { atInit: exports.atInit(), afterInit: exports.test() };
}

describe("#5204 — builtin-derived class members through the host bridge", () => {
  it("calls a method taking f64 arguments", async () => {
    expect(
      await run(`
        class D extends Array {
          constructor(n: number) { super(n); }
          add(x: number, y: number): number { return x + y; }
        }
        function f(a: any): number { return a.add(4, 5); }
        const AT_INIT: number = f(new D(1));
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new D(1)); }
      `),
    ).toEqual({ atInit: 9, afterInit: 9 });
  });

  it("calls a single-f64-argument method", async () => {
    expect(
      await run(`
        class D extends Array {
          constructor(n: number) { super(n); }
          inc(x: number): number { return x + 1; }
        }
        function f(a: any): number { return a.inc(4); }
        const AT_INIT: number = f(new D(1));
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new D(1)); }
      `),
    ).toEqual({ atInit: 5, afterInit: 5 });
  });

  it("calls a rest-parameter method", async () => {
    expect(
      await run(`
        class D extends Array {
          constructor(n: number) { super(n); }
          sum(...xs: number[]): number { let t = 0; for (const x of xs) t += x; return t; }
        }
        function f(a: any): number { return a.sum(1, 2, 3); }
        const AT_INIT: number = f(new D(1));
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new D(1)); }
      `),
    ).toEqual({ atInit: 6, afterInit: 6 });
  });

  it("calls a rest-parameter method with a fixed parameter ahead of the rest", async () => {
    // The #4644 shape: `restIndex` is a SOURCE index with no receiver slot, so
    // the rest vector must be located by TYPE from the end of the signature.
    expect(
      await run(`
        class D extends Array {
          constructor(n: number) { super(n); }
          scale(k: number, ...xs: number[]): number { let t = 0; for (const x of xs) t += x; return t * k; }
        }
        function f(a: any): number { return a.scale(2, 1, 2, 3); }
        const AT_INIT: number = f(new D(1));
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new D(1)); }
      `),
    ).toEqual({ atInit: 12, afterInit: 12 });
  });

  it("reads a getter", async () => {
    expect(
      await run(`
        class D extends Array {
          constructor(n: number) { super(n); }
          get g(): number { return 12; }
        }
        function f(a: any): number { return a.g; }
        const AT_INIT: number = f(new D(1));
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new D(1)); }
      `),
    ).toEqual({ atInit: 12, afterInit: 12 });
  });

  it("keeps the zero-arg method path working", async () => {
    // Never broken — the control that catches a fix which trades the new
    // signatures for the one that already bridged.
    expect(
      await run(`
        class D extends Array {
          constructor(n: number) { super(n); }
          z(): number { return 7; }
        }
        function f(a: any): number { return a.z(); }
        const AT_INIT: number = f(new D(1));
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new D(1)); }
      `),
    ).toEqual({ atInit: 7, afterInit: 7 });
  });

  it("keeps the string-argument method path working", async () => {
    // Also never broken: a `string` formal is already externref, which is
    // precisely why f64 was the whole gap.
    expect(
      await run(`
        class D extends Array {
          constructor(n: number) { super(n); }
          tag(s: string): string { return s + "!"; }
        }
        function f(a: any): string { return a.tag("x"); }
        const AT_INIT: string = f(new D(1));
        export function atInit(): string { return AT_INIT; }
        export function test(): string { return f(new D(1)); }
      `),
    ).toEqual({ atInit: "x!", afterInit: "x!" });
  });

  it("keeps a plain (non-builtin-derived) class with f64 arguments working", async () => {
    // Resolves through the WasmGC struct surface, not the class-qualified
    // bridge — the control on the shared `supportsHostClassBridgeParam` change.
    expect(
      await run(`
        class P {
          constructor() {}
          add(x: number, y: number): number { return x + y; }
        }
        function f(a: any): number { return a.add(4, 5); }
        const AT_INIT: number = f(new P());
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new P()); }
      `),
    ).toEqual({ atInit: 9, afterInit: 9 });
  });

  it("reads the instance's own state through a bridged method", async () => {
    // Guards against dispatching to the right function but losing the receiver.
    expect(
      await run(`
        class D extends Array {
          tag: number;
          constructor(n: number, t: number) { super(n); this.tag = t; }
          plus(x: number): number { return this.tag + x; }
        }
        function f(a: any): number { return a.plus(1); }
        const AT_INIT: number = f(new D(1, 41));
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new D(1, 41)); }
      `),
    ).toEqual({ atInit: 42, afterInit: 42 });
  });
});
