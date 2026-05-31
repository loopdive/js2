// Regression test for #1589 hot spot B: for-loop with `var i` captured by
// closures inside the body would compile to a loop that reads the unboxed `i`
// slot for the condition while writing through the boxed cell for the
// increment, causing an infinite loop at runtime. Manifested as a compile
// timeout in test262 because the test wrapper times out the whole pipeline.
//
// Repro mirrors test262's
// `built-ins/Array/prototype/toSorted/comparefn-not-a-function.js`:
// a `for (var i = 0; i < ...; i++)` loop containing closures (here, the
// `function() { ... }` expressions passed to a helper) that capture `i`.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("compile failed: " + r.errors?.[0]?.message);
  const imports = buildImports((r as any).imports ?? [], undefined, (r as any).stringPool ?? []);
  const { instance } = await WebAssembly.instantiate(r.binary!, imports);
  return (instance.exports as any).test?.();
}

describe("#1589 — for-loop with closure-captured var increments correctly", () => {
  it("var i incremented inside body terminates loop (basic)", async () => {
    const out = await compileAndRun(`
      export function test(): number {
        var arr = [10, 20, 30];
        var f: any = null;
        for (var i = 0; i < arr.length; i++) {
          f = function () { return i; };
        }
        return i;
      }
    `);
    expect(out).toBe(3);
  });

  it("var i captured by closures inside body terminates", async () => {
    // Closures inside the body capture `i`. Without the fix, the loop spins
    // forever because the condition reads an unboxed slot that never updates.
    const out = await compileAndRun(`
      export function test(): number {
        var arr = [1, 2, 3, 4, 5];
        var calls = 0;
        for (var i = 0; i < arr.length; i++) {
          var fn = function () { return arr[i]; };
          calls += 1;
          fn();
        }
        return calls;
      }
    `);
    expect(out).toBe(5);
  });

  it("nested closures inside for-var loop body — both read i correctly", async () => {
    // Mirrors the test262 pattern: two assert.throws-style closures per
    // iteration, both capturing i.
    const out = await compileAndRun(`
      export function test(): number {
        var items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        var hits = 0;
        for (var i = 0; i < items.length; i++) {
          var a = function () { return items[i]; };
          var b = function () { return items[i] + 1; };
          if (a() === items[i]) hits += 1;
          if (b() === items[i] + 1) hits += 1;
        }
        return hits;
      }
    `);
    expect(out).toBe(20);
  });
});
