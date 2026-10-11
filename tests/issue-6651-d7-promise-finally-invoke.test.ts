// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6651 cluster D, slice D7 — `Promise.prototype.finally` performs
// `Invoke(promise, "then", «thenFinally, catchFinally»)` (§27.2.5.3 step 7), standalone.
//
// The native lowering subscribed to the `$Promise` reaction list directly and never read `then`,
// and the direct reflective spelling `Promise.prototype.finally.call(x, …)` was not routed to the
// member at all; and the intrinsic `then` body re-dispatched to an own `then`, so the test262 idiom
// `p.then = function () { return Promise.prototype.then.apply(this, arguments) }` recursed without
// bound. Every behaviour case below (7) was RED on the slice's base. The controls are green on
// both and pin what must NOT move: an ordinary `finally` passes the value / reason through and a
// throwing `onFinally` overrides it; wasi keeps its zero-import lowering (no generic arm).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PRELUDE = "declare function __drain_microtasks(): void;\n";

async function compileTarget(source: string, target: "standalone" | "wasi", emitWat = false) {
  const result = await compile(`${PRELUDE}${source}`, {
    fileName: "issue-6651-d7-promise-finally-invoke.ts",
    target,
    nativeStrings: true,
    emitWat,
  } as never);
  expect(
    result.success,
    result.success ? "" : result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"),
  ).toBe(true);
  if (!result.success) throw new Error("compile failed");
  return { binary: result.binary, wat: (result as unknown as { wat?: string }).wat ?? "" };
}

async function runStandalone(source: string): Promise<number> {
  const { binary } = await compileTarget(source, "standalone");
  const module = await WebAssembly.compile(binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  expect(imports, "Promise.prototype.finally must stay host-free").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test(): number }).test();
}

describe("#6651 D7 — Promise.prototype.finally invokes the receiver's then", () => {
  it("finally.call(p) calls p's OWN then once, with this = p, two fresh length-1 anonymous handlers, and returns its result", async () => {
    const value = await runStandalone(`
export function test(): number {
  const target: any = new Promise<void>(function (): void {});
  const returnValue = {};
  let calls = 0, self: any = null, argc = -1, a: any = null, b: any = null;
  target.then = function (this: any, x: any, y: any): any {
    calls++; self = this; argc = arguments.length; a = x; b = y; return returnValue;
  };
  const fin = function (): void {};
  const result = (Promise.prototype.finally as any).call(target, fin, 2, 3);
  return (calls === 1 ? 1 : 0) + (self === target ? 2 : 0) + (argc === 2 ? 4 : 0) +
    (typeof a === "function" && a !== fin ? 8 : 0) + (typeof b === "function" && b !== fin && b !== a ? 16 : 0) +
    (a.length === 1 && b.length === 1 ? 32 : 0) + (a.name === "" && b.name === "" ? 64 : 0) +
    (result === returnValue ? 128 : 0);
}`);
    expect(value).toBe(255);
  });

  it("a non-callable onFinally is handed to then unchanged, twice", async () => {
    const value = await runStandalone(`
export function test(): number {
  const target: any = new Promise<void>(function (): void {});
  let first: any = null, second: any = null;
  target.then = function (x: any, y: any): any { first = x; second = y; return 0; };
  (Promise.prototype.finally as any).call(target, 1, 2, 3);
  return (first === 1 ? 10 : 0) + (second === 1 ? 1 : 0);
}`);
    expect(value).toBe(11);
  });

  it("a non-callable then is a TypeError; a poisoned then getter propagates, through both spellings", async () => {
    const value = await runStandalone(`
export function test(): number {
  let m = 0;
  const p: any = new Promise<void>(function (): void {});
  p.then = undefined;
  try { (Promise.prototype.finally as any).call(p, function (): void {}); } catch (e) { if (e instanceof TypeError) m += 1; }
  p.then = {};
  try { (Promise.prototype.finally as any).call(p, function (): void {}); } catch (e) { if (e instanceof TypeError) m += 10; }
  const poisoned: any = Object.defineProperty(new Promise<void>(function (): void {}), "then", {
    get: function (): any { throw new RangeError("poisoned"); },
  });
  try { (Promise.prototype.finally as any).call(poisoned); } catch (e) { if (e instanceof RangeError) m += 100; }
  try { poisoned.finally(); } catch (e) { if (e instanceof RangeError) m += 1000; }
  return m;
}`);
    expect(value).toBe(1111);
  });

  it("finally.call on a non-promise thenable returns the result of its then", async () => {
    const value = await runStandalone(`
export function test(): number {
  const thenResult = {};
  const Thenable: any = function (): void {};
  Thenable.prototype.then = function (): any { return thenResult; };
  return (Promise.prototype.finally as any).call(new Thenable()) === thenResult ? 1 : 0;
}`);
    expect(value).toBe(1);
  });

  it("p.finally(f) observes a replaced Promise.prototype.then", async () => {
    const value = await runStandalone(`
export function test(): number {
  let calls = 0;
  const original = Promise.prototype.then;
  const p = Promise.resolve(1);
  (Promise.prototype as any).then = function (): any { calls++; return 7; };
  const r: any = p.finally(function (): void {});
  (Promise.prototype as any).then = original;
  return calls * 10 + (r === 7 ? 1 : 0);
}`);
    expect(value).toBe(11);
  });

  it("thenFinally Invokes then on onFinally's promise with a length-0 anonymous value thunk", async () => {
    const value = await runStandalone(`
export function test(): number {
  const original: any = Promise.prototype.then;
  const payload = {};
  const inner: any = Promise.resolve(5);
  let seen: any = null, thunkOk = 0;
  inner.then = function (this: any, thunk: any): any {
    seen = thunk;
    if (thunk.length === 0 && thunk.name === "" && thunk() === payload) thunkOk = 1;
    return original.call(this, thunk);
  };
  let settled: any = null;
  // An own wrapper \`then\` on the receiver: finally must Invoke it (the generic arm).
  const outer: any = Promise.resolve(payload);
  outer.then = function (this: any, a: any, b: any): any { return original.call(this, a, b); };
  outer.finally(function (): any { return inner; }).then(function (v: any): void { settled = v; });
  __drain_microtasks();
  return (typeof seen === "function" ? 1 : 0) + thunkOk * 10 + (settled === payload ? 100 : 0);
}`);
    expect(value).toBe(111);
  });

  it("the intrinsic then, applied to a promise with an own then, subscribes instead of re-dispatching", async () => {
    const value = await runStandalone(`
export function test(): number {
  let calls = 0, got = 0;
  const yes: any = Promise.resolve(4);
  yes.then = function (this: any): any { calls++; return (Promise.prototype.then as any).apply(this, arguments); };
  yes.then(function (x: number): void { got = x; });
  __drain_microtasks();
  return calls * 10 + got;
}`);
    expect(value).toBe(14);
  });

  it("control: an ordinary finally passes the value and the reason through; a throwing onFinally overrides", async () => {
    const value = await runStandalone(`
export function test(): number {
  let v = 0, r = 0, o = 0, n = 0;
  Promise.resolve(42).finally(function (): void { n++; }).then(function (x: number): void { v = x; });
  Promise.reject(7).finally(function (): void { n++; }).catch(function (e: any): void { r = e; });
  Promise.reject(1).finally(function (): void { throw 5; }).catch(function (e: any): void { o = e; });
  __drain_microtasks();
  return v * 10000 + r * 1000 + o * 10 + n;
}`);
    expect(value).toBe(427052);
  });

  it("control: wasi keeps its zero-import finally lowering (no generic Invoke arm)", async () => {
    const { wat } = await compileTarget(
      `
export function test(): number {
  let n = 0;
  Promise.resolve(1).finally(function (): void { n++; });
  return n;
}`,
      "wasi",
      true,
    );
    expect(wat).not.toContain("__promise_finally_invoke");
  });
});
