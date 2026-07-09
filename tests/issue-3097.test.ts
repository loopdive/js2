// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3097 — compiled ArrayBuffer → host TypedArray ctor boundary (JS-host / gc lane).
 *
 * `new ArrayBuffer(n)` lowers to a native i32_byte vec struct. When that struct
 * crossed the construct bridge as a `new TA(buffer, offset, length)` ctor arg,
 * V8 saw an opaque non-buffer object and built a LENGTH-0 array-like view (the
 * static host-lane `new Int8Array(buf)` fell through to the numeric-length branch
 * — `ToNumber(struct)` → NaN → 0). The fix marshals the compiled-AB vec struct to
 * a canonical, identity-cached host ArrayBuffer at the bridge, so:
 *   - `new TA(buffer, offset, length)` builds the correct windowed host view,
 *   - sibling views over one compiled buffer share bytes (aliasing), and
 *   - `view.buffer === buffer` identity holds (exit-boundary un-marshal).
 *
 * Exercised via `compileAndInstantiate` (the real-host-globalThis lane) — the
 * TypedArray ctor resolves through `__get_globalThis()[name]`, matching the
 * non-sandbox CI conformance path.
 */
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const exports = (await compileAndInstantiate(src)) as { main?: () => unknown };
  return exports.main?.();
}

describe("#3097 compiled ArrayBuffer → host TypedArray ctor boundary", () => {
  it("static new Int8Array(buffer) views the full buffer length", async () => {
    expect(
      await run(`export function main(): number {
        var b = new ArrayBuffer(8);
        var s = new Int8Array(b);
        return s.length;
      }`),
    ).toBe(8);
  });

  it("static new Int8Array(buffer, offset, length) builds the windowed view", async () => {
    expect(
      await run(`export function main(): number {
        var b = new ArrayBuffer(64);
        var s = new Int8Array(b, 0, 4);
        return s.length;
      }`),
    ).toBe(4);
  });

  it("windowed view reports the correct byteLength", async () => {
    expect(
      await run(`export function main(): number {
        var b = new ArrayBuffer(64);
        var s = new Int8Array(b, 0, 4);
        return s.byteLength;
      }`),
    ).toBe(4);
  });

  it("sibling static views over one buffer share bytes", async () => {
    expect(
      await run(`export function main(): number {
        var b = new ArrayBuffer(8);
        var a = new Int8Array(b);
        var c = new Int8Array(b);
        a[0] = 42;
        return c[0];
      }`),
    ).toBe(42);
  });

  it("view.buffer === buffer identity holds (static)", async () => {
    expect(
      await run(`export function main(): number {
        var b = new ArrayBuffer(8);
        var s = new Int8Array(b);
        return ((s as any).buffer === (b as any)) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("dynamic new TA(buffer, offset, length) through the harness ctor-value shape", async () => {
    expect(
      await run(`function withCtor(f: any) { f(Int8Array); }
        export function main(): number {
          var b = new ArrayBuffer(64);
          var out = -1;
          withCtor(function (TA: any) { var s = new TA(b, 0, 4); out = s.length; });
          return out;
        }`),
    ).toBe(4);
  });

  it("dynamic sibling views over one buffer share bytes (reverts.js aliasing shape)", async () => {
    expect(
      await run(`function withCtor(f: any) { f(Int8Array); }
        export function main(): number {
          var b = new ArrayBuffer(8);
          var out = 0;
          withCtor(function (TA: any) {
            var sample = new TA(b, 0, 4);
            var other = new TA(b);
            sample[0] = 1; sample[1] = 2; sample[2] = 3; sample[3] = 4;
            sample.reverse();
            out = (other[0] === 4 && other[1] === 3 && other[2] === 2 && other[3] === 1) ? 1 : 0;
          });
          return out;
        }`),
    ).toBe(1);
  });

  it("re-crossing view.buffer canonicalizes to the same host buffer (aliases)", async () => {
    expect(
      await run(`function withCtor(f: any) { f(Int8Array); }
        export function main(): number {
          var b = new ArrayBuffer(8);
          var out = 0;
          withCtor(function (TA: any) {
            var sample = new TA(b);
            var again = new TA(sample.buffer);
            sample[0] = 7;
            out = (again[0] === 7) ? 1 : 0;
          });
          return out;
        }`),
    ).toBe(1);
  });

  it("host TypedArray methods (set / subarray) work over the marshaled buffer", async () => {
    expect(
      await run(`function withCtor(f: any) { f(Int8Array); }
        export function main(): number {
          var b = new ArrayBuffer(8);
          var out = -1;
          withCtor(function (TA: any) {
            var s = new TA(b);
            s.set([5, 6], 2);
            out = s.subarray(2, 4)[0];
          });
          return out;
        }`),
    ).toBe(5);
  });
});
