// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, compileAndInstantiate } from "../src/runtime.js";

// #3058 — resizable ArrayBuffer + length-tracking TypedArray views in the
// JS-HOST lane. The standalone lane got the `$__resizable_ab` machinery in
// #3054-C; this slice extends it to the host lane:
//   - `new ArrayBuffer(n, {maxByteLength})` allocates `$__resizable_ab` in
//     BOTH lanes (construct un-gate, new-super.ts);
//   - `__rab_resize` / `__ab_max_len` helper exports (index.ts) let the JS
//     runtime resize the struct + read the resizable metadata;
//   - runtime arms in `__extern_method_call` / `__extern_get` implement
//     `resize` (§25.1.6.4 spec-ordered errors), `maxByteLength`, `resizable`,
//     and `resize`-as-value;
//   - `_compiledAbToHostBuffer` (#3097 marshal) mints a HOST resizable
//     ArrayBuffer, so host TypedArray/DataView views built over the compiled
//     buffer length-track a later `rab.resize()` natively (V8 semantics).
//
// All host-lane: compileAndInstantiate runs in the main realm (genuine TA
// constructors — the test262 runner's vm sandbox lacks them, so the runner's
// local numbers under-report; these tests are the sandbox-independent gate).

async function run<T>(src: string): Promise<T> {
  const exports = await compileAndInstantiate(src);
  return (exports as { f: () => T }).f();
}

// (#6779) `compileAndInstantiate` uses the library's `deny` dynamic-code
// default; the `new Function` carve-out case needs the hostEval policy.
async function runHostEval<T>(src: string): Promise<T> {
  const r = await compile(src);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(r, undefined, { dynamicCode: "hostEval" });
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  imports.setInstance?.(instance);
  return (instance.exports as { f: () => T }).f();
}

describe("#3058 host-lane resizable ArrayBuffer", () => {
  describe("construction + metadata", () => {
    it("resize + byteLength", async () => {
      expect(
        await run(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          b.resize(12);
          return b.byteLength;
        }`),
      ).toBe(12);
    });

    it("maxByteLength on a resizable buffer", async () => {
      expect(
        await run(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          return b.maxByteLength;
        }`),
      ).toBe(16);
    });

    it("maxByteLength on a fixed buffer === byteLength (§25.1.5.4)", async () => {
      expect(
        await run(`export function f(): number {
          const b = new ArrayBuffer(8);
          return b.maxByteLength;
        }`),
      ).toBe(8);
    });

    it("resizable is true/false by construction", async () => {
      expect(
        await run(`export function f(): number {
          const r = new ArrayBuffer(8, { maxByteLength: 16 });
          const x = new ArrayBuffer(8);
          return (r.resizable ? 1 : 0) * 10 + (x.resizable ? 1 : 0);
        }`),
      ).toBe(10);
    });

    it("typeof ab.resize is 'function' (resize read as a value)", async () => {
      // NOTE: `new ab.resize()` SHOULD throw TypeError (the arm returns an
      // arrow function, non-constructible), but the dynamic-new no-match base
      // does not run the IsConstructor probe for a property-access callee — a
      // pre-existing gap (resize/nonconstructor.js), out of scope here.
      expect(
        await run(`export function f(): string {
          const ab: any = new ArrayBuffer(4, { maxByteLength: 5 });
          return typeof ab.resize;
        }`),
      ).toBe("function");
    });
  });

  describe("resize error semantics (§25.1.6.4 order)", () => {
    it("TypeError on a fixed (non-resizable) buffer", async () => {
      expect(
        await run(`export function f(): string {
          const b: any = new ArrayBuffer(8);
          try { b.resize(4); return "no-throw"; }
          catch (e) { return e instanceof TypeError ? "TypeError" : "other"; }
        }`),
      ).toBe("TypeError");
    });

    it("RangeError beyond maxByteLength", async () => {
      expect(
        await run(`export function f(): string {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          try { b.resize(17); return "no-throw"; }
          catch (e) { return e instanceof RangeError ? "RangeError" : "other"; }
        }`),
      ).toBe("RangeError");
    });

    it("RangeError on negative length", async () => {
      expect(
        await run(`export function f(): string {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          try { b.resize(-1); return "no-throw"; }
          catch (e) { return e instanceof RangeError ? "RangeError" : "other"; }
        }`),
      ).toBe("RangeError");
    });

    it("resize() with no arg → ToIndex(undefined) = 0", async () => {
      expect(
        await run(`export function f(): number {
          const b: any = new ArrayBuffer(8, { maxByteLength: 16 });
          b.resize();
          return b.byteLength;
        }`),
      ).toBe(0);
    });

    it("resize returns undefined", async () => {
      expect(
        await run(`export function f(): string {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          return typeof b.resize(4);
        }`),
      ).toBe("undefined");
    });

    it("any-typed receiver (harness CollectValuesAndResize shape)", async () => {
      expect(
        await run(`function doResize(rab: any, n: any): void { rab.resize(n); }
        export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          doResize(b, 12);
          return b.byteLength;
        }`),
      ).toBe(12);
    });
  });

  describe("length-tracking host TypedArray views", () => {
    it("auto-length view tracks grow and shrink", async () => {
      expect(
        await run(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          const ta = new Uint8Array(b);
          b.resize(12);
          const grown = ta.length;
          b.resize(4);
          return grown * 100 + ta.length;
        }`),
      ).toBe(1204);
    });

    it("element write/read through the grown region", async () => {
      expect(
        await run(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          const ta = new Uint8Array(b);
          b.resize(12);
          ta[10] = 42;
          return ta[10];
        }`),
      ).toBe(42);
    });

    it("fixed-window view goes out of bounds after shrink (length 0)", async () => {
      expect(
        await run(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          const ta = new Uint8Array(b, 0, 8);
          b.resize(4);
          return ta.length;
        }`),
      ).toBe(0);
    });

    it("shrink-then-regrow zero-fills the regrown region (spec)", async () => {
      expect(
        await run(`export function f(): number {
          const b = new ArrayBuffer(8, { maxByteLength: 16 });
          const ta = new Uint8Array(b);
          ta[7] = 99;
          b.resize(4);
          b.resize(8);
          return ta[7];
        }`),
      ).toBe(0);
    });

    it("dynamic ctor construct (CreateRabForTest shape): write, resize, track", async () => {
      expect(
        await run(`export function f(): number {
          const ctors: any[] = [Uint8Array, Int16Array];
          let total = 0;
          for (const ctor of ctors) {
            const rab = new ArrayBuffer(4 * ctor.BYTES_PER_ELEMENT, { maxByteLength: 8 * ctor.BYTES_PER_ELEMENT });
            const taWrite = new ctor(rab);
            for (let i = 0; i < 4; ++i) taWrite[i] = 2 * i;
            rab.resize(6 * ctor.BYTES_PER_ELEMENT);
            total += taWrite.length * 10 + taWrite[3];
          }
          return total; // 2 ctors × (60 + 6)
        }`),
      ).toBe(132);
    });

    it("ta.at(-1) over shrunk fixed view throws TypeError; tracking view follows", async () => {
      // Views built through the DYNAMIC ctor route (the shape every
      // */resizable-buffer.js file uses). The STATIC `new Uint8Array(rab,0,4)`
      // route has a pre-existing method-dispatch gap (`.at` ref.cast-traps on
      // the host-TA externref — #3097 follow-up), unrelated to resize.
      expect(
        await run(`export function f(): string {
          const ctor: any = Uint8Array;
          const rab = new ArrayBuffer(4, { maxByteLength: 8 });
          const fixed = new ctor(rab, 0, 4);
          const tracking = new ctor(rab, 0);
          for (let i = 0; i < 4; ++i) tracking[i] = i;
          rab.resize(3);
          let oob = "no";
          try { fixed.at(-1); } catch (e) { oob = e instanceof TypeError ? "TypeError" : "other"; }
          return oob + "/" + tracking.at(-1);
        }`),
      ).toBe("TypeError/2");
    });
  });

  describe("#2960 new Function class-carrying body (harness subClass shape)", () => {
    it("returns a genuine host class extending a builtin", async () => {
      expect(
        await runHostEval(`function subClass(type: any): any {
          try {
            return new Function('return class My' + type + ' extends ' + type + ' {}')();
          } catch (e) {}
        }
        export function f(): string {
          const MyUint8Array = subClass('Uint8Array');
          const rab: any = new ArrayBuffer(8, { maxByteLength: 16 });
          const ta = new MyUint8Array(rab);
          ta[2] = 7;
          rab.resize(12);
          return typeof MyUint8Array + "/" + MyUint8Array.BYTES_PER_ELEMENT + "/" + ta.length + "/" + ta[2];
        }`),
      ).toBe("function/1/12/7");
    });
  });

  describe("byte-inertness", () => {
    it("a module without resizable buffers emits no __rab_resize/__ab_max_len exports", async () => {
      const r = await compile(
        `export function f(): number {
          const b = new ArrayBuffer(16);
          const ta = new Uint8Array(b, 0, 8);
          return b.byteLength + ta.length;
        }`,
        {},
      );
      expect(r.success).toBe(true);
      const mod = new WebAssembly.Module(r.binary);
      const names = WebAssembly.Module.exports(mod).map((e) => e.name);
      expect(names).not.toContain("__rab_resize");
      expect(names).not.toContain("__ab_max_len");
    });

    it("a resizable module emits both helper exports (host lane only)", async () => {
      const src = `export function f(): number {
        const b = new ArrayBuffer(8, { maxByteLength: 16 });
        b.resize(12);
        return b.byteLength;
      }`;
      const host = await compile(src, {});
      expect(host.success).toBe(true);
      const hostNames = WebAssembly.Module.exports(new WebAssembly.Module(host.binary)).map((e) => e.name);
      expect(hostNames).toContain("__rab_resize");
      expect(hostNames).toContain("__ab_max_len");
      const standalone = await compile(src, { target: "standalone" });
      expect(standalone.success).toBe(true);
      const saNames = WebAssembly.Module.exports(new WebAssembly.Module(standalone.binary)).map((e) => e.name);
      expect(saNames).not.toContain("__rab_resize");
      expect(saNames).not.toContain("__ab_max_len");
    });
  });
});
