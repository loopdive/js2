// #1464 — Iterator.prototype helpers + Iterator.zip / Iterator.concat (ES2025)
//
// Extends #1367 (Iterator.prototype bridge for synthesized iterators / generators)
// with positive + abrupt-completion coverage of the helper methods, plus the
// ES2025 static helpers `Iterator.zip` and `Iterator.concat` which route
// through `__extern_method_call` against the JS host's real `Iterator` global.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(src: string): Promise<WebAssembly.Exports> {
  const r = await compile(src);
  if (!r.success) throw new Error("compile failed: " + JSON.stringify(r.errors));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const m = await WebAssembly.instantiate(r.binary, imports);
  const setExports = (imports as any).setExports;
  if (typeof setExports === "function") setExports(m.instance.exports);
  return m.instance.exports;
}

// The compiler installs Iterator.zip / Iterator.concat polyfills via
// `_installIteratorHelperPolyfills` inside `buildImports`, so these tests run
// on any host with `Iterator.prototype` — not just newer V8 builds. The probe
// only ensures we have a base `Iterator` global.
const hostHasIterator = typeof (globalThis as any).Iterator === "function";

describe("#1464 — Iterator.prototype helpers + Iterator.zip / Iterator.concat", () => {
  it("array iterator filter() then toArray() returns matching values", async () => {
    const ex = await instantiate(`
      export function main(): number {
        const arr = [1, 2, 3, 4, 5] as any[];
        const it = arr[Symbol.iterator]();
        const evens = (it as any).filter((x: number) => x % 2 === 0);
        const out = evens.toArray();
        return out.length;
      }
    `);
    expect((ex.main as () => number)()).toBe(2);
  });

  it("generator forEach() invokes callback for each value", async () => {
    const ex = await instantiate(`
      function* g(): Generator<number> { yield 1; yield 2; yield 3; }
      export function main(): number {
        const it = g() as any;
        let sum = 0;
        (it as any).forEach((x: number) => { sum += x; });
        return sum;
      }
    `);
    expect((ex.main as () => number)()).toBe(6);
  });

  it("generator reduce() folds across values", async () => {
    const ex = await instantiate(`
      function* g(): Generator<number> { yield 1; yield 2; yield 3; yield 4; }
      export function main(): number {
        const it = g() as any;
        return (it as any).reduce((acc: number, x: number) => acc + x, 0);
      }
    `);
    expect((ex.main as () => number)()).toBe(10);
  });

  it("generator flatMap() flattens nested generator iterables", async () => {
    // The callback returns a generator iterator (not a wasm vec) — generators
    // inherit from Iterator.prototype and present cleanly to the host's
    // flatMap. (Wasm-vec callbacks intersect #1382's host-callability gap and
    // are out of scope here.)
    const ex = await instantiate(`
      function* g(): Generator<number> { yield 1; yield 2; yield 3; }
      function* inner(x: number): Generator<number> { yield x; yield x * 10; }
      export function main(): number {
        const it = g() as any;
        const flat = (it as any).flatMap((x: number) => inner(x));
        let count = 0;
        for (const _ of flat) count++;
        return count;
      }
    `);
    expect((ex.main as () => number)()).toBe(6);
  });

  it("array iterator filter() with non-callable arg throws TypeError (arg validation)", async () => {
    const ex = await instantiate(`
      export function main(): number {
        const arr = [1, 2, 3] as any[];
        const it = arr[Symbol.iterator]();
        try {
          (it as any).filter(null);
          return 0;
        } catch (e: any) {
          if (e && e.constructor && e.constructor.name === "TypeError") return 1;
          return 2;
        }
      }
    `);
    expect((ex.main as () => number)()).toBe(1);
  });

  it("generator map() with non-callable arg throws TypeError (abrupt completion)", async () => {
    const ex = await instantiate(`
      function* g(): Generator<number> { yield 1; yield 2; }
      export function main(): number {
        const it = g() as any;
        try {
          (it as any).map(123);
          return 0;
        } catch (e: any) {
          if (e && e.constructor && e.constructor.name === "TypeError") return 1;
          return 2;
        }
      }
    `);
    expect((ex.main as () => number)()).toBe(1);
  });

  it.skipIf(!hostHasIterator)("Iterator.zip combines parallel iterables into tuples", async () => {
    const ex = await instantiate(`
      declare const Iterator: any;
      export function main(): number {
        const zipped = Iterator.zip([[1, 2, 3], [10, 20, 30]]);
        let count = 0;
        for (const _pair of zipped) count++;
        return count;
      }
    `);
    expect((ex.main as () => number)()).toBe(3);
  });

  it.skipIf(!hostHasIterator)("Iterator.concat joins multiple iterables", async () => {
    const ex = await instantiate(`
      declare const Iterator: any;
      export function main(): number {
        const joined = Iterator.concat([1, 2], [3, 4, 5]);
        let count = 0;
        for (const _ of joined) count++;
        return count;
      }
    `);
    expect((ex.main as () => number)()).toBe(5);
  });

  it.skipIf(!hostHasIterator)("Iterator.zip with non-iterable element throws TypeError", async () => {
    const ex = await instantiate(`
      declare const Iterator: any;
      export function main(): number {
        try {
          // Iterators key 'mode: \\"strict\\"' would also throw on length mismatch;
          // here we just confirm a non-iterable triggers the spec's GetIteratorFlattenable.
          const it = Iterator.zip([null]);
          // For lazy implementations the throw might be deferred to next() — drive once.
          it.next();
          return 0;
        } catch (e: any) {
          if (e && e.constructor && e.constructor.name === "TypeError") return 1;
          return 2;
        }
      }
    `);
    // Either spec position is acceptable — we only assert "a TypeError surfaces".
    expect((ex.main as () => number)()).toBe(1);
  });

  it("generator chained map(f).filter(g).toArray() preserves order and predicate", async () => {
    const ex = await instantiate(`
      function* g(): Generator<number> {
        yield 1; yield 2; yield 3; yield 4; yield 5;
      }
      export function main(): number {
        const it = g() as any;
        const doubledEvens = (it as any).map((x: number) => x * 2).filter((x: number) => x > 4);
        const out = doubledEvens.toArray();
        // map: 2 4 6 8 10 — filter (>4): 6 8 10 — length 3, sum 24.
        let sum = 0;
        for (let i = 0; i < out.length; i++) sum += out[i];
        return sum;
      }
    `);
    expect((ex.main as () => number)()).toBe(24);
  });
});
