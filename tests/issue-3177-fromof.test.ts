// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3177 slice 5 — standalone `%TypedArray%.of` / `%TypedArray%.from` statics.
//
// `TA.of(v0,…)` / `TA.from(src[, mapfn[, thisArg]])` on a `$__ta_ctor` receiver
// value (the testWithTypedArrayConstructors harness shape) build a fresh
// same-kind dyn-view via the shared native `__ta_from_arraylike(ctor, carrier)`
// helper reading the carrier through `__extern_length`/`__extern_get_idx`:
//  - `of` packs its args into a `$ObjVec` carrier.
//  - `from` normalizes its source (+ optional mapfn) via
//    `__array_from_iter_n` / `__array_from_mapped`.
// The dyn-view rep gives `.constructor` / `Object.getPrototypeOf` identity for
// free (slices 1/3). A runtime `ref.test $__ta_ctor` two-arm keeps every other
// `.of`/`.from` receiver (Array.of/from, user objects) on the ordinary path.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

const wrap = (body: string) => `export function test(): number {\n  const TA: any = Uint8Array;\n  ${body}\n}`;

describe("#3177 slice 5 — TypedArray.of (standalone, host-free)", () => {
  it("of() builds an empty view", async () => {
    expect(await run(wrap(`const r: any = TA.of(); return r.length === 0 ? 1 : 0;`))).toBe(1);
  });

  it("of(v0,v1,v2) builds a length-3 view with the given elements", async () => {
    expect(
      await run(
        wrap(
          `const r: any = TA.of(42, 43, 7); return (r.length === 3 && r[0] === 42 && r[1] === 43 && r[2] === 7) ? 1 : 0;`,
        ),
      ),
    ).toBe(1);
  });

  it("of() ToNumbers null to +0", async () => {
    expect(await run(wrap(`const r: any = TA.of(42, 43, null); return (r.length === 3 && r[2] === 0) ? 1 : 0;`))).toBe(
      1,
    );
  });

  it("of() constructor identity: TA.of(1).constructor === TA", async () => {
    expect(await run(wrap(`const r: any = TA.of(1); return r.constructor === TA ? 1 : 0;`))).toBe(1);
  });

  it("of() prototype identity: getPrototypeOf(TA.of(1)) === TA.prototype", async () => {
    expect(await run(wrap(`const r: any = TA.of(1); return Object.getPrototypeOf(r) === TA.prototype ? 1 : 0;`))).toBe(
      1,
    );
  });

  it("Uint8ClampedArray.of clamps out-of-range values", async () => {
    expect(
      await run(
        `export function test(): number {\n  const TA: any = Uint8ClampedArray;\n  const r: any = TA.of(300, -5); return (r[0] === 255 && r[1] === 0) ? 1 : 0;\n}`,
      ),
    ).toBe(1);
  });

  it("Int16Array.of preserves signed values", async () => {
    expect(
      await run(
        `export function test(): number {\n  const TA: any = Int16Array;\n  const r: any = TA.of(-1, 1000); return (r[0] === -1 && r[1] === 1000) ? 1 : 0;\n}`,
      ),
    ).toBe(1);
  });
});

describe("#3177 slice 5 — TypedArray.from (standalone, host-free)", () => {
  it("from(array) copies elements", async () => {
    expect(
      await run(
        wrap(`const r: any = TA.from([1, 2, 3]); return (r.length === 3 && r[0] === 1 && r[2] === 3) ? 1 : 0;`),
      ),
    ).toBe(1);
  });

  it("from(arrayLike) reads length + indexed props", async () => {
    expect(
      await run(
        wrap(
          `const src: any = { length: 2, 0: 5, 1: 6 }; const r: any = TA.from(src); return (r.length === 2 && r[0] === 5 && r[1] === 6) ? 1 : 0;`,
        ),
      ),
    ).toBe(1);
  });

  it("from(source, mapfn) maps each element", async () => {
    expect(
      await run(
        wrap(
          `const r: any = TA.from([1, 2, 3], (x: number) => x * 2); return (r.length === 3 && r[0] === 2 && r[2] === 6) ? 1 : 0;`,
        ),
      ),
    ).toBe(1);
  });

  it("from(source, mapfn) passes (value, index)", async () => {
    expect(
      await run(
        wrap(
          `const r: any = TA.from([9, 9, 9], (_x: number, i: number) => i); return (r[0] === 0 && r[1] === 1 && r[2] === 2) ? 1 : 0;`,
        ),
      ),
    ).toBe(1);
  });

  it("from(source, undefined) treats an undefined mapfn as absent", async () => {
    expect(
      await run(
        wrap(`const r: any = TA.from([4, 5], undefined); return (r.length === 2 && r[0] === 4 && r[1] === 5) ? 1 : 0;`),
      ),
    ).toBe(1);
  });

  // NOTE (deferred follow-on): an ITERABLE (non-array-like) source — e.g. a
  // `Set` — is drained through `__array_from_iter_n`'s iterator ladder, which
  // does not yet normalize a builtin iterable into a carrier the array-like
  // reader can index (length reads 0). Array / array-like / mapfn sources (the
  // corpus `new-instance-*` rows) all work; the "true iterable-protocol ctor
  // arm" is explicitly deferred in the #3177 plan. This pins the current
  // (non-crashing) behavior so a future fix flips it deliberately.
  it("from(iterable Set) is a documented follow-on (empty view, no trap)", async () => {
    expect(await run(wrap(`const r: any = TA.from(new Set([7, 8, 9])); return r.length === 0 ? 1 : 0;`))).toBe(1);
  });

  it("from() constructor + prototype identity", async () => {
    expect(
      await run(
        wrap(
          `const r: any = TA.from([1]); return (r.constructor === TA && Object.getPrototypeOf(r) === TA.prototype) ? 1 : 0;`,
        ),
      ),
    ).toBe(1);
  });
});

describe("#3177 slice 5 — non-TA receivers keep their behavior", () => {
  it("Array.of is unaffected (plain array, no dyn-view hijack)", async () => {
    expect(
      await run(
        `export function test(): number {\n  const a: any = Array.of(1, 2, 3); return (a.length === 3 && a[0] === 1 && a[2] === 3) ? 1 : 0;\n}`,
      ),
    ).toBe(1);
  });

  it("Array.from is unaffected (plain array)", async () => {
    expect(
      await run(
        `export function test(): number {\n  const a: any = Array.from([4, 5]); return (a.length === 2 && a[0] === 4 && a[1] === 5) ? 1 : 0;\n}`,
      ),
    ).toBe(1);
  });
});
