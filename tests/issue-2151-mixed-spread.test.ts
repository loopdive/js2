// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2151 Slice 5 — MIXED-spread any-receiver method dispatch (standalone).
 *
 * `o.m(a, ...xs)` — fixed leading args followed by a single trailing DYNAMIC
 * spread (arity unknown at compile time) — on an `any`/externref closed
 * object-literal receiver returned 0 standalone. The fixed-arity dispatcher
 * (Slices 1–3) can't apply (flattenCallArgs returns null for a dynamic source)
 * and the pure-dynamic-spread vararg routing (Slice 4) only fires for a single
 * spread arg with NO fixed leading args.
 *
 * Slice 5 builds the combined arg vector at runtime — a fresh `$ObjVec`, pushes
 * each fixed leading arg (boxed to externref), then loop-appends the spread
 * source's elements (`__extern_length` + `__extern_get_idx`) — and hands it to
 * the SAME `__call_m_<name>_vararg(recv, args)` dispatcher introduced in Slice 4,
 * which reads each declared param from the vec via `__extern_get_idx`.
 *
 * Gated to `ctx.standalone` ONLY (the `__extern_get_idx` array-like / wasm-vec
 * indexing arms the dispatcher and loop-append rely on are emitted only under
 * standalone). Host-mode any-method on a closed object literal remains a
 * pre-existing limitation (out of scope, verified across all slices).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function runStandalone(src: string): Promise<{ value: number; imports: string[] }> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const inst = await instantiateWithRuntime(r);
  return {
    value: (inst.exports as { test(): number }).test(),
    imports: (r.imports ?? []).map((i) => i.name),
  };
}

describe("#2151 Slice 5 — mixed-spread any-receiver method dispatch (standalone)", () => {
  it("one fixed arg + dynamic spread: o.m(1, ...xs)", async () => {
    const { value } = await runStandalone(`export function test(): number {
      const o: any = { m(a: number, b: number, c: number) { return a * 100 + b * 10 + c; } };
      const xs = [2, 3];
      return o.m(1, ...xs) as number; }`);
    expect(value).toBe(123);
  });

  it("two fixed args + dynamic spread, threading this: o.f(1, 2, ...xs)", async () => {
    const { value } = await runStandalone(`export function test(): number {
      const o: any = { base: 10, f(a: number, b: number, c: number) { return this.base + a + b + c; } };
      const xs = [3];
      return o.f(1, 2, ...xs) as number; }`);
    expect(value).toBe(16);
  });

  it("empty dynamic spread: trailing numeric param reads 0 (missing-arg semantics)", async () => {
    const { value } = await runStandalone(`export function test(): number {
      const o: any = { m(a: number, b: number) { return a * 10 + b; } };
      const xs: number[] = [];
      return o.m(5, ...xs) as number; }`);
    expect(value).toBe(50); // a=5, b missing → 0
  });

  it("spread source from a function-returned array: o.m(1, ...mk())", async () => {
    const { value } = await runStandalone(`export function test(): number {
      function mk(): number[] { return [3, 2]; }
      const o: any = { m(a: number, b: number, c: number) { return a * 100 + b * 10 + c; } };
      return o.m(1, ...mk()) as number; }`);
    expect(value).toBe(132);
  });

  it("emits ZERO host imports (pure standalone)", async () => {
    const { imports } = await runStandalone(`export function test(): number {
      const o: any = { m(a: number, b: number) { return a + b; } };
      const xs = [2];
      return o.m(1, ...xs) as number; }`);
    expect(imports).toEqual([]);
  });

  it("Slice 1–4 regression guards still hold (0-arg, static spread, pure dynamic spread)", async () => {
    const a = await runStandalone(`export function test(): number {
      const o: any = { next() { return 7; } };
      return o.next() as number; }`);
    expect(a.value).toBe(7);
    const b = await runStandalone(`export function test(): number {
      const o: any = { m(a: number, b: number) { return a * 10 + b; } };
      return o.m(...[2, 3]) as number; }`);
    expect(b.value).toBe(23);
    const c = await runStandalone(`export function test(): number {
      const o: any = { m(a: number, b: number) { return a * 10 + b; } };
      const xs = [4, 5];
      return o.m(...xs) as number; }`);
    expect(c.value).toBe(45);
  });
});
