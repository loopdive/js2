// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3125 — poisoned-`then` assimilation on the WIDENED-standalone lane.
 *
 * These cases need `--target standalone` (the `Object.defineProperty` accessor
 * closure machinery — #1888 S5b/S5c — is standalone-gated; the wasi lane's
 * accessor lift still routes through the host `__make_getter_callback`, a
 * pre-existing, unrelated gap) AND the native promise carrier, which on
 * standalone is only active under the #2980 measure toggle
 * `JS2WASM_ASYNC_CARRIER_WIDEN`. That toggle is read at MODULE LOAD of
 * `src/codegen/async-scheduler.ts`, so this file sets it BEFORE importing the
 * compiler (own test file ⇒ own module registry under the vitest forks pool)
 * and restores it afterwards so sibling files in the same fork are unaffected.
 *
 * Covered shapes (the #2980 tradeoff-doc "native-resolve thenable
 * assimilation" regressions — resolve-poisoned-then / resolve-settled-*-
 * poisoned-then):
 *   - `Object.defineProperty({}, 'then', {get})` INLINE target — the accessor
 *     mirrors into the #1888 S5c per-(struct,prop) global (object-ops.ts
 *     mirror arm) and the `__promise_has_callable_then` predicate's
 *     struct-accessor arm RUNS the getter (spec Get) → the throw rejects;
 *   - the `const o: any = {}` `$Object` target — the predicate's `$Object`
 *     arm Gets "then" through `__extern_get`, which drives the S5b
 *     `$PropEntry` accessor.
 */
import { afterAll, describe, expect, it } from "vitest";

process.env.JS2WASM_ASYNC_CARRIER_WIDEN = "1";
const { compile } = await import("../src/index.js");

afterAll(() => {
  // biome noDelete: assigning undefined to process.env coerces to the string
  // "undefined" — use a falsy-but-parseable sentinel the gate treats as OFF.
  process.env.JS2WASM_ASYNC_CARRIER_WIDEN = "";
});

async function runWidenStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // The standalone `.then` lowering compiles a host FALLBACK arm alongside the
  // native arm (#3035 receiver dispatch), so `env` imports may exist but must
  // never be CALLED for native receivers — stub them to throw.
  const envStub = new Proxy(
    {},
    {
      get: (_t, name) => () => {
        throw new Error(`env.${String(name)} host stub called — native path expected`);
      },
    },
  );
  const { instance } = await WebAssembly.instantiate(r.binary, { env: envStub });
  return (instance.exports as { test(): number }).test();
}

const PRELUDE = `declare function __drain_microtasks(): void;\n`;

describe("#3125 poisoned-then assimilation (widened standalone)", () => {
  it("rejects on a poisoned `then` getter (inline defineProperty target)", async () => {
    expect(
      await runWidenStandalone(`${PRELUDE}
export function test(): number {
  let result = 0;
  const value = { marker: 7 };
  const poisoned = Object.defineProperty({}, 'then', { get: function() { throw value; } });
  Promise.resolve(poisoned).then(function() { result = 2; }, function(val: any) {
    result = (val === value) ? 1 : 4;
  });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });

  it("rejects on a poisoned `then` getter (any-typed $Object target)", async () => {
    expect(
      await runWidenStandalone(`${PRELUDE}
export function test(): number {
  let result = 0;
  const value = { marker: 7 };
  const o: any = {};
  Object.defineProperty(o, 'then', { get: function() { throw value; } });
  Promise.resolve(o).then(function() { result = 2; }, function(val: any) {
    result = (val === value) ? 1 : 4;
  });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });

  it("a handler returning a poisoned object rejects the chained promise", async () => {
    expect(
      await runWidenStandalone(`${PRELUDE}
export function test(): number {
  let result = 0;
  const value = { marker: 7 };
  const poisoned = Object.defineProperty({}, 'then', { get: function() { throw value; } });
  Promise.resolve(1).then(function() {
    return poisoned; // handler result routes through Resolve -> Get throws -> reject
  }).then(function() { result = 2; }, function(val: any) {
    result = (val === value) ? 1 : 4;
  });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });

  it("a non-throwing accessor `then` still fulfils when non-callable", async () => {
    expect(
      await runWidenStandalone(`${PRELUDE}
export function test(): number {
  let result = 0;
  const o = Object.defineProperty({}, 'then', { get: function() { return 5; } });
  Promise.resolve(o).then(function(val: any) {
    result = (val === o) ? 1 : 2; // then not callable -> fulfil with the object
  }, function() { result = 3; });
  __drain_microtasks();
  return result;
}`),
    ).toBe(1);
  });
});
