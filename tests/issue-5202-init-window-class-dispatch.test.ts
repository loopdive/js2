import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * (#5202) A compiled class's methods were unreachable from TOP-LEVEL code (the
 * wasm `start` section) — the method-dispatch facet of the #5193 window.
 *
 * `__set_subclass_proto` synthesizes a bare `class Sub extends Parent {}`, so a
 * compiled method is not a JS property of any prototype. The runtime answers
 * `inst.m()` by reading the compiler-emitted dispatch EXPORTS
 * (`__class_call_*`, `__member_kind_*`, …), and `instance.exports` does not
 * exist while the start section runs — so the resolver bailed and the call
 * threw "m is not a function". The IDENTICAL call after instantiation returned
 * normally, which is what makes this a timing bug rather than a dispatch one.
 *
 * Every case therefore pairs an AT-INIT call with an after-init CONTROL: the
 * control is what fails to prove anything if the fix ever regresses into
 * "methods stopped working entirely".
 */
async function run(source: string): Promise<{ atInit: unknown; afterInit: unknown }> {
  const result = await compile(source, { fileName: "issue-5202.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const exports = instance.exports as Record<string, () => unknown>;
  return { atInit: exports.atInit(), afterInit: exports.test() };
}

describe("#5202 — class method dispatch during module init", () => {
  it("calls a method on a builtin-derived instance from top-level code", async () => {
    // jsbi's exact shape: `class JSBI extends Array` whose `__clzmsd()` is
    // reached from `__absoluteDivLarge` during module init.
    expect(
      await run(`
        class D extends Array {
          sign: boolean;
          constructor(n: number, s: boolean) { super(n); this.sign = s; }
          __clzmsd(): number { return 7; }
        }
        function f(a: any): number { return a.__clzmsd(); }
        const AT_INIT: number = f(new D(1, false));
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new D(1, false)); }
      `),
    ).toEqual({ atInit: 7, afterInit: 7 });
  });

  it("reads the instance's own state through the top-level method call", async () => {
    // Guards against a fix that dispatches to the right function but loses the
    // receiver — the method must observe the fields the constructor wrote.
    expect(
      await run(`
        class D extends Array {
          tag: number;
          constructor(n: number, t: number) { super(n); this.tag = t; }
          read(): number { return this.tag; }
        }
        function f(a: any): number { return a.read(); }
        const AT_INIT: number = f(new D(1, 42));
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new D(1, 42)); }
      `),
    ).toEqual({ atInit: 42, afterInit: 42 });
  });

  it("dispatches a method inherited from a compiled base class at init", async () => {
    expect(
      await run(`
        class Base extends Array {
          constructor(n: number) { super(n); }
          kind(): number { return 3; }
        }
        class Sub extends Base {
          constructor(n: number) { super(n); }
        }
        function f(a: any): number { return a.kind(); }
        const AT_INIT: number = f(new Sub(1));
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new Sub(1)); }
      `),
    ).toEqual({ atInit: 3, afterInit: 3 });
  });

  it("keeps the plain (non-builtin-derived) class path working at init", async () => {
    // Never regressed — this arm resolves through the WasmGC struct surface,
    // not the export-name dispatch. It guards the registration from perturbing
    // the path that already worked.
    expect(
      await run(`
        class P {
          v: number;
          constructor(v: number) { this.v = v; }
          m(): number { return this.v + 1; }
        }
        function f(a: any): number { return a.m(); }
        const AT_INIT: number = f(new P(5));
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return f(new P(5)); }
      `),
    ).toEqual({ atInit: 6, afterInit: 6 });
  });

  it("leaves a module with no top-level class calls alone", async () => {
    // The registration prologue is gated on the module having BOTH a module
    // initializer and dispatch exports; this is the no-op control.
    expect(
      await run(`
        const AT_INIT: number = 1 + 1;
        export function atInit(): number { return AT_INIT; }
        export function test(): number { return 2; }
      `),
    ).toEqual({ atInit: 2, afterInit: 2 });
  });
});
