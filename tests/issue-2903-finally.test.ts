// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2903 (finally sub-front) — native `Promise.prototype.finally` (§27.2.5.3).
//
// Pre-native, standalone `.finally` on a native `$Promise` receiver routed to
// the host `Promise_finally` import, which received a WasmGC struct it cannot
// chain — the import threw, the async-call catch_all swallowed it into a
// rejected-with-null `$Promise`: the callback was silently DROPPED and the
// rejection reason identity LOST (measured on main 2026-07-11). The native
// lowering (`emitStandalonePromiseFinally`, async-scheduler.ts) runs onFinally
// with ZERO args on both settlement arms, preserves the original
// value/reason (identity included), lets a throwing/rejecting onFinally
// OVERRIDE the settlement, and drops the `Promise_finally`/`__make_callback`
// imports — un-flagging `.finally`-using modules for the #2903 then-bridge
// de-leak (the `.finally` syntactic producer flag is retired).
//
// Genuine host-promise producers (dynamic import(), fromAsync, …) keep the
// legacy host route. A statically-known Promise subclass on the standalone
// lane now carries a native `$Promise`, so its receiver is handled here too.
// gc/host lane is untouched.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const DRAIN = "declare function __drain_microtasks(): void;\n";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  return result;
}

function importNames(result: { imports?: { name: string }[] }): string[] {
  return (result.imports ?? []).map((i) => i.name).sort();
}

async function runHostFree(result: { binary?: Uint8Array }): Promise<number> {
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2903 — native .finally on the standalone $Promise carrier", () => {
  it("fulfilled: onFinally runs with ZERO args, value passes through untouched", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
let code = 0;
export function test(): number {
  const obj = { k: 1 };
  Promise.resolve(obj)
    .finally(function() { code += 100; })
    .then((v: any) => { code += v === obj ? 10 : 5; });
  __drain_microtasks();
  return code; // 110 = onFinally ran + identity preserved
}`,
    );
    expect(importNames(result)).toEqual([]); // host-free: no Promise_finally, no __make_callback
    expect(await runHostFree(result)).toBe(110);
  });

  it("rejected: reason passes through with identity, onFinally cannot convert to fulfillment by returning", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
let code = 0;
export function test(): number {
  const boom = new Error("boom");
  Promise.reject(boom)
    .finally(function() { code += 100; return { replacement: true }; })
    .then((v: any) => { code += 1000; }, (reason: any) => { code += reason === boom ? 10 : 5; });
  __drain_microtasks();
  return code; // 110 = onFinally ran + rejection preserved with identity
}`,
    );
    expect(importNames(result)).toEqual([]);
    expect(await runHostFree(result)).toBe(110);
  });

  it("throwing onFinally OVERRIDES the settlement with its own error", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
let code = 0;
export function test(): number {
  const override = new Error("override");
  Promise.resolve(1)
    .finally(function() { throw override; })
    .then((v: any) => { code += 1000; }, (reason: any) => { code += reason === override ? 10 : 5; });
  __drain_microtasks();
  return code; // 10 = rejected with the thrown error
}`,
    );
    expect(importNames(result)).toEqual([]);
    expect(await runHostFree(result)).toBe(10);
  });

  it("zero-arg .finally() is an identity pass-through hop", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
let code = 0;
export function test(): number {
  Promise.resolve(7).finally().then((v: any) => { code = v; });
  __drain_microtasks();
  return code; // 7
}`,
    );
    expect(importNames(result)).toEqual([]);
    expect(await runHostFree(result)).toBe(7);
  });

  it("chains: .finally between two .then hops keeps the whole chain host-free", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
let acc = 0;
export function test(): number {
  Promise.resolve(1)
    .then((v: any) => { acc += v; return 2; })
    .finally(() => { acc += 100; })
    .then((v: any) => { acc += v; });
  __drain_microtasks();
  return acc; // 1 + 100 + 2 = 103
}`,
    );
    expect(importNames(result)).toEqual([]);
    expect(await runHostFree(result)).toBe(103);
  });

  it("any-typed receiver: native $Promise routes through the bridge natively", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
let code = 0;
export function test(): number {
  const p: any = Promise.resolve(3);
  p.finally(() => { code += 100; }).then((v: any) => { code += v; });
  __drain_microtasks();
  return code; // 103
}`,
    );
    expect(importNames(result)).toEqual([]);
    expect(await runHostFree(result)).toBe(103);
  });
});

describe("#2903 — native Promise-subclass receivers", () => {
  it("class X extends Promise keeps .finally/.then host-free and settles", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
class FooPromise extends Promise<any> {}
let code = 0;
export function test(): number {
  FooPromise.resolve(40)
    .finally(() => { code += 1; })
    .then((value: number) => { code += value; });
  __drain_microtasks();
  return code;
}`,
    );
    expect(importNames(result)).not.toContain("Promise_finally");
    expect(await runHostFree(result)).toBe(41);
  });
});

describe("#2903 — other lanes untouched", () => {
  it("gc/host lane still uses the host Promise_finally import", async () => {
    const result = await compile(
      DRAIN +
        `
export function test(): number {
  Promise.resolve(5).finally(() => {});
  __drain_microtasks();
  return 1;
}`,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    expect(importNames(result)).toContain("Promise_finally");
  });

  it("wasi lane: .finally is native — zero Promise_*/__make_callback imports", async () => {
    const result = await compile(
      `
let code = 0;
export function test(): number {
  Promise.resolve(5).finally(() => { code += 100; }).then((v: number) => { code += v; });
  return 1;
}`,
      { fileName: "test.ts", target: "wasi", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const names = importNames(result).filter((n) => n.startsWith("Promise_") || n === "__make_callback");
    expect(names).toEqual([]);
  });
});
