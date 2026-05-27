// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1592 — Array binding pattern elision holes and rest must consume
 * exactly the spec-mandated number of iterator steps (§8.5.3
 * IteratorBindingInitialization). Eager materialization via __array_from_iter
 * over-drained lazy generators, so a later binding read a one-ahead value or
 * the iterator came back null. Fixed by bounded __array_from_iter_n(obj, n).
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  return (exports.test as () => unknown)();
}

describe("#1592 — array pattern iterator step count", () => {
  it("single elision [,] consumes exactly one step", async () => {
    expect(
      await runWasm(`
        function* g(){ yield 1; yield 2; }
        export function test(): number {
          const it = g();
          const [,] = it;
          return it.next().value as number; // 2 if only one step consumed
        }`),
    ).toBe(2);
  });

  it("gap [a,,b] reads positions 0 and 2", async () => {
    expect(
      await runWasm(`
        function* g(){ yield 10; yield 20; yield 30; yield 40; }
        export function test(): number {
          const [a,,b] = g();
          return (a as number) + (b as number); // 10 + 30 = 40
        }`),
    ).toBe(40);
  });

  it("rest [...r] collects the full remainder", async () => {
    expect(
      await runWasm(`
        function* g(){ yield 1; yield 2; yield 3; }
        export function test(): number {
          const [...r] = g();
          return r.length;
        }`),
    ).toBe(3);
  });

  it("[a, ...r] leaves remainder after first step", async () => {
    expect(
      await runWasm(`
        function* g(){ yield 1; yield 2; yield 3; }
        export function test(): number {
          const [a, ...r] = g();
          return (a as number) * 100 + r.length; // 1*100 + 2 = 102
        }`),
    ).toBe(102);
  });

  it("trailing elision [a,,] still steps the elided slot", async () => {
    // §8.5.3: a trailing elision performs IteratorStep, so the iterator is
    // advanced past element index 1 even though nothing is bound there.
    expect(
      await runWasm(`
        function* g(){ yield 5; yield 6; yield 7; }
        export function test(): number {
          const it = g();
          const [a,,] = it;
          return (a as number) * 100 + (it.next().value as number); // 5*100 + 7 = 507
        }`),
    ).toBe(507);
  });

  it("array assignment pattern [a,,b] = gen() consumes exactly 3 steps", async () => {
    expect(
      await runWasm(`
        function* g(){ yield 1; yield 2; yield 3; yield 4; }
        export function test(): number {
          let a = 0, b = 0;
          const it = g();
          [a,,b] = it;
          return a * 1000 + b * 10 + (it.next().value as number); // 1000 + 30 + 4 = 1034
        }`),
    ).toBe(1034);
  });

  it("closes the iterator when a no-rest pattern ends before done (§8.5.3)", async () => {
    // For a no-rest pattern [a,b] over a still-yielding iterator, the spec
    // calls IteratorClose after the last element (iteratorRecord.[[Done]] is
    // false), so the generator's finally runs. Bounded materialization stops
    // at the pattern length, then the surrounding loop closes — matching
    // native JS (verified: closed === 1).
    expect(
      await runWasm(`
        let closed = 0;
        function* g(){ try { yield 1; yield 2; yield 3; } finally { closed = 1; } }
        export function test(): number {
          const [a, b] = g(); // 2 steps consumed, iterator not done → closed
          return (a as number) + (b as number) + closed * 100; // 1+2+100 = 103
        }`),
    ).toBe(103);
  });

  it("rest pattern drains to completion via the unbounded path", async () => {
    // [a, ...r] passes n = -1 → unbounded, byte-identical to the legacy
    // __array_from_iter drain. The generator runs to natural done (its finally
    // fires on completion), r collects the remainder (verified vs native JS).
    expect(
      await runWasm(`
        let closed = 0;
        function* g(){ try { yield 1; yield 2; } finally { closed = 1; } }
        export function test(): number {
          const [a, ...r] = g();
          return (a as number) + r.length + closed * 100; // 1 + 1 + 100 = 102
        }`),
    ).toBe(102);
  });
});
