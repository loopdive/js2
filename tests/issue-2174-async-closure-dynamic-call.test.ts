// #2174 — standalone async + closure-value call: the multi-funcref dispatch
// ladder must coerce an async candidate's externref (Promise) return to the
// block result type.
//
// Root cause: when the callee of a value-call (`retFn()` where `retFn` has an
// inferred `() => Promise<T>` type) is invoked through the #1131 multi-funcref
// dispatch ladder in `expressions/calls.ts`, `resolveWasmType` strips the
// `Promise<T>` wrapper and the dispatch `if`-block was typed `(result f64)`.
// But an async closure's real funcref type returns the Promise object
// (externref). That async candidate (synthesized via
// `tryAltFuncType([externref])`) `call_ref`'d and left an externref in an
// `(result f64)` block → invalid Wasm:
//   `__closure_N failed: type error in fallthru[0] (expected f64, got externref)`.
//
// Fix (calls.ts): (1) widen `expectedReturn` to externref when the callee is
// async (`isPromiseType(sigRetType)`) so the Promise flows through intact, and
// (2) generalise the per-candidate return coercion in the dispatch ladder to
// bridge ANY mismatch via `coerceType` (not just numeric↔numeric), so every
// dispatch arm leaves a value of the declared block type.
//
// This was the structural blocker freezing the standalone test262 baseline: a
// 23-test cluster
// (`language/.../returns-async-{arrow,function}-returns-arguments-from-*`)
// failed to compile in standalone, making the standalone regression guard fire
// false positives on unrelated value-rep PRs (#1503/#1511/#1514).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Compile + instantiate + run `test()`. `test()` returns 1 on pass, a
// fail-assert index (>1) on assertion failure, or -1 on a caught exception
// (mirrors the test262 wrap-and-run harness contract).
async function runWasi(src: string): Promise<number> {
  const res: any = await compile(src, { target: "wasi", skipSemanticDiagnostics: true });
  expect(res.success).toBe(true);
  expect(res.binary.length).toBeGreaterThan(0);
  // Must produce a *valid* binary — the bug emitted a structurally-valid
  // CompileResult whose binary V8 rejected at WebAssembly.compile().
  await WebAssembly.compile(res.binary);
  const importObj: any = buildImports(res.imports, undefined, res.stringPool);
  const { instance } = await WebAssembly.instantiate(res.binary, importObj);
  if (typeof importObj.setExports === "function") importObj.setExports(instance.exports);
  return (instance.exports as any).test() as number;
}

async function compilesWasi(src: string): Promise<void> {
  const res: any = await compile(src, { target: "wasi", skipSemanticDiagnostics: true });
  expect(res.success).toBe(true);
  expect(res.binary.length).toBeGreaterThan(0);
  // The regression: this threw "type error in fallthru[0]" inside V8.
  await WebAssembly.compile(res.binary);
}

describe("#2174 — async closure returned then called via value-call dispatch", () => {
  // The minimized shape from the test262 cluster: an async function returns an
  // async function; the returned closure is resolved through `.then` and then
  // *called* (`retFn()`) inside the continuation. `retFn` is inferred as
  // `() => Promise<...>`, driving the externref-vs-primitive block mismatch.
  it("async fn returning an async fn, called through .then (was: invalid Wasm)", async () => {
    await compilesWasi(`
      export function test(): number {
        async function asyncFn(x) {
          return async function() { return 1; };
        }
        asyncFn(1).then(retFn => {
          return retFn();
        });
        return 1;
      }
    `);
  });

  // Capturing the outer `arguments` object into the returned async closure —
  // the exact test262 fixture shape — plus the full assert continuation.
  it("captured arguments + async inner fn, asserted false (test262 fixture shape)", async () => {
    const ret = await runWasi(`
      let __fail: number = 0;
      function isSameValue(a: any, b: any): number {
        if (a === b) { return 1; }
        if (a !== a && b !== b) { return 1; }
        return 0;
      }
      function assert_sameValue_bool(actual: any, expected: boolean): void {
        if (actual !== expected) { if (!__fail) __fail = 1; }
      }
      function assert_sameValue(actual: any, expected: any): void {
        if (!isSameValue(actual, expected)) { if (!__fail) __fail = 2; }
      }
      export function test(): number {
        let count = 0;
        async function asyncFn(x) {
          let a = arguments;
          return async function() { return a === arguments; };
        }
        asyncFn(1).then(retFn => {
          count++;
          return retFn();
        }).then(result => {
          assert_sameValue_bool(result, false);
          assert_sameValue(count, 1);
        });
        if (__fail) { return __fail; }
        return 1;
      }
    `);
    // 1 = the async chain ran, `result === false` and `count === 1` both held.
    expect(ret).toBe(1);
  });

  // Async ARROW variant (the `returns-async-arrow-...-from-parent-function`
  // half of the cluster).
  it("async fn returning an async arrow, called through .then", async () => {
    await compilesWasi(`
      export function test(): number {
        async function asyncFn(x) {
          return async () => 1;
        }
        asyncFn(1).then(retFn => {
          return retFn();
        });
        return 1;
      }
    `);
  });

  // The fix must not change the JS-host (default/gc) path: the same shape
  // compiles to valid Wasm and runs correct there too.
  it("host (gc) target: same shape compiles and runs correct", async () => {
    const res: any = await compile(
      `
      let __fail: number = 0;
      function assert_sameValue_bool(actual: any, expected: boolean): void {
        if (actual !== expected) { if (!__fail) __fail = 1; }
      }
      export function test(): number {
        let count = 0;
        async function asyncFn(x) {
          let a = arguments;
          return async function() { return a === arguments; };
        }
        asyncFn(1).then(retFn => {
          count++;
          return retFn();
        }).then(result => {
          assert_sameValue_bool(result, false);
        });
        if (__fail) { return __fail; }
        return 1;
      }
    `,
      { skipSemanticDiagnostics: true },
    );
    expect(res.success).toBe(true);
    await WebAssembly.compile(res.binary);
    const importObj: any = buildImports(res.imports, undefined, res.stringPool);
    const { instance } = await WebAssembly.instantiate(res.binary, importObj);
    if (typeof importObj.setExports === "function") importObj.setExports(instance.exports);
    expect((instance.exports as any).test()).toBe(1);
  });

  // Regression guard for the first cut of this fix: generalising the
  // multi-funcref dispatch coercion to `coerceType` for ALL mismatches pulled
  // a late host import (`__unbox_number`/`__typeof_boolean`) from a *dead*
  // never-matching candidate arm, which shifted function indices mid-body and
  // rewrote an already-baked `ref.func` operand. A plain non-async
  // function-reference-in-a-variable call (`var fn = makeAdder(10); fn(32)`)
  // then wrapped the wrong function and threw at runtime. The narrowed fix
  // keeps numeric coercion (pure ops) and uses drop+default (no imports) for
  // the dead externref/ref arms. These must compile AND run correct.
  async function runHost(src: string): Promise<number> {
    const res: any = await compile(src, { skipSemanticDiagnostics: true });
    expect(res.success).toBe(true);
    await WebAssembly.compile(res.binary);
    const importObj: any = buildImports(res.imports, undefined, res.stringPool);
    const { instance } = await WebAssembly.instantiate(res.binary, importObj);
    if (typeof importObj.setExports === "function") importObj.setExports(instance.exports);
    return (instance.exports as any).test() as number;
  }

  it("non-async closure returned and called (was: wrong ref.func, threw)", async () => {
    expect(
      await runHost(`
        function makeAdder(x: number): (y: number) => number {
          return (y: number): number => x + y;
        }
        export function test(): number {
          var fn = makeAdder(10);
          return fn(32);
        }
      `),
    ).toBe(42);
  });

  it("plain function assigned to a var and called with args", async () => {
    expect(
      await runHost(`
        function add(a: number, b: number): number { return a + b; }
        export function test(): number {
          var fn = add;
          return fn(10, 20);
        }
      `),
    ).toBe(30);
  });

  it("counter closure returned and called repeatedly (stateful)", async () => {
    expect(
      await runHost(`
        function counter(): () => number {
          var count: number = 0;
          return (): number => { count = count + 1; return count; };
        }
        export function test(): number {
          var inc = counter();
          inc();
          inc();
          return inc();
        }
      `),
    ).toBe(3);
  });
});
