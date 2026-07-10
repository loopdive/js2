// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3125 — native Promise resolve thenable assimilation (§27.2.1.3.2).
 *
 * The native `$Promise` resolve path (`__promise_resolve_value`) must implement
 * the full Promise Resolve Functions algorithm, not just native-promise
 * adoption + direct fulfil:
 *
 *   - step 6: SameValue(resolution, promise) → reject with a TypeError
 *     (self-resolution);
 *   - steps 8-9: Get(resolution, "then") runs accessors — a poisoned getter's
 *     throw REJECTS the promise with the thrown value;
 *   - steps 10-14: a callable `then` runs as a PromiseResolveThenableJob
 *     (`then.call(resolution, resolveFn, rejectFn)` on the microtask queue,
 *     never inline), where resolveFn/rejectFn are the same `$__promise_settle_cap`
 *     capturing closures the native executor (#2959) uses;
 *   - step 11 fast path: a non-thenable fulfils directly (unchanged).
 *
 * `Promise.resolve(x)` additionally follows §27.2.4.7 PromiseResolve: a native
 * promise passes through; everything else routes through Resolve(p, x).
 *
 * Exercised on the WASI target (the always-native promise lane); every module
 * must stay ZERO-host-import (the #1326 contract). The widened-standalone lane
 * shares the same helpers (validated via the #2980 A/B harness).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runWasi(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

const PRELUDE = `declare function __drain_microtasks(): void;\n`;

describe("#3125 native Promise.resolve thenable assimilation (WASI)", () => {
  it("assimilates a user thenable ({then: function(resolve){...}})", async () => {
    expect(
      await runWasi(`${PRELUDE}
export function test(): number {
  let result = 0;
  const thenable = { then: function(resolve: any) { resolve(42); } };
  Promise.resolve(thenable).then(function(val: any) {
    result = (val === 42) ? 1 : 2;
  }, function() { result = 3; });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });

  it("assimilates recursively (thenable resolving with a thenable)", async () => {
    expect(
      await runWasi(`${PRELUDE}
export function test(): number {
  let result = 0;
  const inner = { then: function(resolve: any) { resolve(7); } };
  const outer = { then: function(resolve: any) { resolve(inner); } };
  Promise.resolve(outer).then(function(val: any) {
    result = (val === 7) ? 1 : 2;
  }, function() { result = 3; });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });

  // NOTE: the poisoned-`then`-getter cases live in tests/issue-3125-widen.test.ts —
  // they exercise the `--target standalone` accessor machinery (`Object.defineProperty`
  // getter closures are standalone-gated; the wasi lane's accessor lift still routes
  // through the host `__make_getter_callback`, a pre-existing, unrelated gap).

  it("rejects self-resolution with a truthy TypeError (executor resolve)", async () => {
    expect(
      await runWasi(`${PRELUDE}
export function test(): number {
  let result = 0;
  let cap: any = null;
  const p = new Promise(function(resolve) { cap = resolve; });
  cap(p); // resolve p with ITSELF -> §27.2.1.3.2 step 6 rejects with TypeError
  p.then(function() { result = 2; }, function(reason: any) {
    result = reason ? 1 : 4;
  });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });

  it("a `then`-returning-thenable handler result assimilates (settled chain)", async () => {
    expect(
      await runWasi(`${PRELUDE}
export function test(): number {
  let result = 0;
  const thenable = { then: function(resolve: any) { resolve(11); } };
  Promise.resolve(1).then(function() {
    return thenable; // handler result routes through Resolve -> assimilates
  }).then(function(val: any) {
    result = (val === 11) ? 1 : 2;
  }, function() { result = 3; });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });

  it("a dynamically-attached $Object `then` assimilates", async () => {
    expect(
      await runWasi(`${PRELUDE}
export function test(): number {
  let result = 0;
  const o: any = {};
  o.then = function(res: any) { res(42); };
  Promise.resolve(o).then(function(val: any) {
    result = (val === 42) ? 1 : 2;
  }, function() { result = 3; });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });

  it("non-thenable objects still fulfil directly (regression guard)", async () => {
    expect(
      await runWasi(`${PRELUDE}
export function test(): number {
  let result = 0;
  const plain = { marker: 5 };
  Promise.resolve(plain).then(function(val: any) {
    result = (val.marker === 5) ? 1 : 2;
  }, function() { result = 3; });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });

  it("non-object resolutions still fulfil directly (numbers)", async () => {
    expect(
      await runWasi(`${PRELUDE}
export function test(): number {
  let result = 0;
  Promise.resolve(42).then(function(val: any) {
    result = (val === 42) ? 1 : 2;
  }, function() { result = 3; });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });

  it("Promise.resolve(nativePromise) adopts (nested resolve unwraps)", async () => {
    expect(
      await runWasi(`${PRELUDE}
export function test(): number {
  let result = 0;
  Promise.resolve(Promise.resolve(5)).then(function(val: any) {
    result = (val === 5) ? 1 : 2;
  }, function() { result = 3; });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });
});
