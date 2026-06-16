// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2106 value-rep P3 — slice S3 (first increment): `Array.prototype.find` /
 * `findLast` miss observability through `??`.
 *
 * `find`/`findLast` return `undefined` on a miss (§23.1.3.8). Over a numeric
 * array js2wasm lowers the result to f64; previously the miss was a plain `0/0`
 * NaN, which `??` treats as never-nullish — so `[1,2,3].find(x=>x>5) ?? -1`
 * wrongly yielded `NaN` instead of `-1`.
 *
 * Fix: the miss now carries the DISTINGUISHED `UNDEF_F64` sentinel
 * (0x7FF00000DEADC0DE), and `compileNullishCoalescing` recognises a
 * `find`/`findLast` f64 LHS and branches on that exact sentinel (via
 * `emitIsUndefF64`) rather than plain NaN. This disambiguates a true miss from a
 * genuine NaN ELEMENT (`[NaN].find(Number.isNaN)` is a real hit, never nullish).
 *
 * Scope: the `??` observability only. `=== undefined` / `typeof` on a numeric
 * find result still need the f64→externref widening (a later S3 increment) — an
 * f64 can never be `=== undefined`.
 */

async function runNum(src: string): Promise<number | undefined> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.binary).toBeTruthy();
  const { instance } = await WebAssembly.instantiate(r.binary, (r.importObject ?? {}) as WebAssembly.Imports);
  return (instance.exports.test as () => number | undefined)?.();
}

async function runBool(src: string): Promise<number | undefined> {
  return runNum(src);
}

describe("#2106 S3 — find/findLast miss observability through ??", () => {
  it("find miss ?? rhs yields rhs (not NaN)", async () => {
    expect(await runNum(`export function test(): number { return [1,2,3].find(x=>x>5) ?? -1; }`)).toBe(-1);
  });

  it("find hit ?? rhs yields the hit", async () => {
    expect(await runNum(`export function test(): number { return [1,2,3].find(x=>x>1) ?? -1; }`)).toBe(2);
  });

  it("findLast miss ?? rhs yields rhs", async () => {
    expect(await runNum(`export function test(): number { return [1,2,3].findLast(x=>x>5) ?? -1; }`)).toBe(-1);
  });

  it("findLast hit ?? rhs yields the last hit", async () => {
    expect(await runNum(`export function test(): number { return [1,2,3].findLast(x=>x<3) ?? -1; }`)).toBe(2);
  });

  it("a genuine NaN element is a HIT, not a miss (NaN is not nullish)", async () => {
    // [NaN].find(isNaN) returns the real NaN; `?? -1` must keep NaN, not coalesce.
    expect(
      await runBool(`export function test(): boolean { return Number.isNaN([NaN].find(x=>Number.isNaN(x)) ?? 0); }`),
    ).toBe(1);
  });

  it("find hit of 0 is not coalesced (0 is not nullish)", async () => {
    expect(await runNum(`export function test(): number { return [0,1,2].find(x=>x===0) ?? -1; }`)).toBe(0);
  });

  it("arithmetic on an inline coalesced miss uses the default", async () => {
    // The `??` recognizer is syntactic (like the #2004 codePointAt case): it fires
    // for an inline `find(...) ?? rhs`. Binding the result to a local first
    // (`const v = find(...); v ?? rhs`) is NOT yet covered — that needs the
    // f64→externref result-type widening, a later S3 increment.
    expect(await runNum(`export function test(): number { return ([1,2,3].find(x=>x>9) ?? 0) + 5; }`)).toBe(5);
  });
});
