// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2170 — `yield*` delegation in standalone native generators (SF-3 of #2157).
 *
 * `function* g(){ yield* inner(); yield 3; }` previously bailed to the #680
 * scoped diagnostic standalone (`buildNativeGeneratorPlan` returned null on
 * `yield*`). Slice-1 supports `yield* <native-generator-call>`: a new
 * self-suspending `yield-star` state-graph terminator drives the inner
 * generator's `__gen_resume_<inner>` in a loop, re-yielding each `{value}` until
 * the inner is done, then transitions to the successor state. The inner
 * generator's state ref is persisted across the outer generator's host
 * re-entries in a typed `ref null $InnerState` delegation slot appended to the
 * outer's state struct.
 *
 * All cases assert ZERO host imports (`runStandalone`), proving the delegation
 * is pure-WasmGC. The arbitrary-iterable delegation and `.return()`/`.throw()`
 * forwarding are tracked as follow-up slices (see the issue file).
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

describe("#2170 — yield* delegation (standalone native generators)", () => {
  it("delegate then yield (1,2,3) sums to 6", async () => {
    expect(
      await runStandalone(`function* inner(){ yield 1; yield 2; }
function* g(){ yield* inner(); yield 3; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(6);
  });

  it("yield before delegation (1, then 2,3, then 4) sums to 10", async () => {
    expect(
      await runStandalone(`function* inner(){ yield 2; yield 3; }
function* g(){ yield 1; yield* inner(); yield 4; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(10);
  });

  it("delegation only, no own yield, sums to 11", async () => {
    expect(
      await runStandalone(`function* inner(){ yield 5; yield 6; }
function* g(){ yield* inner(); }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(11);
  });

  it("two sequential delegations (1,2 then 3) sums to 6", async () => {
    expect(
      await runStandalone(`function* a(){ yield 1; yield 2; }
function* b(){ yield 3; }
function* g(){ yield* a(); yield* b(); }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(6);
  });

  it("element count across the delegation boundary is 4", async () => {
    expect(
      await runStandalone(`function* inner(){ yield 1; yield 2; yield 3; }
function* g(){ yield* inner(); yield 4; }
export function test(): number { let n=0; for (const x of g()) n++; return n; }`),
    ).toBe(4);
  });

  it("manual next() across the delegation yields inner values first", async () => {
    expect(
      await runStandalone(`function* inner(){ yield 7; yield 8; }
function* g(){ yield* inner(); yield 9; }
export function test(): number {
  const it = g();
  const a = it.next().value as number;
  const b = it.next().value as number;
  const c = it.next().value as number;
  return a * 100 + b * 10 + c;
}`),
    ).toBe(789);
  });
});
