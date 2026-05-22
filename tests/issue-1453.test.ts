import { test, expect, describe } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

/**
 * #1453 — Per-iteration fresh let/const binding in `for` statements.
 *
 * ECMA-262 §14.7.4.4 (CreatePerIterationEnvironment): each iteration of
 * `for (let X = …; …; …) Body` must run against a freshly-allocated binding
 * for X initialised to the previous iteration's value. Closures captured in
 * iteration N must therefore observe iteration N's binding, not the final
 * post-loop value.
 *
 * Tests avoid `Array<() => T>` since arrays of closures hit a pre-existing
 * codegen issue unrelated to per-iteration semantics. Instead, we snapshot
 * the closures into individual locals/variables.
 */

function compileAndRun(src: string): any {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`Compile error: ${r.errors?.[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(r.binary), imports);
  return (instance.exports as any).test();
}

describe("#1453 — for (let) per-iteration fresh binding", () => {
  test("each iteration's closure observes its own binding (digits-of-i pattern)", () => {
    // Snapshot one closure per iteration in three named slots. Without
    // per-iteration freshness, all three would return 3 (the post-loop value).
    const result = compileAndRun(`
      export function test(): number {
        let f0: () => number = () => 0;
        let f1: () => number = () => 0;
        let f2: () => number = () => 0;
        for (let i = 0; i < 3; ++i) {
          if (i === 0) f0 = () => i;
          if (i === 1) f1 = () => i;
          if (i === 2) f2 = () => i;
        }
        return f0() * 100 + f1() * 10 + f2(); // 0,1,2 → 12
      }
    `);
    expect(result).toBe(12);
  });

  test("closure assigned in body sees mid-iteration value, not final 5", () => {
    const result = compileAndRun(`
      export function test(): number {
        let snapshot: () => number = () => -1;
        for (let i = 0; i < 5; ++i) {
          if (i === 2) snapshot = () => i;
        }
        return snapshot(); // 2
      }
    `);
    expect(result).toBe(2);
  });

  test("non-capturing loop still works (no perf regression path)", () => {
    const result = compileAndRun(`
      export function test(): number {
        let total = 0;
        for (let i = 0; i < 100; ++i) total = total + i;
        return total; // 4950
      }
    `);
    expect(result).toBe(4950);
  });

  test("closure mutation in iteration N visible to same closure (within own cell)", () => {
    const result = compileAndRun(`
      export function test(): number {
        let captured: () => number = () => -1;
        for (let i = 0; i < 1; ++i) {
          captured = () => { i = i + 100; return i; };
        }
        const a = captured(); // 100
        const b = captured(); // 200
        return a + b;         // 300
      }
    `);
    expect(result).toBe(300);
  });

  test("function expression capture", () => {
    const result = compileAndRun(`
      export function test(): number {
        let f1: () => number = () => 0;
        let f2: () => number = () => 0;
        for (let i = 0; i < 2; ++i) {
          const c = function() { return i + 100; };
          if (i === 0) f1 = c;
          if (i === 1) f2 = c;
        }
        return f1() + f2(); // 100 + 101 = 201
      }
    `);
    expect(result).toBe(201);
  });

  test("multi-binding fresh allocation", () => {
    const result = compileAndRun(`
      export function test(): number {
        let f0: () => number = () => 0;
        let f1: () => number = () => 0;
        for (let i = 0, j = 10; i < 2; ++i, --j) {
          if (i === 0) f0 = () => i * 100 + j;
          if (i === 1) f1 = () => i * 100 + j;
        }
        // Iter 0: i=0, j=10 → 0*100+10 = 10
        // Iter 1: i=1, j=9 → 109
        return f0() + f1(); // 119
      }
    `);
    expect(result).toBe(119);
  });

  test("body mutates i; fresh cell carries mutated value into next iteration", () => {
    const result = compileAndRun(`
      export function test(): number {
        let captured: () => number = () => -1;
        for (let i = 0; i < 10; ++i) {
          i = i + 100;
          captured = () => i;
        }
        // Iter 1: i=0 → +100 → 100 → ++ → 101. 101 < 10 false. Exit.
        // captured was set with C_0 (value 100 after body mutation).
        return captured();
      }
    `);
    expect(result).toBe(100);
  });

  test("continue still triggers fresh-cell allocation", () => {
    const result = compileAndRun(`
      export function test(): number {
        let f0: () => number = () => -1;
        let f2: () => number = () => -1;
        let f3: () => number = () => -1;
        for (let i = 0; i < 4; ++i) {
          if (i === 1) continue;
          if (i === 0) f0 = () => i;
          if (i === 2) f2 = () => i;
          if (i === 3) f3 = () => i;
        }
        return f0() * 100 + f2() * 10 + f3(); // 0,2,3 → 23
      }
    `);
    expect(result).toBe(23);
  });

  test("nested for-loops with same name do not leak", () => {
    const result = compileAndRun(`
      export function test(): number {
        let outerCaptured: () => number = () => -1;
        let innerCaptured: () => number = () => -1;
        for (let i = 0; i < 1; ++i) {
          outerCaptured = () => i;
          for (let i = 10; i < 11; ++i) {
            innerCaptured = () => i;
          }
        }
        return outerCaptured() * 100 + innerCaptured(); // 0*100 + 10 = 10
      }
    `);
    expect(result).toBe(10);
  });
});
