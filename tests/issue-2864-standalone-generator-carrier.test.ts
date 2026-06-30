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

// #2864 F1b — typed live-across-yield LOCAL spills. F1 spilled only f64 (numeric)
// or a uniform native-string ref; a generator with an OBJECT / STRING / typed
// local carried across a `yield` either mis-compiled (the f64 spill field could
// not hold a `ref`) or bailed to the host path. F1b types each spill field at the
// local's ACTUAL ValType (resolved by `resolveSpillLocalValType`, mirroring the
// resume function's var-declaration), so the value survives the frame host-free.
describe("#2864 F1b typed live-across-yield local spills (standalone)", () => {
  it("verify-first: object local carried across a yield, host-free + correct", async () => {
    // The exact case from the issue: `function* g(){ let o={n:1}; yield 1; yield o.n }`.
    expect(
      await runStandalone(`function* g() { let o = {n:1}; yield 1; yield o.n; }
export function test(): number {
  let it = g();
  let a = it.next().value as number;
  let b = it.next().value as number;
  return a + b; // 1 + 1 — the object survived the suspension and o.n read back
}`),
    ).toBe(2);
  });

  it("string local carried across a yield in a numeric generator", async () => {
    expect(
      await runStandalone(`function* g() { let s = "abc"; yield 1; yield s.length; }
export function test(): number {
  let it = g();
  let a = it.next().value as number;
  let b = it.next().value as number;
  return a + b; // 1 + 3
}`),
    ).toBe(4);
  });

  it("object yield carrier WITH an object local spill (both externref)", async () => {
    expect(
      await runStandalone(`function* g() { let o = {a:1}; yield {a:10}; yield o; }
export function test(): number {
  let it = g();
  let r1 = it.next().value as any;
  let r2 = it.next().value as any;
  return r1.a + r2.a; // 10 + 1
}`),
    ).toBe(11);
  });

  it("loop-carried object spill consumed via for-of, host-free", async () => {
    expect(
      await runStandalone(`function* g() {
  let base = {a:5};
  let i = 0;
  while (i < 2) { yield {a: base.a + i}; i = i + 1; }
}
export function test(): number {
  let s = 0;
  for (const o of g()) { s += (o as any).a; }
  return s; // (5+0) + (5+1) = 11
}`),
    ).toBe(11);
  });

  it("numeric local spill stays on the f64 fast path (unchanged)", async () => {
    expect(
      await runStandalone(`function* g() { let n = 5; yield 1; yield n; }
export function test(): number {
  let it = g();
  return (it.next().value as number) + (it.next().value as number); // 1 + 5
}`),
    ).toBe(6);
  });

  it("typed-numeric .next(v) resume binding carried across a yield", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number, void, number> { let x = yield 1; yield x + 10; }
export function test(): number {
  let it = g();
  it.next();
  return it.next(5).value as number; // 5 + 10
}`),
    ).toBe(15);
  });
});

// #2864 F2 — `gen.throw()` abrupt completion. F1 wired `.return()` (mode 1, run
// finalizers + complete); `.throw()` was unimplemented (the open dispatch lumped
// it with `.return()` so it silently completed instead of throwing, and never ran
// the finally). F2 adds a dedicated externref error slot, a `.throw()` dispatch
// (direct + open), and a mode-2 resume arm that runs the enclosing finalizers
// then RE-THROWS — so the error surfaces to the `.throw(e)` caller host-free.
// (try/catch-ACROSS-yield is the next slice; it still bails to the host path.)
describe("#2864 F2 gen.throw() abrupt completion (standalone)", () => {
  it("verify-first: throw() runs the enclosing finally, then propagates", async () => {
    expect(
      await runStandalone(`let log = 0;
function* g() { try { yield 1; yield 2; } finally { log = 42; } }
export function test(): number {
  let it = g();
  it.next();
  let propagated = 0;
  try { it.throw(new Error("boom")); } catch (e) { propagated = 1; }
  return log + propagated; // 42 (finally ran) + 1 (error propagated)
}`),
    ).toBe(43);
  });

  it("throw() on a generator suspended at a plain yield propagates the error", async () => {
    expect(
      await runStandalone(`function* g() { yield 1; yield 2; }
export function test(): number {
  let it = g();
  it.next();
  let caught = 0;
  try { it.throw(new Error("x")); } catch (e) { caught = 1; }
  return caught;
}`),
    ).toBe(1);
  });

  it("throw() on a NOT-started generator throws (never runs the body)", async () => {
    expect(
      await runStandalone(`let ran = 0;
function* g() { ran = 1; yield 1; }
export function test(): number {
  let it = g();
  let caught = 0;
  try { it.throw(new Error("x")); } catch (e) { caught = 1; }
  return caught * 10 + ran; // 10 + 0 — error thrown, body never entered
}`),
    ).toBe(10);
  });

  it("throw() on an exhausted (done) generator throws", async () => {
    expect(
      await runStandalone(`function* g() { yield 1; }
export function test(): number {
  let it = g();
  it.next();
  it.next(); // done
  let caught = 0;
  try { it.throw(new Error("x")); } catch (e) { caught = 1; }
  return caught;
}`),
    ).toBe(1);
  });

  it("return() through a try/finally still completes (mode-1 unchanged)", async () => {
    expect(
      await runStandalone(`let log = 0;
function* g() { try { yield 1; yield 2; } finally { log = 7; } }
export function test(): number {
  let it = g();
  it.next();
  let r = it.return(99 as any);
  return log + (r.done ? 1 : 0); // 7 (finally) + 1 (done)
}`),
    ).toBe(8);
  });
});
