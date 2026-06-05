// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1136 residual: Array.prototype.findLast / findLastIndex were absent from the
// array-method dispatch (no method-list entry, no compile case) even though the
// runtime callback-arity table already knew them — so `arr.findLast(cb)` fell
// through to a non-native path and produced wrong results. They are now native
// reverse-iteration mirrors of find/findIndex (§23.1.3.12 / §23.1.3.13).
//
// Uses the compiler's own importObject (default JS-host mode) so the closure
// call_ref bridges for the predicate are wired exactly as production callers see.
async function runNumber(src: string): Promise<number> {
  const r = await compile(src, { skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject = (r as unknown as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary, importObject);
  return (instance.exports as { f: () => number }).f();
}

describe("#1136 Array.prototype.findLast / findLastIndex", () => {
  it("findLast returns the LAST element passing the predicate (not the first)", async () => {
    expect(
      await runNumber(`
        export function f(): number {
          const a: number[] = [1, 2, 3, 4];
          return a.findLast((x: number): boolean => x % 2 === 1);
        }
      `),
    ).toBe(3);
  });

  it("findLast returns undefined (NaN) when no element matches", async () => {
    expect(
      await runNumber(`
        export function f(): number {
          const a: number[] = [2, 4, 6];
          const v = a.findLast((x: number): boolean => x % 2 === 1);
          return Number.isNaN(v) ? -99 : (v as number);
        }
      `),
    ).toBe(-99);
  });

  it("findLastIndex returns the index of the LAST match", async () => {
    expect(
      await runNumber(`
        export function f(): number {
          const a: number[] = [1, 2, 3, 4];
          return a.findLastIndex((x: number): boolean => x % 2 === 1);
        }
      `),
    ).toBe(2);
  });

  it("findLastIndex returns -1 when no element matches", async () => {
    expect(
      await runNumber(`
        export function f(): number {
          const a: number[] = [2, 4, 6];
          return a.findLastIndex((x: number): boolean => x % 2 === 1);
        }
      `),
    ).toBe(-1);
  });

  it("findLast on a single-element array returns that element when it matches", async () => {
    expect(
      await runNumber(`
        export function f(): number {
          const a: number[] = [7];
          return a.findLast((x: number): boolean => x > 0);
        }
      `),
    ).toBe(7);
  });

  it("does not regress find/findIndex (forward iteration still returns first match)", async () => {
    expect(
      await runNumber(`
        export function f(): number {
          const a: number[] = [1, 2, 3, 4];
          return a.find((x: number): boolean => x % 2 === 1) * 10 + a.findIndex((x: number): boolean => x % 2 === 1);
        }
      `),
    ).toBe(10); // find→1, findIndex→0  =>  1*10 + 0
  });
});
