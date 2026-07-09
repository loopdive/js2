// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3100 S1 — native GetIterator vec-family ladder for dynamic iterables
 * (standalone).
 *
 * Iterating a dynamically-produced / `any`-typed iterable previously trapped
 * with `illegal cast`: the native `__iterator` (GetIterator §7.4.1) accepted
 * ONLY the canonical externref `$Vec` carrier and hard-cast everything else —
 * but `Object.keys/values/entries(<any>)` return a `$ObjVec`, and an
 * `any`-held array literal is a typed `__vec_<elemKind>` (e.g. `__vec_f64`),
 * so `for (const k of Object.keys(o))` over an `any` receiver trapped even
 * without touching `k` (while the index-loop control over the same value
 * worked — the read side had #2190/#3053 carrier arms; the ITERATE side had
 * none).
 *
 * Fix (`fillNativeIteratorLateArms`, iterator-native.ts): at finalize — when
 * every module-local carrier type is known, the same reason
 * `fillExternGetIdxVecArms` fills late — the `__iterator` ladder gains
 * vec-FAMILY normalization arms: `ref.test $ObjVec` / each `__vec_<elemKind>`
 * with a proven element-boxing recipe → copy+box the elements into a FRESH
 * canonical externref `$Vec` → the existing VEC record. `__iterator_next` /
 * `__iterator_rest` are untouched (they only ever see the canonical vec), and
 * carriers without a proven boxing recipe keep the legacy loud trap.
 *
 * Every case compiles standalone and must instantiate with ZERO host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3100 S1 — dynamic-iterable GetIterator vec-family ladder (standalone)", () => {
  it("verify-first: for-of over Object.keys(<any>) — the issue's primary trap", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { a: 5, b: 6 };
        let n = 0;
        for (const k of Object.keys(o)) { n += 1; }
        return n;
      }`),
    ).toBe(2);
  });

  it("for-of + [k,v] destructuring over Object.entries(<any>)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { a: 5, b: 6 };
        let n = 0;
        for (const [k, v] of Object.entries(o)) { n += v; }
        return n;
      }`),
    ).toBe(11);
  });

  it("for-of over Object.values(<any>)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { a: 5, b: 6 };
        let n = 0;
        for (const v of Object.values(o)) { n += v; }
        return n;
      }`),
    ).toBe(11);
  });

  it("for-of over an any-held f64 array literal (__vec_f64 arm)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [10, 20, 30];
        let n = 0;
        for (const x of a) { n += x; }
        return n;
      }`),
    ).toBe(60);
  });

  it("for-of over an any-held string array (string-ref vec arm)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = ["ab", "cde"];
        let n = 0;
        for (const s of a) { n += s.length; }
        return n;
      }`),
    ).toBe(5);
  });

  it("for-of over an any-returning function result", async () => {
    expect(
      await runStandalone(`function f(): any { return [7, 8]; }
      export function test(): number {
        let n = 0;
        for (const x of f()) { n += x; }
        return n;
      }`),
    ).toBe(15);
  });

  it("re-entrant nested iteration over the same dynamic iterable (per-loop state)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { a: 1, b: 2 };
        let n = 0;
        for (const k1 of Object.keys(o)) {
          for (const k2 of Object.keys(o)) { n += o[k1] * o[k2]; }
        }
        return n;
      }`),
    ).toBe(9); // (1+2)^2
  });

  it("break out of a dynamic for-of (IteratorClose path stays balanced)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { a: 1, b: 2, c: 3 };
        let n = 0;
        for (const k of Object.keys(o)) { n += 1; if (n === 2) break; }
        return n;
      }`),
    ).toBe(2);
  });

  it("empty dynamic iterable iterates zero times", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        let n = 0;
        for (const k of Object.keys(o)) { n += 1; }
        return n;
      }`),
    ).toBe(0);
  });

  it("for-of over null still throws (catchable), not a trap", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = null;
        let caught = 0;
        try { for (const x of o) { } } catch (e) { caught = 1; }
        return caught;
      }`),
    ).toBe(1);
  });

  // ── regression guards: the arms must not disturb the existing lanes ──

  it("regression guard: typed for-of unaffected", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = [1, 2, 3];
        let n = 0;
        for (const x of a) { n += x; }
        return n;
      }`),
    ).toBe(6);
  });

  it("regression guard: user @@iterator protocol (USER arm) unaffected", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const it: any = {
          [Symbol.iterator]() {
            let i = 0;
            return { next() { i++; return { done: i > 3, value: i }; } };
          }
        };
        let n = 0;
        for (const x of it) { n += x; }
        return n;
      }`),
    ).toBe(6);
  });

  it("regression guard: native generator for-of unaffected", async () => {
    expect(
      await runStandalone(`function* g() { yield 1; yield 2; }
      export function test(): number {
        let n = 0;
        for (const x of g()) { n += x; }
        return n;
      }`),
    ).toBe(3);
  });

  it("regression guard: native Map [k,v] for-of unaffected", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const m = new Map<string, number>();
        m.set("a", 1); m.set("b", 2);
        let n = 0;
        for (const [k, v] of m) { n += v; }
        return n;
      }`),
    ).toBe(3);
  });

  it("regression guard: spread of an any-held array unaffected", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [1, 2, 3];
        const b = [...a];
        return b.length;
      }`),
    ).toBe(3);
  });
});
