// (#1794) node:events / EventEmitter — host class + closure-callback contract.
// Three coordinated fixes:
//  1. registry/imports.ts — the #1284 user-class shadow guard collected AMBIENT
//     (`declare`) classes as user classes, blocking every declare-namespace
//     extern class's own import registration (ctor lowered to undefined since
//     2026-05-02; tests/externref.test.ts was failing 5/5).
//  2. import-resolver.ts — named node-builtin CLASS imports
//     (`import { EventEmitter } from "node:events"`) bound the local name to a
//     null `declare const X: any`; now substituted with the #1044 namespaced
//     extern-class stub so construction resolves `require("events").EventEmitter`.
//  3. closures/callback-classification.ts + runtime.ts — listener callbacks:
//     persistent capture writebacks (the listener fires from a LATER host call,
//     #1695) and identity-cached callable wrapping for variable-held closures
//     (Node validates typeof listener === "function"; off() must identity-match).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const imports = buildImports(r.imports ?? [], undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary!, imports as unknown as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1794 node:events EventEmitter (Tier 0)", () => {
  it("named import: on + emit delivers the value into a captured local", async () => {
    expect(
      await run(`
import { EventEmitter } from "node:events";
export function test(): number {
  const e = new EventEmitter();
  let got = 0;
  e.on("tick", (n: number) => { got = n; });
  e.emit("tick", 42);
  return got;
}
`),
    ).toBe(42);
  });

  it("once fires exactly once; off unsubscribes a variable-held listener", async () => {
    expect(
      await run(`
import { EventEmitter } from "node:events";
export function test(): number {
  const e = new EventEmitter();
  let count = 0;
  e.once("tick", (n: number) => { count = count + n; });
  e.emit("tick", 1);
  e.emit("tick", 1);
  const h = (n: number) => { count = count + 100; };
  e.on("tock", h);
  e.off("tock", h);
  e.emit("tock", 1);
  return count;
}
`),
    ).toBe(1);
  });

  it("namespace form: new events.EventEmitter() resolves the same host class", async () => {
    expect(
      await run(`
import * as events from "node:events";
export function test(): number {
  const e = new events.EventEmitter();
  let got = 0;
  e.on("tick", (n: number) => { got = n; });
  e.emit("tick", 7);
  return got;
}
`),
    ).toBe(7);
  });

  it("addListener alias works; multiple listeners SHARING one accumulator both land (#3329)", async () => {
    // Two stored listeners capturing the SAME mutable local alias one ref
    // cell (the #3329 deferred-callback localMap rebind) — pre-fix each
    // creation minted its own cell and the last writeback won (returned 30).
    expect(
      await run(`
import { EventEmitter } from "node:events";
export function test(): number {
  const e = new EventEmitter();
  let sum = 0;
  e.addListener("n", (v: number) => { sum = sum + v; });
  e.on("n", (v: number) => { sum = sum + v * 10; });
  e.emit("n", 3);
  return sum;
}
`),
    ).toBe(33);
  });

  it("#1284 guard intact: a REAL user class still shadows extern classes", async () => {
    // A user-defined (non-ambient) class named like an extern must keep
    // compiling as a wasm struct class — not lower to extern imports.
    expect(
      await run(`
class Widget {
  x: number;
  constructor(x: number) { this.x = x; }
  double(): number { return this.x * 2; }
}
export function test(): number {
  return new Widget(21).double();
}
`),
    ).toBe(42);
  });
});
