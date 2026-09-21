// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 slice A2 — a `for (… of …)` loop INSIDE a generator whose body
 * suspends, lowered natively (standalone / WASI).
 *
 * `lowerStatements` had no `ForOfStatement` arm at all, so every such generator
 * fell out of the native plan and standalone answered with the #680 refusal (or
 * leaked `env::__gen_*`). The JS-host lane does not answer these either — its
 * eager buffer runs the WHOLE loop before the first `.next()`, which is exactly
 * what the first case below rejects — so this is the lane that can be correct.
 *
 * The three cases pin the three properties that are easy to get wrong:
 *   1. LAZINESS / interleaving — one loop iteration per `.next()`, in order;
 *   2. the iterator is created ONCE and survives the resume boundary;
 *   3. `.return()` at a suspension inside the body runs IteratorClose
 *      (§14.7.5.7 step 6) — the whole reason the `iter-close` unwind entry
 *      exists rather than folding the close into the loop terminator.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HOST_GEN_ITER_RE = /^(__gen_|__create_generator|__create_async_generator)/;

async function compileStandalone(src: string): Promise<{ binary: Uint8Array; imports: string[] }> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod)
    .filter((i) => HOST_GEN_ITER_RE.test(i.name))
    .map((i) => `${i.module}::${i.name}`);
  return { binary: r.binary, imports };
}

describe("#6651 A2 — suspension inside a for-of body (native generator)", () => {
  it("runs exactly one loop iteration per .next(), in source order", async () => {
    // The shape of language/statements/for-of/yield.js: an eager buffer reports
    // i === 2 after the FIRST next(); the state machine must report 1.
    const src = `let i = 0; let j = 0; let k = 0;
function* values() { yield 1; yield 1; }
const data = values();
function* control() { for (const x of data) { i++; yield; j++; } k++; }
export function test(): number {
  const c = control();
  c.next();
  const a = i * 100 + j * 10 + k;
  c.next();
  const b = i * 100 + j * 10 + k;
  c.next();
  const d = i * 100 + j * 10 + k;
  return a * 1000000 + b * 1000 + d;
}`;
    const { binary, imports } = await compileStandalone(src);
    expect(imports, "no __gen_* host import in standalone").toEqual([]);
    const { instance } = await WebAssembly.instantiate(binary, {});
    // 100 = (i1,j0,k0) · 210 = (i2,j1,k0) · 221 = (i2,j2,k1)
    expect((instance.exports as { test(): number }).test()).toBe(100210221);
  });

  it("yields the loop variable of each step across suspensions", async () => {
    // Regression pin: `__gen_delegate_step` status 0 hands back the RAW result
    // object, so the loop variable must be read out of its `.value`. Binding the
    // raw result instead left `typeof x === "number"` TRUE while `x * 2` was NaN.
    const src = `function* v() { yield 3; yield 4; }
const d = v();
function* g() { for (const x of d) { yield x * 2; } }
export function test(): number {
  const it: any = g();
  const a = it.next().value as number;
  const b = it.next().value as number;
  return a * 100 + b;
}`;
    const { binary, imports } = await compileStandalone(src);
    expect(imports).toEqual([]);
    const { instance } = await WebAssembly.instantiate(binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(608);
  });

  it(".return() at a yield inside the body closes the loop's iterator", async () => {
    // §14.7.5.7 step 6. Without the `iter-close` unwind entry the completion
    // walks straight out, the inner generator is never resumed abruptly, and its
    // `finally` — the observable proxy for IteratorClose here — never runs.
    const src = `let closed = 0;
function* inner() { try { yield 1; yield 2; } finally { closed = closed + 1; } }
const src0 = inner();
function* g() { for (const x of src0) { yield x; } }
export function test(): number {
  const a: any = g();
  a.next();
  a.return();
  return closed;
}`;
    const { binary, imports } = await compileStandalone(src);
    expect(imports).toEqual([]);
    const { instance } = await WebAssembly.instantiate(binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });
});
