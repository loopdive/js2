// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1681 — Static private accessor reached through an inner closure.
 *
 * Accessing a static private getter/setter via `this.#x` from inside an arrow
 * function (or other closure) spawned in a static method previously emitted
 * invalid Wasm (`extern.convert_any` expecting anyref, found externref) or
 * re-entered the accessor trampoline. The captured `this` is the class
 * constructor (an externref-backed module global), so the generic struct path
 * mis-lowered it. The fix routes `this.#accessor` to the static-global accessor
 * path whenever the function is in a static context (`fctx.isStaticContext`),
 * not only when `this` is absent from the local map.
 *
 * These tests pin the GETTER value path: a static private getter reached
 * through an inner arrow / nested arrow compiles to valid Wasm and returns the
 * correct value. The fix marks static accessor bodies (`isStaticContext` +
 * `enclosingClassName` in class-bodies.ts) and routes `this.#getter` through
 * the static-global accessor path whenever the function is in a static context
 * (`fctx.isStaticContext` in property-access.ts), not only when `this` is
 * absent from the local map.
 *
 * Out of scope here (tracked as #1680-blocked follow-up):
 *   - Static private SETTER write via inner closure: the setter body mutates
 *     `this` (the class constructor), so it needs the real class-object
 *     receiver — the static dispatch can't use a dummy receiver. This is the
 *     same real-receiver dispatch gap as the private-setter work in #1680.
 *   - The spec PrivateBrandCheck (throwing TypeError when `this` is not the
 *     declaring class) — shared static-private brand-check gap (#1680/#1365).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#1681 static private accessor via inner closure", () => {
  it("static private getter read via inner arrow function", async () => {
    expect(
      await run(
        `class C {
           static get #f() { return 'Test262'; }
           static access() { const a = () => this.#f; return a(); }
         }
         export function test() { return C.access() === 'Test262' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("direct static private getter access still works (no regression)", async () => {
    expect(
      await run(
        `class C {
           static get #f() { return 'X'; }
           static access() { return this.#f; }
         }
         export function test() { return C.access() === 'X' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("static private getter via deeply nested arrow", async () => {
    expect(
      await run(
        `class C {
           static get #f() { return 42; }
           static access() { const a = () => { const b = () => this.#f; return b(); }; return a(); }
         }
         export function test() { return C.access(); }`,
      ),
    ).toBe(42);
  });
});
