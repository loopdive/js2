import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

/**
 * #869: Caller-side default parameter insertion.
 * Verifies that constant defaults are inlined at call sites and
 * that NaN is correctly distinguished from "missing argument".
 */

async function runTest(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports.test as () => number)();
}

describe("Default params: caller-side insertion (#869)", () => {
  it("constant default is used when arg missing", async () => {
    const result = await runTest(`
      function f(x: number = 42): number { return x; }
      export function test(): number { return f(); }
    `);
    expect(result).toBe(42);
  });

  it("constant default is overridden when arg provided", async () => {
    const result = await runTest(`
      function f(x: number = 42): number { return x; }
      export function test(): number { return f(100); }
    `);
    expect(result).toBe(100);
  });

  it("explicit NaN does NOT trigger default", async () => {
    const result = await runTest(`
      function f(x: number = 42): number { return x; }
      export function test(): number { return f(NaN) !== f(NaN) ? 1 : 0; }
    `);
    // f(NaN) should return NaN (not 42), and NaN !== NaN is true
    expect(result).toBe(1);
  });

  it("explicit 0 does NOT trigger default", async () => {
    const result = await runTest(`
      function f(x: number = 42): number { return x; }
      export function test(): number { return f(0); }
    `);
    expect(result).toBe(0);
  });

  it("negative constant default", async () => {
    const result = await runTest(`
      function f(x: number = -10): number { return x; }
      export function test(): number { return f(); }
    `);
    expect(result).toBe(-10);
  });

  it("multiple constant defaults, partial application", async () => {
    const result = await runTest(`
      function f(a: number = 10, b: number = 20): number { return a + b; }
      export function test(): number {
        return f() + f(1) + f(1, 2);
      }
    `);
    // f() = 10+20=30, f(1) = 1+20=21, f(1,2) = 1+2=3 → 54
    expect(result).toBe(54);
  });

  it("Infinity default", async () => {
    const result = await runTest(`
      function f(x: number = Infinity): number { return x > 1e308 ? 1 : 0; }
      export function test(): number { return f(); }
    `);
    expect(result).toBe(1);
  });

  it("zero default — explicitly passing 0 should give 0", async () => {
    const result = await runTest(`
      function f(x: number = 99): number { return x; }
      export function test(): number { return f(0); }
    `);
    expect(result).toBe(0);
  });
});

/**
 * #869 — extend the caller-side constant path to fold compile-time-constant
 * numeric *expressions* (`30 * 1000`, `1 << 4`, `Infinity`, `NaN`, …) so they
 * are emitted directly at the call site instead of taking the sNaN sentinel
 * fallback. Two properties are locked in:
 *   1. Foldable defaults give the correct value both when omitted and supplied.
 *   2. NON-constant defaults (side-effecting calls, references to other params)
 *      are NEVER folded — they must still evaluate at the callee, and only when
 *      the argument is actually missing.
 */
describe("Default params: constant-folded expression defaults (#869)", () => {
  it("folds arithmetic default (30 * 1000) when arg omitted", async () => {
    expect(
      await runTest(`
        function f(a: number, b: number = 30 * 1000): number { return b; }
        export function test(): number { return f(1); }
      `),
    ).toBe(30000);
  });

  it("folds bitwise shift default (1 << 4)", async () => {
    expect(
      await runTest(`
        function f(a: number = 1 << 4): number { return a; }
        export function test(): number { return f(); }
      `),
    ).toBe(16);
  });

  it("folds chained multiplication (60 * 60 * 24)", async () => {
    expect(
      await runTest(`
        function f(a: number = 60 * 60 * 24): number { return a; }
        export function test(): number { return f(); }
      `),
    ).toBe(86400);
  });

  it("folds parenthesized arithmetic ((2 + 3) * 4)", async () => {
    expect(
      await runTest(`
        function f(a: number = (2 + 3) * 4): number { return a; }
        export function test(): number { return f(); }
      `),
    ).toBe(20);
  });

  it("folds exponentiation (2 ** 10)", async () => {
    expect(
      await runTest(`
        function f(a: number = 2 ** 10): number { return a; }
        export function test(): number { return f(); }
      `),
    ).toBe(1024);
  });

  it("folds modulo (7 % 3)", async () => {
    expect(
      await runTest(`
        function f(a: number = 7 % 3): number { return a; }
        export function test(): number { return f(); }
      `),
    ).toBe(1);
  });

  it("folds bitwise-and of hex literals (0xff & 0x0f)", async () => {
    expect(
      await runTest(`
        function f(a: number = 0xff & 0x0f): number { return a; }
        export function test(): number { return f(); }
      `),
    ).toBe(15);
  });

  it("folds bitwise-not (~5)", async () => {
    expect(
      await runTest(`
        function f(a: number = ~5): number { return a; }
        export function test(): number { return f(); }
      `),
    ).toBe(-6);
  });

  it("folds logical-and default (1 && 7)", async () => {
    expect(
      await runTest(`
        function f(a: number = 1 && 7): number { return a; }
        export function test(): number { return f(); }
      `),
    ).toBe(7);
  });

  it("folds logical-or default (0 || 9)", async () => {
    expect(
      await runTest(`
        function f(a: number = 0 || 9): number { return a; }
        export function test(): number { return f(); }
      `),
    ).toBe(9);
  });

  it("folds -Infinity default", async () => {
    expect(
      await runTest(`
        function f(a: number = -Infinity): number { return a === -Infinity ? 1 : 0; }
        export function test(): number { return f(); }
      `),
    ).toBe(1);
  });

  it("folds explicit NaN default (fires when omitted)", async () => {
    expect(
      await runTest(`
        function f(a: number = NaN): number { return a !== a ? 1 : 0; }
        export function test(): number { return f(); }
      `),
    ).toBe(1);
  });

  it("folds i32 native-int param default (3 << 2)", async () => {
    expect(
      await runTest(`
        type i32 = number;
        function f(a: i32 = 3 << 2): i32 { return a; }
        export function test(): i32 { return f(); }
      `),
    ).toBe(12);
  });

  it("supplied arg overrides a folded default", async () => {
    expect(
      await runTest(`
        function f(a: number, b: number = 30 * 1000): number { return b; }
        export function test(): number { return f(1, 5); }
      `),
    ).toBe(5);
  });

  it("explicit NaN argument is NOT treated as missing (folded default)", async () => {
    // Regression guard: a caller-side folded default must still distinguish an
    // explicit NaN argument from an omitted one.
    expect(
      await runTest(`
        function f(a: number = 6 * 7): number { return a !== a ? 1 : 0; }
        export function test(): number { return f(NaN); }
      `),
    ).toBe(1);
  });

  it("omitted arg uses the folded default value", async () => {
    expect(
      await runTest(`
        function f(a: number = 6 * 7): number { return a; }
        export function test(): number { return f(); }
      `),
    ).toBe(42);
  });

  // --- NON-constant defaults must NOT be folded (side effects / param refs) ---

  it("side-effecting default expression is preserved (evaluated per omitted call)", async () => {
    expect(
      await runTest(`
        let c = 0;
        function inc(): number { c++; return c; }
        function f(a: number = inc()): number { return a; }
        export function test(): number { return f() + f(); }
      `),
    ).toBe(3); // 1 + 2
  });

  it("side-effecting default is NOT evaluated when the arg is supplied", async () => {
    expect(
      await runTest(`
        let c = 0;
        function inc(): number { c++; return c; }
        function f(a: number = inc()): number { return c; }
        export function test(): number { return f(9); }
      `),
    ).toBe(0); // inc() never runs
  });

  it("default referencing an earlier parameter is NOT folded", async () => {
    expect(
      await runTest(`
        function f(a: number, b: number = a + 1): number { return b; }
        export function test(): number { return f(10); }
      `),
    ).toBe(11);
  });

  it("default referencing an earlier parameter (multiplication)", async () => {
    expect(
      await runTest(`
        function f(a: number, b: number = a * 2): number { return b; }
        export function test(): number { return f(5); }
      `),
    ).toBe(10);
  });
});

/**
 * #869 follow-on — fold **immutable `const` numeric bindings** referenced in a
 * default. Safe because `const` cannot be reassigned, so its value is fixed for
 * the program lifetime. `let`/`var` are NEVER folded (a default over a
 * reassignable binding must observe the CALL-TIME value, §10.2.11) — the
 * boundary is locked by explicit non-fold guard tests below.
 */
describe("Default params: immutable const-binding folding (#869)", () => {
  it("folds a const numeric binding used as a default", async () => {
    expect(
      await runTest(`
        const TIMEOUT_MS = 5000;
        function f(t: number = TIMEOUT_MS): number { return t; }
        export function test(): number { return f(); }
      `),
    ).toBe(5000);
  });

  it("folds a const whose initializer is itself a constant expression", async () => {
    expect(
      await runTest(`
        const TIMEOUT_MS = 30 * 1000;
        function f(t: number = TIMEOUT_MS): number { return t; }
        export function test(): number { return f(); }
      `),
    ).toBe(30000);
  });

  it("folds a chain of const bindings (A → B = A * 2)", async () => {
    expect(
      await runTest(`
        const A = 5;
        const B = A * 2;
        function f(x: number = B): number { return x; }
        export function test(): number { return f(); }
      `),
    ).toBe(10);
  });

  it("folds a const binding for an i32 native-int param", async () => {
    expect(
      await runTest(`
        type i32 = number;
        const SHIFT = 3 << 2;
        function f(a: i32 = SHIFT): i32 { return a; }
        export function test(): i32 { return f(); }
      `),
    ).toBe(12);
  });

  it("supplied arg overrides a folded const-binding default", async () => {
    expect(
      await runTest(`
        const K = 5000;
        function f(t: number = K): number { return t; }
        export function test(): number { return f(7); }
      `),
    ).toBe(7);
  });

  // --- boundary: mutable bindings must NOT be folded ---

  it("does NOT fold a `let` binding — reads the call-time value after reassignment", async () => {
    // If `base` were wrongly folded to its initializer (10), this would return
    // 10. It must read the current value (20) at call time.
    expect(
      await runTest(`
        let base = 10;
        function f(a: number = base): number { return a; }
        base = 20;
        export function test(): number { return f(); }
      `),
    ).toBe(20);
  });

  it("does NOT fold a `var` binding — reads the call-time value after reassignment", async () => {
    expect(
      await runTest(`
        var v = 1;
        function f(a: number = v): number { return a; }
        v = 99;
        export function test(): number { return f(); }
      `),
    ).toBe(99);
  });

  it("does NOT fold a const bound to a mutable binding (non-constant initializer)", async () => {
    // `K2`'s initializer is a `let` read, which is not compile-time constant, so
    // K2 is not folded; the callee reads K2's real (frozen) value.
    expect(
      await runTest(`
        let m = 3;
        const K2 = m;
        function f(a: number = K2): number { return a; }
        m = 8;
        export function test(): number { return f(); }
      `),
    ).toBe(3);
  });
});
