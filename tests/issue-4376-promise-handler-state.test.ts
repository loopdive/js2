// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

async function instance(source: string) {
  const result = await compile(source, { target: "standalone", platform: "deno", hostBridge: "always" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const wasm = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
  (result.importObject as { __setInstance?: (value: WebAssembly.Instance) => void })?.__setInstance?.(wasm);
  return wasm.exports as unknown as Record<string, Function>;
}

it.each(["then", "catch", "finally"])("retains %s handler state after pending settlement and drain", async (method) => {
  const e = await instance(`
    let settle:any;
    const p=new Promise(resolve => { settle=resolve; });
    export function promise():any { return p; }
    export function attach():void { p.${method}(() => 42); }
    export function complete():void { settle(42); }
  `);
  const p = e.promise();
  expect(e.__promise_boundary_has_handler(p)).toBe(0);
  e.attach();
  expect(e.__promise_boundary_has_handler(p)).toBe(1);
  e.complete();
  e.__drain_microtasks();
  expect(e.__promise_boundary_state(p)).toBe(1);
  expect(e.__promise_boundary_has_handler(p)).toBe(1);
});

it.each(["resolve", "reject"])("marks an already %s Promise even without a callable handler", async (method) => {
  const e = await instance(`
    const p=Promise.${method}(42);
    export function promise():any { return p; }
    export function attach():void { p.then(); }
  `);
  const p = e.promise();
  expect(e.__promise_boundary_has_handler(p)).toBe(0);
  e.attach();
  e.__drain_microtasks();
  expect(e.__promise_boundary_has_handler(p)).toBe(1);
});

it("marks pending Promises explicitly and rejects non-carriers without guessing", async () => {
  const e = await instance(`
    const p=new Promise(resolve => {});
    export function promise():any { return p; }
    export function plain():any { return {value:42}; }
  `);
  const p = e.promise();
  expect(e.__promise_boundary_has_handler(p)).toBe(0);
  expect(e.__promise_boundary_mark_handled(p)).toBe(1);
  expect(e.__promise_boundary_has_handler(p)).toBe(1);
  for (const value of [null, undefined, 42, e.plain()]) {
    expect(e.__promise_boundary_has_handler(value)).toBe(-1);
    expect(e.__promise_boundary_mark_handled(value)).toBe(-1);
  }
});

it.each(["await p", "Promise.all([p])", "Promise.resolve().then(() => p)"])(
  "tracks the native reaction in %s",
  async (use) => {
    const e = await instance(`
    const p=Promise.resolve(42);
    export function promise():any { return p; }
    export async function attach():Promise<any> { return ${use}; }
  `);
    const p = e.promise();
    expect(e.__promise_boundary_has_handler(p)).toBe(0);
    e.attach();
    e.__drain_microtasks();
    expect(e.__promise_boundary_has_handler(p)).toBe(1);
  },
);

it("does not mark a native receiver when an own then override bypasses its reactions", async () => {
  const e = await instance(`
    const p=Promise.resolve(42);
    export function promise():any { return p; }
    export function attach():void { (p as any).then=() => 1; p.then(); }
  `);
  const p = e.promise();
  e.attach();
  expect(e.__promise_boundary_has_handler(p)).toBe(0);
});

it.each([
  ["dot", "$handled"],
  ["bracket", "$handled"],
  ["bracket", ""],
])("keeps handler state private from %s access to %j", async (mode, key) => {
  const access = mode === "dot" ? "(p as any).$handled" : `(p as any)[${JSON.stringify(key)}]`;
  const e = await instance(`
    const p=Promise.resolve(42);
    export function promise():any { return p; }
    export function visible():number {
      return Object.hasOwn(p,${JSON.stringify(key)}) || ${access} !== undefined ? 1 : 0;
    }
    export function overwrite():void { ${access}=0; }
    export function expando():number { return ${access}; }
  `);
  const p = e.promise();
  expect(e.visible()).toBe(0);
  e.__promise_boundary_mark_handled(p);
  expect(e.visible()).toBe(0);
  e.overwrite();
  expect(e.expando()).toBe(0);
  expect(e.__promise_boundary_has_handler(p)).toBe(1);
});
