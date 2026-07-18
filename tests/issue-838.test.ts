// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compileToWasm, compile } from "./equivalence/helpers.js";

/**
 * (#3273) Compile + run a `test()` export in the STANDALONE lane (no host
 * imports) and return its bigint result. Used to validate #838's native
 * i64-vec BigInt path in the lane where it is active (the js-host lane keeps
 * the host global — see the #838 gate / #3405).
 */
async function runStandaloneBigint(source: string): Promise<bigint> {
  const r = await compile(source, { target: "standalone" });
  if (!r.success) {
    throw new Error(`Standalone compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => bigint }).test();
}

/**
 * #838 — BigInt64Array / BigUint64Array typed arrays.
 *
 * These two views store 64-bit BigInt elements. Unlike the numeric typed
 * arrays (f64 / packed i8/i16/i32 storage) they use a dedicated `i64` element
 * vec — an f64 cannot represent a 64-bit BigInt. BigInt is already a first-class
 * `{ kind: "i64", bigint: true }` value in the compiler, so `array.get`/
 * `array.set` on the i64 backing array need no packing/unpacking, and
 * ToBigInt64/ToBigUint64 (both reduce mod 2^64) come for free from i64
 * wraparound.
 *
 * (#3273 gate) The native i64-vec path is active in STANDALONE/WASI. In the
 * js-host lane the BigInt views stay host globals so SharedArrayBuffer/Atomics
 * interop keeps working (the js-host Atomics bridge has no i64-native-vec
 * support yet — #3405); count-ctor + element read/write still work host-side,
 * but the bigint ARRAY-LITERAL constructor is validated on standalone (see the
 * two array-literal tests below).
 *
 * Before this change `new BigInt64Array(...)` compiled-errored with
 * "Unsupported new expression for class: BigInt64Array" (25 CE in official
 * scope) and 19 tests were skipped.
 *
 * Known representation limit (shared with `BigInt.asUintN(64, …)`, #3148): the
 * compiler's BigInt IS a signed wasm i64, so a `BigUint64Array` element whose
 * value is ≥ 2^63 reads back as its signed i64 interpretation (e.g. 2^64-1 reads
 * as -1n). ToBigUint64 mod-2^64 write semantics are still correct, and every
 * value < 2^63 round-trips exactly.
 */
describe("#838 BigInt64Array / BigUint64Array typed arrays", () => {
  it("BigInt64Array count constructor + element write/read", async () => {
    const exports = await compileToWasm(`
      export function test(): bigint {
        const a = new BigInt64Array(4);
        a[0] = 10n;
        a[1] = -20n;
        a[2] = a[0]! + a[1]!;
        return a[2]!;
      }
    `);
    expect(exports.test()).toBe(-10n);
  });

  it("BigUint64Array count constructor + element write/read", async () => {
    const exports = await compileToWasm(`
      export function test(): bigint {
        const a = new BigUint64Array(3);
        a[0] = 100n;
        a[1] = 200n;
        return a[0]! + a[1]!;
      }
    `);
    expect(exports.test()).toBe(300n);
  });

  it("BigInt64Array .length and .byteLength", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a = new BigInt64Array(4);
        return a.length * 1000 + a.byteLength;
      }
    `);
    // length 4, byteLength 4 * 8 = 32
    expect(exports.test()).toBe(4032);
  });

  it("BigInt64Array.BYTES_PER_ELEMENT is 8", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return BigInt64Array.BYTES_PER_ELEMENT + BigUint64Array.BYTES_PER_ELEMENT;
      }
    `);
    expect(exports.test()).toBe(16);
  });

  // (#838 gate — #3273) The bigint ARRAY-LITERAL constructor is validated on the
  // STANDALONE lane, where #838's native i64-vec path is active and lowers
  // `new BigInt64Array([1n, …])` host-free (boxed elements go through §7.1.13
  // ToBigInt via the `__to_bigint` copy arm). The js-host lane deliberately
  // keeps the host-global `BigInt64Array` (SharedArrayBuffer/Atomics interop —
  // see the #838 gate), whose bigint-array-literal marshalling is a separate
  // pre-existing host-path gap (bigint literals reach the host ctor as plain
  // numbers → "Cannot convert 5 to a BigInt"); enabling the native js-host path
  // is tracked in #3405. Count-ctor + element write/read + BigInt() coercion all
  // pass on js-host (above) via the host global.
  it("BigInt64Array from an array-literal initializer (standalone native path)", async () => {
    expect(
      await runStandaloneBigint(`
      export function test(): bigint {
        const a = new BigInt64Array([5n, 15n, 25n]);
        return a[0]! + a[1]! + a[2]!;
      }
    `),
    ).toBe(45n);
  });

  it("BigUint64Array from an array-literal initializer (standalone native path)", async () => {
    expect(
      await runStandaloneBigint(`
      export function test(): bigint {
        const a = new BigUint64Array([100n, 200n, 300n]);
        return a[2]!;
      }
    `),
    ).toBe(300n);
  });

  it("ToBigInt64 wraps the stored value mod 2^64 (signed)", async () => {
    const exports = await compileToWasm(`
      export function test(): bigint {
        const a = new BigInt64Array(1);
        // -(2^64 + 2) → ToBigInt64 → -2n
        a[0] = -18446744073709551618n;
        return a[0]!;
      }
    `);
    expect(exports.test()).toBe(-2n);
  });

  it("ToBigUint64 wraps the stored value mod 2^64 (unsigned)", async () => {
    const exports = await compileToWasm(`
      export function test(): bigint {
        const a = new BigUint64Array(1);
        // 2^64 + 2 → ToBigUint64 → 2n
        a[0] = 18446744073709551618n;
        return a[0]!;
      }
    `);
    expect(exports.test()).toBe(2n);
  });

  it("write/read across a for-loop with BigInt() coercion", async () => {
    const exports = await compileToWasm(`
      export function test(): bigint {
        const a = new BigInt64Array(5);
        for (let i = 0; i < 5; i++) a[i] = BigInt(i) * 2n;
        let sum = 0n;
        for (let i = 0; i < a.length; i++) sum += a[i]!;
        return sum;
      }
    `);
    // 0 + 2 + 4 + 6 + 8 = 20
    expect(exports.test()).toBe(20n);
  });

  it("large in-range 64-bit magnitudes round-trip (signed)", async () => {
    const exports = await compileToWasm(`
      export function test(): bigint {
        const a = new BigInt64Array(2);
        a[0] = 9223372036854775807n;  // 2^63 - 1 (max i64)
        a[1] = -9223372036854775808n; // -2^63 (min i64)
        return a[0]! + a[1]!;
      }
    `);
    // (2^63 - 1) + (-2^63) = -1
    expect(exports.test()).toBe(-1n);
  });

  it("compiles under --target standalone (dual-mode)", async () => {
    const r = await compile(
      `
      export function test(): bigint {
        const a = new BigInt64Array(3);
        a[0] = 7n;
        a[1] = a[0]! * 3n;
        return a[1]!;
      }
    `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
