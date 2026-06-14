// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2015 — a method call using `this` on an any-typed object-literal receiver
// threw a bare WebAssembly.Exception.
//
// `const o: any = { x: 21, getx() { return this.x; } }; o.getx()` dispatches
// through the JS host (`__extern_method_call` for a 0-arg call, or the
// `_wrapForHost` proxy `get` trap's generic closureBridge fallback for the
// callable-field read). That bridge invoked the compiled method via the plain
// `__call_fn_N` dispatcher, which never installs `__current_this`; the
// object-literal method trampoline then forwarded a NULL receiver struct, so
// `this.<field>` (a `struct.get` on null) trapped.
//
// Two coordinated fixes:
//   - runtime: the closureBridge / dynamic-bridge dispatch through
//     `__call_fn_method_N` (unwrapping the host-mirror proxy to the raw
//     struct) when invoked with a real receiver, preserving the plain path
//     for unbound extraction calls (`const f = o.m; f()`).
//   - codegen: the object-method trampoline reads `__current_this` for its
//     `this` slot (cast to the object struct, null fallback) instead of a
//     hardcoded `ref.null`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2015 — any-receiver object-literal method this-threading", () => {
  it("reads this.<field> on an any-typed receiver (the repro)", async () => {
    expect(
      await run(`const o: any = { x: 21, getx() { return this.x; } };
        export function test(): number { return o.getx(); }`),
    ).toBe(21);
  });

  it("typed-receiver method call is unchanged", async () => {
    expect(
      await run(`const o = { x: 21, getx() { return this.x; } };
        export function test(): number { return o.getx(); }`),
    ).toBe(21);
  });

  it("a method that does not read this is unchanged", async () => {
    expect(
      await run(`const o: any = { getx() { return 5; } };
        export function test(): number { return o.getx(); }`),
    ).toBe(5);
  });

  it("threads this through a one-argument method (this.x + n)", async () => {
    expect(
      await run(`const o: any = { x: 21, addNum(n: number) { return this.x + n; } };
        export function test(): number { return o.addNum(4); }`),
    ).toBe(25);
  });

  it("threads this through a two-argument method", async () => {
    expect(
      await run(`const o: any = { base: 10, combine(a: number, b: number) { return this.base + a + b; } };
        export function test(): number { return o.combine(2, 3); }`),
    ).toBe(15);
  });

  it("mutates this.<field> across successive method calls", async () => {
    expect(
      await run(`const o: any = { x: 21, inc() { this.x = this.x + 1; return this.x; } };
        export function test(): number { o.inc(); return o.inc(); }`),
    ).toBe(23);
  });

  it("threads this through a nested method-to-method call", async () => {
    expect(
      await run(`const o: any = {
          x: 10,
          getx() { return this.x; },
          both() { return this.getx() + this.x; }
        };
        export function test(): number { return o.both(); }`),
    ).toBe(20);
  });
});
