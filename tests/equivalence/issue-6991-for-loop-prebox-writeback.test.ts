// #6991 — a C-style `for` loop pre-boxed a closure-captured outer binding into
// a ref cell and, after the loop, copied the cell back into the raw slot and
// re-aimed the frame at it. One binding, two stores: closure writes made after
// the loop were lost, and frame writes after the loop were invisible to the
// closures. `for` now keeps the cell function-wide like while/do/for-of (#6960).
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

async function expectSameOnBothLanes(src: string): Promise<void> {
  const expected = evaluateAsJs(src).test!();
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "gc";
    const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

describe("#6991 for-loop pre-box keeps one store for a captured binding", () => {
  it("closure writes made after the loop reach the frame (let i head)", async () => {
    await expectSameOnBothLanes(`
      export function test(): number {
        let total = 0; const fs: (() => void)[] = [];
        for (let i = 1; i <= 3; i++) fs.push(() => { total += i; });
        for (const f of fs) f();
        return total;
      }
    `);
  });

  it("frame writes made after the loop reach the closures", async () => {
    await expectSameOnBothLanes(`
      export function test(): number {
        let base = 100; const fs: (() => number)[] = [];
        for (let i = 1; i <= 3; i++) fs.push(() => base + i);
        base = 200;
        return fs[0]!();
      }
    `);
  });

  it("a cache variable assigned by a closure after the loop updates", async () => {
    await expectSameOnBothLanes(`
      export function test(): number {
        let cache = 0; const fs: (() => void)[] = [];
        for (let i = 1; i <= 3; i++) fs.push(() => { cache = i * 10; });
        fs[1]!();
        return cache;
      }
    `);
  });

  it("for (var i ...) behaves the same", async () => {
    await expectSameOnBothLanes(`
      export function test(): number {
        let total = 0; const fs: (() => void)[] = [];
        for (var i = 1; i <= 3; i++) fs.push(() => { total += i; });
        for (const f of fs) f();
        return total;
      }
    `);
  });

  it("head-less for (; i < 3; i++) behaves the same", async () => {
    await expectSameOnBothLanes(`
      export function test(): number {
        let total = 0; let i = 0; const fs: (() => void)[] = [];
        for (; i < 3; i++) fs.push(() => { total += i + 1; });
        for (const f of fs) f();
        return total;
      }
    `);
  });

  it("an induction variable written by the loop and after it is shared with the closures", async () => {
    await expectSameOnBothLanes(`
      export function test(): number {
        let k = 0; const fs: (() => number)[] = [];
        for (; k < 3; k++) fs.push(() => k);
        k = 50;
        return fs[0]!() + k;
      }
    `);
  });

  it("a loop that never runs leaves the binding usable (null-cell repair path)", async () => {
    await expectSameOnBothLanes(`
      export function test(): number {
        let total = 5; const fs: (() => void)[] = []; const n = 0;
        for (let i = 1; i <= n; i++) fs.push(() => { total += i; });
        total += 1;
        for (const f of fs) f();
        return total;
      }
    `);
  });

  it("a string binding written by closures built in a for loop", async () => {
    await expectSameOnBothLanes(`
      export function test(): number {
        let s = ""; const fs: (() => void)[] = [];
        for (let i = 0; i < 3; i++) fs.push(() => { s += "ab"; });
        for (const f of fs) f();
        s += "c";
        return s.length;
      }
    `);
  });
});
