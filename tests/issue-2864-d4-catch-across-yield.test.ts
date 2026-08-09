// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2864 D4 — try/catch across a `yield` in a Wasm-native (standalone / wasi)
 * generator.
 *
 * Verify-first finding: the catch-region MACHINERY already existed (#3050
 * `lowerTryRegion`). What was broken was `doneState`, which
 * `registerNativeGenerator` derived as `plan.states.length - 1`. That id is the
 * final `done` state only for a STRAIGHT-LINE body: every structural lowering
 * (`for` / `while` / `do` / `if`, and the #3050 try-region) reserves its
 * exit/join state BEFORE lowering the nested body, so a body ENDING in one
 * leaves the fallthrough at a LOWER id and `states.length - 1` is a LIVE yield
 * successor.
 *
 * The dispatch's suspension test is
 * `suspended = state != START && state != doneState`, so with the alias in
 * place a genuinely suspended generator reported DONE: `.throw(e)` / `.return(v)`
 * took the §27.5.3.4 already-completed arm and NEVER resumed — the enclosing
 * `catch` across the yield was skipped and the error escaped as a raw wasm
 * exception.
 *
 * The bug is loop/if/try-TAIL-shaped, not try/catch-shaped; it is only
 * OBSERVABLE when there is a handler or finalizer to run, because without one
 * the already-completed arm coincides with the correct behaviour.
 *
 * Every case below compiles standalone with ZERO host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runNoHost(src: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, `${target} module must have zero host imports`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2864 D4 — doneState aliasing broke abrupt resume at a loop/try-tail suspension", () => {
  it("verify-first: try/catch as the WHOLE body — .throw() enters the catch", async () => {
    // Plan: fallthrough (the region's join) is state 3, but states.length-1 is
    // state 4 — the yield successor carrying the catch unwind. Pre-fix the
    // dispatch read state 4 as DONE and threw the error straight back at the
    // caller without ever running `catch`.
    expect(
      await runNoHost(`let log = 0;
function* g() { try { yield 1; } catch (e) { log = 5; } }
export function test(): number {
  const it = g();
  const a = it.next().value as number;
  const r = it.throw(new Error("x"));
  return log * 100 + a * 10 + (r.done ? 1 : 0);
}`),
    ).toBe(511); // catch ran (log=5), first yield was 1, generator completed
  });

  it("for-loop body with try/catch across the yield — .throw() enters the catch and the loop continues", async () => {
    expect(
      await runNoHost(`let log = 0;
function* g() { for (let i = 0; i < 3; i++) { try { yield i; } catch (e) { log += 1; } } }
export function test(): number {
  const it = g();
  const a = it.next().value as number;
  const b = it.throw(new Error("a")).value as number;
  return log * 100 + a * 10 + b;
}`),
    ).toBe(101); // caught once, yielded 0 then (after i++) 1
  });

  it("while-loop body with try/catch across the yield", async () => {
    expect(
      await runNoHost(`let log = 0;
function* g() { let i = 0; while (i < 3) { try { yield i; } catch (e) { log += 1; } i++; } }
export function test(): number {
  const it = g();
  const a = it.next().value as number;
  const b = it.throw(new Error("a")).value as number;
  return log * 100 + a * 10 + b;
}`),
    ).toBe(101);
  });

  it("nested for-loops under one try — .throw() reaches the enclosing catch", async () => {
    expect(
      await runNoHost(`let log = 0;
function* g() {
  try { for (let i = 0; i < 2; i++) { for (let j = 0; j < 2; j++) { yield j; } } } catch (e) { log = 3; }
}
export function test(): number {
  const it = g();
  const a = it.next().value as number;
  const r = it.throw(new Error("x"));
  return log * 100 + a * 10 + (r.done ? 1 : 0);
}`),
    ).toBe(301);
  });

  it("loop try/catch across yield — repeated .throw() keeps the loop alive (3 iterations)", async () => {
    expect(
      await runNoHost(`let log = 0;
function* g() { for (let i = 0; i < 3; i++) { try { yield i; } catch (e) { log += 1; } } }
export function test(): number {
  const it = g();
  let s = 0;
  s += it.next().value as number;
  s += it.throw(new Error("a")).value as number;
  s += it.throw(new Error("b")).value as number;
  return log * 100 + s;
}`),
    ).toBe(203); // 2 catches, values 0 + 1 + 2
  });

  it("wasi lane gets the same fix (loop + try/catch, .throw())", async () => {
    expect(
      await runNoHost(
        `let log = 0;
function* g() { for (let i = 0; i < 3; i++) { try { yield i; } catch (e) { log += 1; } } }
export function test(): number {
  const it = g();
  const a = it.next().value as number;
  const b = it.throw(new Error("a")).value as number;
  return log * 100 + a * 10 + b;
}`,
        "wasi",
      ),
    ).toBe(101);
  });

  it("loop tail + enclosing try/finally — .return() still runs the finally (control, was already green)", async () => {
    expect(
      await runNoHost(`let log = 0;
function* g(): Generator<number, number, unknown> {
  try { for (let i = 0; i < 3; i++) { yield i; } } finally { log = 8; }
  return 0;
}
export function test(): number {
  const it = g();
  it.next();
  const r = it.return(7);
  return log * 100 + (r.value as number);
}`),
    ).toBe(807);
  });

  it("straight-line try/catch + trailing yield — unchanged (control: curId == lastId)", async () => {
    expect(
      await runNoHost(`let log = 0;
function* g() { try { yield 1; } catch (e) { log = 5; } yield 2; }
export function test(): number {
  const it = g();
  const a = it.next().value as number;
  const b = it.throw(new Error("x")).value as number;
  return log * 100 + a * 10 + b;
}`),
    ).toBe(512);
  });

  it("if-tail with a try/finally in the taken branch — .return() runs the finally", async () => {
    expect(
      await runNoHost(`let log = 0;
function* g(): Generator<number, number, unknown> {
  if (1) { try { yield 5; } finally { log = 4; } } else { yield 6; }
  return 0;
}
export function test(): number {
  const it = g();
  it.next();
  const r = it.return(7);
  return log * 100 + (r.value as number);
}`),
    ).toBe(407);
  });

  it("loop-tail generator: exhausting past the end stays done and re-runs nothing", async () => {
    // doneState is now the real fallthrough, so a post-completion .next() lands
    // on the empty done state instead of re-entering the loop's update state.
    expect(
      await runNoHost(`let calls = 0;
function* g() { for (let i = 0; i < 2; i++) { yield i; } }
export function test(): number {
  const it = g();
  let s = 0;
  for (let k = 0; k < 5; k++) {
    const r = it.next();
    if (r.done) { s += 100; } else { s += (r.value as number) + 1; }
  }
  calls += 1;
  return s + calls;
}`),
    ).toBe(304); // (0+1)+(1+1) = 3, then 3 dones = 300, +1
  });

  it("catch across yield inside a loop, boxed-any carrier", async () => {
    expect(
      await runNoHost(`let log = 0;
function* g() { for (let i = 0; i < 3; i++) { try { yield {a: i}; } catch (e) { log += 1; } } }
export function test(): number {
  const it = g();
  const a = (it.next().value as any).a as number;
  const b = (it.throw(new Error("x")).value as any).a as number;
  return log * 100 + a * 10 + b;
}`),
    ).toBe(101);
  });
});
