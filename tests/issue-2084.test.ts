// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2084 — a property WRITE to a null receiver trapped uncatchably instead of
// throwing a catchable TypeError.
//
// Module objects live in `(ref null $T)` mutable globals. The member-READ path
// already threw a catchable `TypeError` on a null receiver, but the member-WRITE
// path (`compilePropertyAssignmentForStruct`) emitted `struct.set` directly — a
// null receiver then trapped with an uncatchable "dereferencing a null pointer"
// Wasm error (error-model divergence, family #581/#2025).
//
// Fix: null-guard the struct write — throw the catchable TypeError on null,
// otherwise perform the set. The guard is skipped when the receiver is provably
// non-null (`new Foo()`, `this`, a non-nullable `ref`), so normal writes keep
// their direct `struct.set`.

import { describe, expect, it } from "vitest";

import { compileAndInstantiate } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const exports = (await compileAndInstantiate(src)) as { test(): number };
  return exports.test();
}

describe("#2084 property write null-guard (catchable TypeError, not a trap)", () => {
  it("writing to a null module-global receiver throws a CATCHABLE TypeError", async () => {
    // If the write trapped uncatchably the module would throw out of `test()`
    // and this would reject; the `catch` proves the throw is a catchable Wasm
    // exception.
    expect(
      await run(`
        let o: { x: number } | null = null;
        export function test(): number {
          try { o!.x = 42; return -1; } catch (e: any) { return 7; }
        }`),
    ).toBe(7);
  });

  it("normal writes to a non-null receiver are unaffected", async () => {
    expect(
      await run(`
        let o: { x: number } = { x: 1 };
        export function test(): number { o.x = 42; return o.x; }`),
    ).toBe(42);
  });

  it("class instance field write works", async () => {
    expect(
      await run(`
        class A { x = 1; }
        const a = new A();
        export function test(): number { a.x = 5; return a.x; }`),
    ).toBe(5);
  });

  it("compound assignment and nested writes are unaffected", async () => {
    expect(
      await run(`
        export function test(): number { const o = { x: 10 }; o.x += 5; return o.x; }`),
    ).toBe(15);
    expect(
      await run(`
        const o = { inner: { y: 1 } };
        export function test(): number { o.inner.y = 3; return o.inner.y; }`),
    ).toBe(3);
  });
});
