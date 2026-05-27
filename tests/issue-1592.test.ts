import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as () => number)();
}

describe("#1592 array pattern elision/rest bounded iterator consumption", () => {
  // Param-context elision: `[a,,b]` parameter pattern over a lazy generator.
  // The bounded helper steps it exactly 3 times (no rest) and binds the 1st/3rd
  // yields to a/b. This is the dominant shape of the ~305 test262 bucket.
  it("param [a,,b] from a generator binds 0 and 2", async () => {
    const src = `
      function m([a, , b]: number[] = g()): number {
        return a === 10 && b === 30 ? 1 : a * 100 + b;
      }
      function* g() { yield 10; yield 20; yield 30; yield 40; }
      export function test(): number { return m(); }
    `;
    expect(await run(src)).toBe(1);
  });

  // Param-context rest-with-nested-elision `[...[,]] = g()` must drain the
  // generator fully (rest → unbounded, -1 sentinel — byte-identical to the
  // legacy path). Mirrors test262 meth-dflt-ary-ptrn-rest-ary-elision.
  it("param [...[,]] = g() drains the generator fully (rest is unbounded)", async () => {
    const src = `
      let first = 0;
      let second = 0;
      function* g() { first += 1; yield 1; second += 1; yield 2; }
      function m([...[,]]: number[] = g()): number {
        return first === 1 && second === 1 ? 1 : first * 10 + second;
      }
      export function test(): number { return m(); }
    `;
    expect(await run(src)).toBe(1);
  });

  // Declaration elision binds the right values (1st/3rd yields).
  it("decl [a,,b] from a generator binds 0 and 2", async () => {
    const src = `
      export function test(): number {
        function* g() { yield 10; yield 20; yield 30; yield 40; }
        const [a, , b] = g();
        if (a !== 10) return 100 + a;
        if (b !== 30) return 200 + b;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  // Rest pattern collects ALL remaining values (unbounded, -1 sentinel path).
  it("[first, ...rest] collects the full remainder", async () => {
    const src = `
      export function test(): number {
        function* g() { yield 1; yield 2; yield 3; yield 4; }
        const [first, ...rest] = g();
        if (first !== 1) return 100 + first;
        if (rest.length !== 3) return 200 + rest.length;
        if (rest[0] !== 2 || rest[2] !== 4) return 300;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  // Plain-array fast path still works (no iterator side effects).
  it("plain array [a,,b] reads indices 0 and 2", async () => {
    const src = `
      export function test(): number {
        const [a, , b] = [5, 6, 7];
        if (a !== 5) return 100 + a;
        if (b !== 7) return 200 + b;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  // Assignment-target form (site 2): [a,,b] = gen().
  it("assignment [a,,b] = gen() binds 0 and 2", async () => {
    const src = `
      export function test(): number {
        function* g() { yield 1; yield 2; yield 3; }
        let a = 0;
        let b = 0;
        [a, , b] = g();
        if (a !== 1) return 100 + a;
        if (b !== 3) return 200 + b;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  // for-of with an elision pattern over plain arrays.
  it("for-of [a,,b] binds 0 and 2 each iteration", async () => {
    const src = `
      export function test(): number {
        let sum = 0;
        for (const [a, , b] of [[1, 2, 3], [10, 20, 30]]) { sum += a + b; }
        return sum === 1 + 3 + 10 + 30 ? 1 : sum;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
