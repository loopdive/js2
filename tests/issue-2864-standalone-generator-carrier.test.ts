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

describe("#2864 R1 yield* completion-value binding (standalone)", () => {
  it("verify-first: const x = yield* inner() binds the inner's return value", async () => {
    expect(
      await runStandalone(`function* inner() { yield 1; return 42; }
function* g() { const x = yield* inner(); yield x; }
export function test(): number {
  let s = 0;
  for (const v of g()) s += v;
  return s; // 1 (delegated) + 42 (bound return value)
}`),
    ).toBe(43);
  });

  it("binding survives a later suspension (spill round-trip)", async () => {
    expect(
      await runStandalone(`function* inner() { yield 1; return 42; }
function* g() { const x = yield* inner(); yield 7; yield x; }
export function test(): number {
  const it = g();
  let s = 0;
  let r = it.next();
  while (!r.done) { s = s * 100 + (r.value as number); r = it.next(); }
  return s; // 1, 7, 42 → 10742
}`),
    ).toBe(10742);
  });

  it("binding works in a boxed-any (mixed-yield) outer", async () => {
    expect(
      await runStandalone(`function* inner() { yield 1; return 5; }
function* g() { const x = yield* inner(); yield {a: x}; }
export function test(): number {
  let s = 0;
  for (const v of g()) { s += (typeof v === "number") ? (v as number) : (v as any).a; }
  return s; // 1 + 5
}`),
    ).toBe(6);
  });

  it("two delegation sites, first one bound", async () => {
    expect(
      await runStandalone(`function* a() { yield 1; return 10; }
function* b() { yield 2; }
function* g() { const x = yield* a(); yield* b(); yield x; }
export function test(): number {
  let s = 0;
  for (const v of g()) s = s * 100 + v;
  return s; // 1, 2, 10 → 10210
}`),
    ).toBe(10210);
  });

  it("string-outer delegation refuses cleanly (#680) instead of emitting invalid wasm", async () => {
    // Latent since #2170/#2171: a string-carrier outer delegating to an f64
    // inner passed the plan gate (which only checked the INNER's elem type) and
    // the emitted module FAILED WASM VALIDATION at instantiation (f64 value
    // into the outer's concrete-ref result field — no fixups.ts repair exists
    // for that pair). The R1 gate bails the shape to the host path, which under
    // standalone is the scoped #680 compile refusal — correct-not-wrong.
    const r = await compile(
      `function* inner() { yield 1; }
function* g() { yield* inner(); yield "s"; }
export function test(): number { let n = 0; for (const x of g()) n++; return n; }`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success).toBe(false);
    expect(r.errors?.[0]?.message ?? "").toContain("#680");
  });
});

// #2864 D2 — delegation abrupt forwarding (iterator close through `yield*`,
// §27.5.3.7 steps 7.b/7.c). A `.return(v)` / `.throw(e)` on the OUTER while
// suspended mid-delegation now (a) drives the INNER's resume once with the same
// abrupt mode + payloads — so the inner's `finally` blocks run — then (b)
// continues the outer's own abrupt path (its finalizers, then complete/throw).
// Previously the outer completed WITHOUT closing the inner (inner finalizers
// silently skipped). The slice also dedicates a state to every self-suspending
// yield-star terminator, fixing three protocol bugs at once: a first-statement
// `yield*` suspension was misclassified as NOT-STARTED by the dispatch (state
// 0), the state's prelude statements re-ran on every mid-delegation `.next()`,
// and a preceding `const x = yield …` resume binding was clobbered by later
// `.next(v)` values during delegation.
describe("#2864 D2 delegation abrupt forwarding (standalone)", () => {
  it("M3 probe: .return(v) mid-delegation runs the inner finally, completes with v", async () => {
    expect(
      await runStandalone(`let log = 0;
function* inner() { try { yield 1; yield 2; } finally { log = 100; } }
function* outer() { yield* inner(); }
export function test(): number {
  const it = outer();
  it.next();                       // 1 — suspended mid-delegation
  const r = it.return(7 as any);
  return log * 1000 + (r.value as number) * 10 + (r.done ? 1 : 0);
}`),
    ).toBe(100071); // inner finally ran (100), value 7, done
  });

  it(".throw(e) mid-delegation runs the inner finally then propagates to the caller", async () => {
    expect(
      await runStandalone(`let log = 0;
function* inner() { try { yield 1; yield 2; } finally { log = 100; } }
function* outer() { yield* inner(); }
export function test(): number {
  const it = outer();
  it.next();
  let caught = 0;
  try { it.throw(new Error("boom")); } catch (e) { caught = 1; }
  return log * 10 + caught;
}`),
    ).toBe(1001);
  });

  it("outer finally around the yield* also runs — inner first, outer second", async () => {
    expect(
      await runStandalone(`let ord = 0;
let innerAt = 0;
let outerAt = 0;
function* inner() { try { yield 1; } finally { ord = ord + 1; innerAt = ord; } }
function* outer() { try { yield* inner(); } finally { ord = ord + 1; outerAt = ord; } }
export function test(): number {
  const it = outer();
  it.next();
  it.return(5 as any);
  return innerAt * 10 + outerAt;
}`),
    ).toBe(12);
  });

  it(".return(v) at a plain-yield suspension BEFORE delegation starts skips the inner", async () => {
    expect(
      await runStandalone(`let log = 0;
function* inner() { try { yield 1; } finally { log = 100; } }
function* outer() { yield 0; yield* inner(); }
export function test(): number {
  const it = outer();
  it.next(); // 0 — inner NOT constructed yet
  const r = it.return(7 as any);
  return log * 1000 + (r.value as number) * 10 + (r.done ? 1 : 0);
}`),
    ).toBe(71); // inner never ran → its finally must not run
  });

  it("an inner finally that throws during close converts .return into a throw completion", async () => {
    expect(
      await runStandalone(`let log = 0;
function* inner() { try { yield 1; } finally { log = 100; throw new Error("replace"); } }
function* outer() { yield* inner(); }
export function test(): number {
  const it = outer();
  it.next();
  let caught = 0;
  try { it.return(7 as any); } catch (e) { caught = 1; }
  return log * 10 + caught;
}`),
    ).toBe(1001);
  });

  it("loop-carried yield*: normal pass completes the inner, close hits only the live one", async () => {
    expect(
      await runStandalone(`let log = 0;
function* inner() { try { yield 1; yield 2; } finally { log = log + 100; } }
function* outer() { for (let i = 0; i < 2; i = i + 1) { yield* inner(); } }
export function test(): number {
  const it = outer();
  it.next(); // 1 (pass 0)
  it.next(); // 2
  it.next(); // 1 (pass 1) — first inner completed normally (finally ran)
  const r = it.return(7 as any);   // closes the second inner
  return log * 1000 + (r.value as number) * 10 + (r.done ? 1 : 0);
}`),
    ).toBe(200071);
  });

  it(".next() after a mid-delegation close follows the done protocol", async () => {
    expect(
      await runStandalone(`function* inner() { yield 1; yield 2; }
function* outer() { yield* inner(); }
export function test(): number {
  const it = outer();
  it.next();
  it.return(7 as any);
  const r = it.next();
  return r.done ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("first-statement yield* suspension is not misclassified as not-started (vec delegate)", async () => {
    expect(
      await runStandalone(`function* g() { yield* [1, 2, 3]; }
export function test(): number {
  const it = g();
  it.next(); // 1
  const r = it.return(7 as any);
  return (r.value as number) * 10 + (r.done ? 1 : 0);
}`),
    ).toBe(71);
  });

  it("yield-star state prelude runs ONCE, not per mid-delegation .next()", async () => {
    expect(
      await runStandalone(`let calls = 0;
function count(): number { calls = calls + 1; return calls; }
function* inner2() { yield 1; yield 2; }
function* outer2() { const a = count(); yield* inner2(); yield a; }
export function test(): number {
  const it = outer2();
  it.next(); // runs count() once → a=1, delegates → 1
  it.next(); // 2 — must NOT re-run count()
  const r3 = it.next(); // inner done → yield a
  return calls * 10 + (r3.value as number);
}`),
    ).toBe(11);
  });

  it("a resume binding preceding the yield* survives mid-delegation .next(v) values", async () => {
    expect(
      await runStandalone(`function* inner3() { yield 10; yield 20; }
function* outer3(): Generator<number, void, number> {
  const x = yield 1;
  yield* inner3();
  yield x;
}
export function test(): number {
  const it = outer3();
  it.next(0); // → 1
  it.next(5); // x=5, delegation starts → 10
  it.next(9); // mid-delegation → 20 (must not clobber x)
  const r = it.next(7); // inner done → yield x
  return r.value as number;
}`),
    ).toBe(5);
  });
});
