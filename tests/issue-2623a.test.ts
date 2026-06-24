import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// #2623-A — inbound host→wasm callback-arg marshalling (the keystone).
//
// The inbound closure-call dispatchers `__call_fn_N` / `__call_fn_method_N`
// (emitClosureCallExportN) lower each host-supplied callback arg to the
// closure's declared param ValType. For a NULLABLE concrete-struct param
// (`ref_null` → `(ref null $T)`, e.g. a callback param the compiler typed
// `any[]` → a wasm vec struct), the dispatcher used an UNCONDITIONAL
// `ref.cast_null $T` — which TRAPS with "illegal cast" when the host passes a
// value that is not a `$T` struct (the dominant case being a real host JS array
// passed for an `any[]` param, e.g. a Proxy apply/construct trap's `args`).
//
// Fix: GUARD the cast with `ref.test $T` — on a match cast exactly as before
// (zero change for matching callbacks), on a mismatch yield a typed `ref.null`
// so `call_ref` typechecks and the closure receives null instead of crashing.
// The change is monotonically safe for status: a passing callback always
// matched its declared param (no trap), so its behavior is byte-identical.

async function run(source: string): Promise<unknown> {
  const exports = await compileAndInstantiate(source);
  return (exports as { test?: () => unknown }).test?.();
}

describe("#2623-A — guarded inbound callback-arg cast", () => {
  it("a Proxy apply trap with an array-typed `args` param no longer illegal-casts", async () => {
    // `built-ins/Proxy/apply/call-result.js` shape: the apply trap declares
    // `function(t, c, args)` — `args` lowers to a nullable wasm vec struct — but
    // the host passes a real JS array. Before the fix this `ref.cast_null`-traped
    // ("illegal cast in __call_fn_method_3"). Now the trap runs and its result
    // flows back.
    const src = `
      const result = { v: 7 };
      const p: any = new Proxy(function () { return -1; }, {
        apply: function (t: any, c: any, args: any) { return result; },
      });
      export function test(): number { return p.call().v; }
    `;
    expect(await run(src)).toBe(7);
  });

  it("an ordinary array callback with matching args still dispatches unchanged (hot-path guard)", async () => {
    // forEach passes (value, index, array) — the matching values flow through the
    // SAME ref.test→ref.cast path; the guard must be a no-op for them.
    const src = `
      export function test(): number {
        const a = [10, 20, 30];
        let sum = 0;
        a.forEach(function (v: number) { sum += v; });
        return sum;
      }
    `;
    expect(await run(src)).toBe(60);
  });

  it("map with a closure callback returns correct values (matching-path regression guard)", async () => {
    const src = `
      export function test(): number {
        const a = [1, 2, 3];
        const b = a.map(function (v: number) { return v * v; });
        return b[0] + b[1] + b[2];
      }
    `;
    expect(await run(src)).toBe(14); // 1 + 4 + 9
  });

  it("sort comparator (2-arg closure) still orders correctly", async () => {
    const src = `
      export function test(): number {
        const a = [3, 1, 2];
        a.sort(function (x: number, y: number) { return x - y; });
        return a[0] * 100 + a[1] * 10 + a[2];
      }
    `;
    expect(await run(src)).toBe(123);
  });
});
