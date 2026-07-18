// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2578 — standalone dynamic-property multi-read of inferred-typed values.
 *
 * Regression guard. As filed (2026-06-21), reading two dynamic (`any`-typed)
 * properties off an open object and combining them into INFERRED-typed consts
 * returned 0 under `--target standalone`, even though each property read
 * correctly in isolation and the explicitly-`: number`-annotated form returned
 * the right value. The divergence pinned it to the inferred-type lowering of a
 * dynamic `__extern_get` read (wrong ValType / temp-local aliasing across two
 * consecutive dynamic reads).
 *
 * The dynamic property read/write family work (#2542 / #2515) has since fixed
 * this — every repro variant now returns the correct value. These tests lock
 * that in so the actively-churning dynamic-read path can't silently regress.
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

describe("#2578 standalone dynamic-property multi-read (inferred-typed)", () => {
  it("two inferred consts combined → 7 (was 0)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = Object.create(null, { x: { value: 3 }, y: { value: 4 } });
           const a = (o as any).x;
           const b = (o as any).y;
           return a + b;
         }`,
      ),
    ).toBe(7);
  });

  it("explicitly-annotated form still correct (no regression)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = Object.create(null, { x: { value: 3 }, y: { value: 4 } });
           const a: number = (o as any).x;
           const b: number = (o as any).y;
           return a + b;
         }`,
      ),
    ).toBe(7);
  });

  it("single dynamic read in isolation → 3", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = Object.create(null, { x: { value: 3 }, y: { value: 4 } });
           return (o as any).x;
         }`,
      ),
    ).toBe(3);
  });

  it("three inferred consts combined → 12", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = Object.create(null, { x: { value: 3 }, y: { value: 4 }, z: { value: 5 } });
           const a = (o as any).x;
           const b = (o as any).y;
           const c = (o as any).z;
           return a + b + c;
         }`,
      ),
    ).toBe(12);
  });

  it("inline combined dynamic reads (no intermediate consts) → 7", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = Object.create(null, { x: { value: 3 }, y: { value: 4 } });
           return (o as any).x + (o as any).y;
         }`,
      ),
    ).toBe(7);
  });

  it("open object-literal writes then inferred multi-read → 7", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = {};
           (o as any).x = 3;
           (o as any).y = 4;
           const a = (o as any).x;
           const b = (o as any).y;
           return a + b;
         }`,
      ),
    ).toBe(7);
  });

  it("multiply combines two inferred reads → 12 (non-additive combiner)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = Object.create(null, { x: { value: 3 }, y: { value: 4 } });
           const a = (o as any).x;
           const b = (o as any).y;
           return a * b;
         }`,
      ),
    ).toBe(12);
  });
});
