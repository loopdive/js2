// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3145 — standalone `Atomics.<method>(...)` on a non-shared view throws a
// catchable TypeError instead of hard-CE-ing through the `__get_builtin`
// dynamic-shape refusal (#1472 Phase B).
//
// A host-free target (`--target standalone` / `wasi`) has no `SharedArrayBuffer`
// (skip-listed) and no shared-memory atomics backend, so every Atomics operation
// runs on a necessarily non-shared view — which the ES spec rejects:
// `ValidateIntegerTypedArray` throws a TypeError for float/clamped views and for
// the non-`Int32Array`/`BigInt64Array` views the waitable ops require, and a
// detached buffer is likewise a TypeError. Rather than leak the unsatisfiable
// `env::__get_builtin` host import, the direct CALL degrades to a catchable
// TypeError — identical to the throwing first-class VALUE closure #2984 Phase 3
// already reifies for `Atomics.<m>`. This flips the ~29 non-SAB
// `built-ins/Atomics/*` error-path tests (which assert exactly this throw).
//
// (#7011) Real single-agent Atomics semantics now exist (atomics/atomics-native.ts);
// these rows keep pinning the TypeError paths that remain spec-required.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, {
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

// Each value-mutating / accessing Atomics op, called on a non-atomics-friendly
// (float / clamped) integer view, must throw a *catchable* TypeError. The
// callback catches and reports 1 only for `e instanceof TypeError`.
describe("#3145: standalone Atomics.<method> throws a catchable TypeError", () => {
  const intMethods: Array<[string, string]> = [
    ["add", "Atomics.add(v, 0, 1)"],
    ["sub", "Atomics.sub(v, 0, 1)"],
    ["and", "Atomics.and(v, 0, 1)"],
    ["or", "Atomics.or(v, 0, 1)"],
    ["xor", "Atomics.xor(v, 0, 1)"],
    ["load", "Atomics.load(v, 0)"],
    ["store", "Atomics.store(v, 0, 1)"],
    ["exchange", "Atomics.exchange(v, 0, 1)"],
    ["compareExchange", "Atomics.compareExchange(v, 0, 0, 1)"],
  ];

  for (const [name, call] of intMethods) {
    it(`Atomics.${name} on a Float32Array view throws TypeError`, async () => {
      const ret = await runStandalone(`
        const b = new ArrayBuffer(16);
        const v = new Float32Array(b) as any;
        let t = 0;
        try { ${call}; t = 2; } catch (e) { t = (e instanceof TypeError) ? 1 : 3; }
        return t;
      `);
      expect(ret).toBe(1);
    });
  }

  it("Atomics.notify on a valid Int32Array over a non-shared buffer returns 0 (#7011)", async () => {
    // (#7011) §25.4.15 Atomics.notify: a non-shared buffer is NOT an error —
    // step 9 returns +0 (no agent can be waiting on it). The pre-#7011 blanket
    // TypeError was the "no native Atomics" stand-in.
    const ret = await runStandalone(`
      const v = new Int32Array(new ArrayBuffer(16)) as any;
      return Atomics.notify(v, 0, 0) + 10;
    `);
    expect(ret).toBe(10);
  });

  it("Atomics.wait / Atomics.waitAsync throw TypeError", async () => {
    const ret = await runStandalone(`
      const v = new Int32Array(new ArrayBuffer(16)) as any;
      let hits = 0;
      try { Atomics.wait(v, 0, 0, 0); } catch (e) { if (e instanceof TypeError) hits = hits + 1; }
      try { Atomics.waitAsync(v, 0, 0, 0); } catch (e) { if (e instanceof TypeError) hits = hits + 1; }
      return hits;
    `);
    expect(ret).toBe(2);
  });

  it("throws BEFORE coercing the index/value arguments (spec ordering)", async () => {
    // The spec type-check throws before ToIndex / ToInteger, so a poisoned
    // `valueOf` on the index/value args must never run. (This is what the
    // test262 `notify(view, {valueOf(){throw}}, …)` error tests assert.)
    const ret = await runStandalone(`
      let coerced = 0;
      const poisoned = { valueOf() { coerced = 1; return 0; } };
      // (#7011) A Float32Array fails ValidateIntegerTypedArray, the first step.
      const v = new Float32Array(new ArrayBuffer(16)) as any;
      let threw = 0;
      try { Atomics.notify(v, poisoned as any, poisoned as any); } catch (e) { threw = 1; }
      // pass only when it threw AND the poisoned valueOf was never invoked.
      return (threw === 1 && coerced === 0) ? 1 : 0;
    `);
    expect(ret).toBe(1);
  });

  it("keeps `typeof Atomics.<method>` === 'function' (value path, #2984 Phase 3)", async () => {
    const ret = await runStandalone(`
      let hits = 0;
      if (typeof Atomics.add === 'function') hits = hits + 1;
      if (typeof Atomics.wait === 'function') hits = hits + 1;
      if (typeof Atomics.waitAsync === 'function') hits = hits + 1;
      if (typeof Atomics.notify === 'function') hits = hits + 1;
      return hits;
    `);
    expect(ret).toBe(4);
  });

  it("does not hijack a user-defined local `Atomics` binding", async () => {
    // A shadowing local must win — the fast-path fires only for the GLOBAL
    // Atomics namespace.
    const ret = await runStandalone(`
      const Atomics = { sub: (_a: any, _b: any, _c: any): number => 7 };
      return Atomics.sub(0, 0, 0);
    `);
    expect(ret).toBe(7);
  });
});
