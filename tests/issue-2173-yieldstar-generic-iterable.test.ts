// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2173 slice-2b — `yield*` over a GENERIC iterable in standalone native
 * generators (SF-3 slice-2 of #2157, building on slice-2a and #2170 slice-1).
 *
 * Slice-2a delegated to a NUMERIC array/vec via a direct vec cursor. The
 * remaining case is delegation to a generic iterable that is NOT a native-vec /
 * native-gen: a `.values()`/`.keys()`/`.entries()` iterator or a custom
 * `{ [Symbol.iterator]() { return { next() {…} } } }` object. Slice-2b drives the
 * standalone-native `__iterator` / `__iterator_next` runtime (#2038 —
 * iterator-native.ts) from an `externref` `$__IterRec` delegation slot: on first
 * entry `rec = __iterator(subject)`, then each resume `(done,value) =
 * __iterator_next(rec)`; while not done it unboxes `value` to the outer element
 * type (f64 outer → native `__unbox_number` via `coerceType`; boxed-any outer →
 * pass through) and re-yields, staying in the state; on done it nulls the slot
 * and transfers to the successor.
 *
 * Because the native iterator runtime is emitted Wasm (its USER `{next()}` arm is
 * filled at finalize over the module's closed-struct dispatchers), the whole
 * delegation is host-free. Every case below asserts ZERO host imports.
 *
 * Deferred: string-element outers (concrete-ref `value`, no repair seam — bailed
 * to the host path, same as slice-2a); precise `.return()`/`.throw()` close
 * forwarding into the iterator; #2106 undefined-observability of the `yield*`
 * completion value (the done-arm delivers the outer's undefined sentinel).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2173 slice-2b — yield* over a generic iterable (standalone)", () => {
  it("yield* [1,2,3].values(); yield 4 → for-of sums to 10", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield* [1,2,3].values(); yield 4; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(10);
  });

  it("delegation-only over .values() (no own yield) sums to 6", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield* [10,20,30].values(); }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(60);
  });

  it("custom { [Symbol.iterator]() { return { next() } } } iterable delegates", async () => {
    expect(
      await runStandalone(`interface NumIter { next(): { value: number; done: boolean }; }
function* g(): Generator<number> {
  const it: Iterable<number> = {
    [Symbol.iterator](): NumIter { let i = 0; return { next() { return i < 3 ? { value: i++, done: false } : { value: 0, done: true }; } }; },
  };
  yield* it; yield 9;
}
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(0 + 1 + 2 + 9);
  });

  it("any-element outer generator passes the iterator value through (no unbox)", async () => {
    expect(
      await runStandalone(`function* g(): Generator<any> { yield* [10,20].values(); }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(30);
  });

  it("yield* inside a loop re-iterates the iterable (slot re-nulls per pass)", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { for (let k=0;k<3;k++) yield* [1,2].values(); }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(9);
  });

  it("own yield before a generic delegation interleaves correctly", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield 100; yield* [1,2,3].values(); yield 200; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(100 + 1 + 2 + 3 + 200);
  });

  it("two sequential generic delegations run in order", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield* [1,2].values(); yield* [3,4].values(); }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(10);
  });

  it("manual next()-sequence yields the iterable elements then the own yield", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield* [7,8].values(); yield 9; }
export function test(): number {
  const it = g();
  const a = it.next().value as number;
  const b = it.next().value as number;
  const c = it.next().value as number;
  const d = it.next().done ? 1 : 0;
  return a*1000 + b*100 + c*10 + d;
}`),
    ).toBe(7 * 1000 + 8 * 100 + 9 * 10 + 1);
  });

  it("element count across the generic delegation boundary is correct", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield* [5,5,5,5].values(); yield 5; }
export function test(): number { let n=0; for (const _ of g()) n++; return n; }`),
    ).toBe(5);
  });

  it("regression — a plain numeric generator (no yield*) still sums correctly", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield 1; yield 2; yield 3; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(6);
  });
});
