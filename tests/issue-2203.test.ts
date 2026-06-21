import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2203 — Array destructuring with elisions + defaults.
//
// Two distinct symptoms were tracked under this issue:
//
//  (1) STANDALONE crash — a nested generator that CAPTURES an outer-scope
//      binding (the shape test262 procedurally generates: `function* g()`
//      nested inside `test()`, mutating an outer counter) cannot use the
//      Wasm-native generator factory, so it falls to the eager-buffer host
//      path. In a no-JS-host target the `__gen_*` host imports were never
//      registered for it (`isNativeGeneratorCandidate` did not model captures),
//      so the emit baked a `funcIdx: undefined` → invalid Wasm
//      ("function index out of range — undefined at function 'g'"). The fix
//      registers the host imports for capturing nested generators
//      (`sourceNeedsGeneratorHostImports` now flags them), so the module emits
//      a structurally valid binary. These tests assert the binary VALIDATES in
//      standalone — they do not assert generator laziness (the eager model runs
//      the body to completion; lazy capturing generators are the #680 follow-up).
//
//  (2) HOST value cases — array-literal RHS elision + default already lowers
//      correctly (leading holes skip the right number of slots, the following
//      element / its default binds the next value). These guard against a
//      regression in that path.

async function runHost(source: string, fn: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports as Record<string, () => unknown>)[fn]!();
}

/** Compile in standalone mode and assert the binary validates (no funcidx crash). */
async function expectStandaloneValidates(source: string): Promise<void> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  expect(
    result.success,
    `Standalone compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  // The #2203 crash surfaced at binary emit; a successful compile already proves
  // the funcidx is in range, but assert validity explicitly for clarity.
  expect(await WebAssembly.validate(result.binary)).toBe(true);
}

describe("#2203 array destructuring elisions + defaults — host value cases", () => {
  it("leading elisions skip values then bind: [, , x] = [10, 20, 30]", async () => {
    expect(
      await runHost(
        `export function test(): number {
           const a = [10, 20, 30];
           const [, , x] = a;
           return x;
         }`,
        "test",
      ),
    ).toBe(30);
  });

  it("single leading elision: [, y] = [5, 9]", async () => {
    expect(
      await runHost(
        `export function test(): number {
           const a = [5, 9];
           const [, y] = a;
           return y;
         }`,
        "test",
      ),
    ).toBe(9);
  });

  it("elision + default present binds the value, not the default: [, z = 99] = [1, 2]", async () => {
    expect(
      await runHost(
        `export function test(): number {
           const a = [1, 2];
           const [, z = 99] = a;
           return z;
         }`,
        "test",
      ),
    ).toBe(2);
  });

  it("elision + default fires when value is missing: [, z = 99] = [1]", async () => {
    expect(
      await runHost(
        `export function test(): number {
           const a = [1];
           const [, z = 99] = a;
           return z;
         }`,
        "test",
      ),
    ).toBe(99);
  });

  it("two elisions then default: [, , w = 7] = [1, 2]", async () => {
    expect(
      await runHost(
        `export function test(): number {
           const a = [1, 2];
           const [, , w = 7] = a;
           return w;
         }`,
        "test",
      ),
    ).toBe(7);
  });

  it("elision + rest collects the remainder: [, ...rest] = [1, 2, 3]", async () => {
    expect(
      await runHost(
        `export function test(): number {
           const a = [1, 2, 3];
           const [, ...rest] = a;
           return rest[0] * 10 + rest[1];
         }`,
        "test",
      ),
    ).toBe(23);
  });
});

describe("#2203 array destructuring elisions over a capturing generator — standalone emits valid Wasm", () => {
  it("binding-form leading elision over a nested capturing generator: let [,] = g()", async () => {
    await expectStandaloneValidates(
      `export function test(): number {
         let first = 0;
         let second = 0;
         function* g() {
           first += 1;
           yield;
           second += 1;
         }
         let [,] = g();
         return first;
       }`,
    );
  });

  it("nested elision + default over a capturing generator: var [[,] = g()] = []", async () => {
    await expectStandaloneValidates(
      `export function test(): number {
         let callCount = 0;
         function* g() {
           callCount += 1;
         }
         var [[,] = g()] = [];
         return callCount;
       }`,
    );
  });

  it("param-default elision over a capturing generator: function f([,] = g())", async () => {
    await expectStandaloneValidates(
      `export function test(): number {
         let first = 0;
         let second = 0;
         function* g() {
           first += 1;
           yield;
           second += 1;
         }
         function f([,]: number[] = g()): void {}
         f();
         return first;
       }`,
    );
  });

  it("elision + rest over a capturing generator: let [, ...r] = g()", async () => {
    await expectStandaloneValidates(
      `export function test(): number {
         let count = 0;
         function* g() {
           count += 1;
           yield 1;
           count += 1;
           yield 2;
         }
         let [, ...r] = g();
         return count;
       }`,
    );
  });

  it("non-capturing nested generator still uses the native path (no host imports needed)", async () => {
    // Guard: the fix must NOT flag a non-capturing nested generator as needing
    // host imports — it stays native, so the standalone binary carries no
    // `__gen_*` imports it cannot satisfy.
    const result = await compile(
      `export function test(): number {
         function* g() { yield 1; yield 2; yield 3; }
         let sum = 0;
         for (const v of g()) sum += v;
         return sum;
       }`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(result.success).toBe(true);
    expect(result.imports.some((i) => i.name.startsWith("__gen_create_buffer"))).toBe(false);
  });
});
