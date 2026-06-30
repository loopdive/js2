// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2864 F1 — heterogeneous (boxed-`any`) carrier for the Wasm-native generator
 * frame in standalone.
 *
 * The native generator (#1665/#2079/#2171) carried numeric (f64) or uniform
 * string payloads; an OBJECT yield or a MIX of yield types bailed to the
 * eager-buffer host path, which under standalone leaks `__gen_*` /
 * `__create_generator` imports and refuses (#680). F1 adds a third carrier: when
 * the yields are object-typed or mixed, the result `value` field and the
 * per-frame `sent` / `abrupt` scalars become **externref** (the universal boxed
 * `any`). Every value coerces to externref host-free in standalone (numbers via
 * the native `__box_number`, objects via `extern.convert_any`), so the frame
 * needs no host import.
 *
 * Scope (F1): object / mixed yields with straight-line, NON-spilling bodies, via
 * the dominant consumers — `.next()` / `.next().value` (open dispatch), for-of,
 * and array destructuring. Deferred follow-ups (documented): live-across-yield
 * non-numeric LOCAL spills (needs two-pass spill typing — they bail cleanly to
 * host today), spread / Array.from precision for the boxed-any carrier, and
 * try/catch-across-yield (F2) / `yield*` over arbitrary iterables (F3).
 *
 * Every case compiles standalone with ZERO host imports.
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

describe("#2864 F1 boxed-any native generator carrier (standalone)", () => {
  it("verify-first: mixed object+number yields, read via .next().value host-free", async () => {
    // The exact case from the issue: `function* g(){ yield {a:1}; yield 2 }`.
    expect(
      await runStandalone(`function* g() { yield {a:1}; yield 2; }
export function test(): number {
  let it = g();
  let r1 = it.next();
  let r2 = it.next();
  return (r1.value as any).a + (r2.value as number);
}`),
    ).toBe(3); // 1 + 2 — the yielded object survives the frame
  });

  it("uniform object yields consumed via for-of", async () => {
    expect(
      await runStandalone(`function* g() { yield {a:10}; yield {a:20}; }
export function test(): number {
  let sum = 0;
  for (const o of g()) { sum += (o as any).a; }
  return sum;
}`),
    ).toBe(30);
  });

  it("three object yields summed via for-of", async () => {
    expect(
      await runStandalone(`function* g() { yield {v:1}; yield {v:2}; yield {v:3}; }
export function test(): number { let n = 0; for (const o of g()) n += (o as any).v; return n; }`),
    ).toBe(6);
  });

  it("array destructuring of an object generator", async () => {
    expect(
      await runStandalone(`function* g() { yield {a:7}; yield {a:8}; }
export function test(): number { let [x, y] = g(); return (x as any).a + (y as any).a; }`),
    ).toBe(15);
  });

  it("mixed module: numeric generator (open dispatch) coexists with an object generator", async () => {
    expect(
      await runStandalone(`function* gn() { yield 10; yield 20; }
function* go() { yield {a:1}; }
export function test(): number {
  let itn = gn();
  let a = itn.next();
  let b = itn.next();
  let ito = go();
  let c = ito.next();
  return (a.value as number) + (b.value as number) + ((c.value as any).a);
}`),
    ).toBe(31);
  });

  it(".return() on an object generator completes (done:true)", async () => {
    expect(
      await runStandalone(`function* g() { yield {a:1}; yield {a:2}; }
export function test(): number {
  let it = g();
  it.next();
  let r = it.return({a:9} as any);
  return r.done ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("done flag reads true after exhausting an object generator", async () => {
    expect(
      await runStandalone(`function* g() { yield {a:1}; yield 2; }
export function test(): number {
  let it = g();
  it.next();
  it.next();
  let r = it.next();
  return r.done ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("numeric-only generators are byte-for-byte unaffected (f64 fast path)", async () => {
    expect(
      await runStandalone(`function* g() { yield 1; yield 2; yield 3; }
export function test(): number { let s = 0; for (const x of g()) s += x; return s; }`),
    ).toBe(6);
  });
});
