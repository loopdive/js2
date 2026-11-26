// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2069 — `fn.call(thisArg, …)` / `fn.apply(thisArg, [...])` silently discarded
// thisArg for functions declared with an explicit TypeScript `this` parameter.
//
// Such a function materializes a leading `externref` `this` slot in its Wasm
// signature. The legacy `.call`/`.apply` lowering evaluated the thisArg, dropped
// it, and passed `undefined` for `this` — and, because it then fed the user args
// starting at param 0, it also shifted every argument into the wrong slot.
//
// Fix: when the named callee has an explicit `this` param, rewrite the
// `.call`/`.apply` to a direct call that supplies the thisArg as the first
// positional argument (which lands in the `this` slot, boxed to externref),
// with the remaining args filling the declared params in order.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function run(src: string, fn: string): Promise<number | string> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(r);
  return (instance.exports as Record<string, () => number | string>)[fn]!();
}

describe("#2069 .call/.apply thread the thisArg into an explicit this-param", () => {
  it("the repro: .call and .apply both bind this and pass args in order", async () => {
    const src = `
function getV(this: any, a: number, b: number): number { return this.v + a + b; }
export function test(): string {
  const o = { v: 100 };
  return "" + getV.call(o, 1, 2) + "," + getV.apply(o, [3, 4]);
}`;
    expect(await run(src, "test")).toBe("103,107");
  });

  it(".call on a this-only function returns this.v", async () => {
    const src = `
function getThisV(this: any): number { return this.v; }
export function test(): number { const o = { v: 77 }; return getThisV.call(o); }`;
    expect(await run(src, "test")).toBe(77);
  });

  it(".apply with a literal args array binds this and spreads args", async () => {
    const src = `
function getV(this: any, a: number, b: number): number { return this.v + a + b; }
export function test(): number { const o = { v: 10 }; return getV.apply(o, [1, 2]); }`;
    expect(await run(src, "test")).toBe(13);
  });

  it(".apply with no args array still binds this", async () => {
    const src = `
function getThisV(this: any): number { return this.v; }
export function test(): number { const o = { v: 88 }; return getThisV.apply(o); }`;
    expect(await run(src, "test")).toBe(88);
  });

  it("functions WITHOUT an explicit this param are unchanged (thisArg ignored)", async () => {
    const src = `
function noThis(a: number, b: number): number { return a + b; }
export function c(): number { return noThis.call(null, 3, 4); }
export function a(): number { return noThis.apply(null, [5, 6]); }`;
    expect(await run(src, "c")).toBe(7);
    expect(await run(src, "a")).toBe(11);
  });

  it("a side-effecting thisArg is evaluated exactly once and bound", async () => {
    const src = `
let log = 0;
function mark(): { v: number } { log = log + 1; return { v: 5 }; }
function getV(this: any, a: number): number { return this.v + a; }
export function test(): number { const r = getV.call(mark(), 2); return r * 10 + log; }`;
    // getV.call(mark(), 2) = 5 + 2 = 7; mark ran once → 7*10 + 1 = 71
    expect(await run(src, "test")).toBe(71);
  });
});
