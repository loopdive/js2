// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2649 — Standalone `TypedArray.prototype.subarray(...).length` returned 0.
 *
 * In `--target standalone`/`wasi`, `subarray` builds a `$__subview` struct that
 * shares the parent's backing array (byteOffset + windowed length). Element
 * reads worked (they discriminate the `$__subview` type), but the `.length`
 * read did NOT: the length dispatch used the receiver's STATIC TS type
 * (`Int8Array` → plain `$__vec`) and `ref.test`ed the value against that plain
 * vec type. A `$__subview` value fails that test, so the read fell to the `0`
 * fallback. Fix: when the compiled receiver is a known `$__subview` ref type,
 * read its field-0 length directly (property-access-dispatch.ts). This is a
 * standalone-only path — gc/host mode returns a copy (plain vec) whose length
 * already read correctly.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  expect(WebAssembly.validate(r.binary as unknown as BufferSource)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary as unknown as BufferSource, {});
  return (instance.exports as Record<string, () => number>).test!();
}

describe("#2649 standalone TypedArray.prototype.subarray length", () => {
  it("subarray(begin).length is the windowed length, not 0", async () => {
    expect(
      await runStandalone(
        `export function test(){ const a=new Int8Array([10,11,12,13]); return a.subarray(1).length; }`,
      ),
    ).toBe(3);
  });

  it("subarray(begin,end).length reflects the window", async () => {
    expect(
      await runStandalone(
        `export function test(){ const a=new Int8Array([10,11,12,13]); return a.subarray(0,2).length; }`,
      ),
    ).toBe(2);
  });

  it("subarray().length is the full length", async () => {
    expect(
      await runStandalone(
        `export function test(){ const a=new Int8Array([10,11,12,13]); return a.subarray().length; }`,
      ),
    ).toBe(4);
  });

  it("element access through the subview still works (regression guard)", async () => {
    expect(
      await runStandalone(`export function test(){ const a=new Int8Array([10,11,12,13]); return a.subarray(1)[0]; }`),
    ).toBe(11);
  });

  it("negative begin clamps against length", async () => {
    expect(
      await runStandalone(`export function test(){ const a=new Int8Array([1,2,3,4]); return a.subarray(-2).length; }`),
    ).toBe(2);
  });

  it("negative end clamps against length", async () => {
    expect(
      await runStandalone(
        `export function test(){ const a=new Int8Array([1,2,3,4]); return a.subarray(1,-1).length; }`,
      ),
    ).toBe(2);
  });

  it("length reads correctly off a subview stored in a local", async () => {
    expect(
      await runStandalone(
        `export function test(){ const a=new Int32Array([5,6,7,8,9]); const s=a.subarray(2); return s.length; }`,
      ),
    ).toBe(3);
  });

  it("nested subarray accumulates offsets and windows the length", async () => {
    expect(
      await runStandalone(
        `export function test(){ const a=new Int8Array([0,1,2,3,4,5]); return a.subarray(1).subarray(1).length; }`,
      ),
    ).toBe(4);
  });

  it("works for a 16-bit element view", async () => {
    expect(
      await runStandalone(
        `export function test(){ const a=new Uint16Array([10,20,30,40]); return a.subarray(1,3).length; }`,
      ),
    ).toBe(2);
  });

  it("length drives an element-summing loop over the subview", async () => {
    expect(
      await runStandalone(
        `export function test(){ const a=new Int8Array([10,11,12,13]); const s=a.subarray(1); let t=0; for(let i=0;i<s.length;i++) t+=s[i]; return t; }`,
      ),
    ).toBe(36);
  });
});
