// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2157 — standalone iterator/generator conformance residual (rank-1 gap).
 *
 * #2079 made the TOP-LEVEL native generator (sequential + control-flow yields)
 * work standalone for `for-of` and manual `next()`. This file is the
 * **test-gate suite** for the remaining residual: it pins the currently-working
 * cases as regression guards, and `it.todo`-marks the four concrete sub-fixes
 * (SF-1..SF-4, dispatched as #2172/#2169/#2170/#2171) with their exact repros so each
 * sub-task has an executable acceptance gate.
 *
 * Triage detail: plan/issues/2157-standalone-iterator-generator-conformance-residual.md
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

describe("#2157 working today — regression guards", () => {
  it("top-level generator for-of (sequential)", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; }
export function test(): number { let s=0; for (const v of g()) s+=v; return s; }`),
    ).toBe(6);
  });

  it("top-level generator manual next().value", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; }
export function test(): number { const it=g(); return (it.next().value as number); }`),
    ).toBe(1);
  });

  it("for-of over a string", async () => {
    expect(
      await runStandalone(`export function test(): number { let n=0; for (const c of "abc") n++; return n; }`),
    ).toBe(3);
  });

  it("spread of a string into an array", async () => {
    expect(await runStandalone(`export function test(): number { const a=[..."abcd"]; return a.length; }`)).toBe(4);
  });

  it("spread of an array", async () => {
    expect(
      await runStandalone(`export function test(): number { const a=[1,2,3]; const b=[...a]; return b[0]+b[1]+b[2]; }`),
    ).toBe(6);
  });

  it("for-of over a custom [Symbol.iterator] object", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const obj = { [Symbol.iterator]() { let i = 0; return { next() { return i < 3 ? { value: ++i, done: false } : { value: 0, done: true }; } }; } };
        let s = 0; for (const x of obj as any) s += x; return s; }`),
    ).toBe(6); // 1+2+3
  });
});

describe("#2157 residual sub-fixes — executable gates (currently failing)", () => {
  // SF-1 (#2172) — nested `function*` declaration takes the JS-host path → funcindex CE.
  it.todo("SF-1 #2172: nested generator for-of returns 6", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* g(){ yield 1; yield 2; yield 3; }
        let s=0; for (const v of g()) s+=v; return s; }`),
    ).toBe(6);
  });

  // SF-2 (#2169) — spread / Array.from / destructure now drive the native
  // generator via the shared `emitNativeGeneratorToVec` drain (all three
  // consumers landed: spread + Array.from in earlier slices, array-destructure
  // in this one).
  it("SF-2 #2169: spread of generator length is 3", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; }
export function test(): number { const a=[...g()]; return a.length; }`),
    ).toBe(3);
  });
  it("SF-2 #2169: Array.from(generator) length is 3", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; }
export function test(): number { const a=Array.from(g()); return a.length; }`),
    ).toBe(3);
  });
  it("SF-2 #2169: array destructure from generator a+b is 3", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; }
export function test(): number { const [a,b]=g(); return a+b; }`),
    ).toBe(3);
  });

  // SF-3 (#2170) — yield* delegation.
  it("SF-3 #2170: yield* delegation sums to 6", async () => {
    expect(
      await runStandalone(`function* inner(){ yield 1; yield 2; }
function* g(){ yield* inner(); yield 3; }
export function test(): number { let s=0; for (const v of g()) s+=v; return s; }`),
    ).toBe(6);
  });

  // SF-4 (#2171) — non-numeric (string) yields. Landed in c3eb18936; the
  // generator result/value slot is typed per the yield elem type (the native
  // `$AnyString` ref for all-string generators), so string yields iterate and
  // concatenate correctly with zero host imports.
  it("SF-4 #2171: string yields iterate 2 times", async () => {
    expect(
      await runStandalone(`function* g(){ yield "a"; yield "b"; }
export function test(): number { let n=0; for (const v of g()) n++; return n; }`),
    ).toBe(2);
  });

  it("SF-4 #2171: string yields concatenate to the right length", async () => {
    // Value-correctness, not just count: "a"+"b" → "ab" (length 2). Exercises
    // the per-yield string value flowing through the result `value` slot.
    expect(
      await runStandalone(`function* g(){ yield "a"; yield "b"; }
export function test(): number { let s=""; for (const v of g()) s+=v; return s.length; }`),
    ).toBe(2);
  });

  it("SF-4 #2171: first yielded char code is preserved", async () => {
    expect(
      await runStandalone(`function* g(){ yield "a"; yield "b"; }
export function test(): number { let s=""; for (const v of g()) s+=v; return s.charCodeAt(0); }`),
    ).toBe(97); // 'a'
  });
});
