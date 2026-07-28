// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3723 — the WASI async drive lane must not claim an await that provably
 * cannot suspend.
 *
 * Under WASI the drive lane (#2895 PATH B) returns a real `$Promise` externref
 * and there is no host microtask queue to drain it, so a numeric consumer
 * coerces the externref to `f64` and reads **NaN**. The AG0 path compiles the
 * same function synchronously and returns the value. Claiming correlated
 * perfectly with failure, so the fix is to narrow WHAT the drive lane claims —
 * not to disable it, which would regress the genuinely-suspending shapes it
 * exists for.
 *
 * Two provable narrowings, both conservative (any uncertain answer leaves
 * today's behaviour in place):
 *
 *  1. TYPE — `await v` on a non-thenable never yields (§27.7.5.3). `any` /
 *     `unknown` may hold a thenable at runtime, and a union is safe only if
 *     every constituent is non-thenable.
 *  2. FLOW — `let p = Promise.resolve(7); … await p` is settled if `p`'s symbol
 *     has exactly one declaration, its initializer is statically settled, and
 *     nothing assigns that symbol anywhere in the enclosing function.
 *
 * The negative cases below are the load-bearing ones: they pin that a
 * REASSIGNED binding, a same-named binding in another scope, and an
 * `any`-typed operand are all still treated as able to suspend.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runWasi(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(mod), "WASI module must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary as BufferSource, {});
  return (instance.exports as { test(): number }).test();
}

const CALLER = `export function test(): number { return (f() as unknown as number); }`;

describe("#3723 — drive-lane claim narrowing (WASI)", () => {
  it("await over an arithmetic expression on a local passes through (type test)", async () => {
    expect(await runWasi(`async function f(): Promise<number> { let n = 8; return await (n + 1); }\n${CALLER}`)).toBe(
      9,
    );
  });

  it("await of a number-typed local passes through (type test)", async () => {
    expect(await runWasi(`async function f(): Promise<number> { const n = 41; return await n; }\n${CALLER}`)).toBe(41);
  });

  it("await of a write-once local holding Promise.resolve unwraps (flow test)", async () => {
    expect(
      await runWasi(`async function f(): Promise<number> { let p = Promise.resolve(7); return await p; }\n${CALLER}`),
    ).toBe(7);
  });

  it("the settled local still works when read after other statements", async () => {
    expect(
      await runWasi(
        `async function f(): Promise<number> { let p = Promise.resolve(5); let k = 1; k = k + 1; return (await p) + k; }\n${CALLER}`,
      ),
    ).toBe(7);
  });

  // ── negative cases: these must NOT be treated as settled ──────────────────

  it("a REASSIGNED binding is not treated as settled", async () => {
    // `p` is written twice, so its value at the await is not provable from the
    // initializer. The analysis must decline; the program must still be correct.
    const src = `async function f(): Promise<number> {
      let p = Promise.resolve(1);
      p = Promise.resolve(2);
      return await p;
    }\n${CALLER}`;
    const r = await compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // Whatever lane claims it, the answer must never be the first value.
    const { instance } = await WebAssembly.instantiate(r.binary as BufferSource, {});
    const got = (instance.exports as { test(): number }).test();
    expect(got).not.toBe(1);
  });

  it("a same-named binding in a sibling scope is a different symbol", async () => {
    // The inner `p` is settled; the awaited `p` is a different symbol that is
    // reassigned. Name-based matching would wrongly call this settled — symbol
    // identity does not.
    const src = `async function f(): Promise<number> {
      let p = Promise.resolve(3);
      if (p !== null) { let inner = Promise.resolve(9); p = inner; }
      return await p;
    }\n${CALLER}`;
    const r = await compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary as BufferSource, {});
    expect((instance.exports as { test(): number }).test()).not.toBe(3);
  });

  it("an any-typed operand is still treated as able to suspend", async () => {
    // `any` may hold a thenable at runtime, so the TYPE test must decline. This
    // pins the conservative direction rather than an output value.
    const src = `async function f(): Promise<number> { const v: any = 4; return await v; }\n${CALLER}`;
    const r = await compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  it("a declaration with no initializer is not settled", async () => {
    const src = `async function f(): Promise<number> {
      let p: Promise<number>;
      p = Promise.resolve(6);
      return await p;
    }\n${CALLER}`;
    const r = await compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
