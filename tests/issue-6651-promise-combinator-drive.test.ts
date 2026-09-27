// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6651 cluster D, slice D2b — `Promise.all` / `Promise.race` over a DYNAMIC
// iterable are driven step by step (§27.2.4.1 / §27.2.4.5) in standalone:
// GetPromiseResolve before GetIterator, IteratorStep interleaved with
// Call(resolve) / Invoke(then), IfAbruptRejectPromise on every abrupt step, and
// IteratorClose when an element step throws with the iterator still open.
//
// The eight behaviour cases were RED on the slice's base: the legacy dynamic
// path drained the iterable through `__combinator_to_vec`, which (H1) cannot
// see a symbol-keyed `@@iterator` expando on a plain object at all, and which
// could never close an iterator or turn a throwing `next()` into a rejection.
// The two controls pin what must NOT move: an array-literal `Promise.all`
// never names a drive function (green on both sides), and the host lane never
// does while standalone does (red on base only through its standalone half).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PRELUDE = "declare function __drain_microtasks(): void;\n";

async function compileStandalone(source: string): Promise<Uint8Array> {
  const result = await compile(`${PRELUDE}${source}`, {
    fileName: "issue-6651-promise-combinator-drive.ts",
    target: "standalone",
    nativeStrings: true,
  });
  expect(
    result.success,
    result.success ? "" : result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"),
  ).toBe(true);
  if (!result.success) throw new Error("compile failed");
  return result.binary;
}

async function runStandalone(source: string): Promise<number> {
  const binary = await compileStandalone(source);
  const module = await WebAssembly.compile(binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  expect(imports, "the driven combinator must stay host-free").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test(): number }).test();
}

/** An iterable whose `@@iterator` is a post-hoc symbol-keyed EXPANDO (H1). */
const EXPANDO_ITER = `
function makeIter(limit: number, log: any): any {
  const iter: any = {};
  iter[Symbol.iterator] = function (): any {
    let i = 0;
    return {
      next: function (): any {
        i += 1;
        log.nexts += 1;
        return i > limit ? { done: true, value: undefined } : { done: false, value: i * 10 };
      },
      return: function (): any {
        log.returns += 1;
        return {};
      },
    };
  };
  return iter;
}
`;

describe("#6651 D2b — driven Promise.all/race over a dynamic iterable (standalone)", () => {
  it("Promise.all sees a symbol-keyed @@iterator expando and fulfils with every value (H1)", async () => {
    const value = await runStandalone(`${EXPANDO_ITER}
export function test(): number {
  const log: any = { nexts: 0, returns: 0 };
  let len = -1;
  let last = -1;
  let settled = 0;
  Promise.all(makeIter(6, log)).then(function (v: any): void { settled = 1; len = v.length; last = v[5]; },
                                     function (): void { settled = 2; });
  __drain_microtasks();
  return settled * 100000 + len * 10000 + last * 10 + log.nexts;
}`);
    // settled 1, 6 values, last value 60, next() called 7 times (the 7th reports done).
    expect(value).toBe(100000 + 60000 + 600 + 7);
  });

  it("Promise.race over an expando iterable settles with the first element", async () => {
    const value = await runStandalone(`${EXPANDO_ITER}
export function test(): number {
  const log: any = { nexts: 0, returns: 0 };
  let first = -1;
  Promise.race(makeIter(3, log)).then(function (v: any): void { first = v; });
  __drain_microtasks();
  return first * 100 + log.nexts * 10 + log.returns;
}`);
    expect(value).toBe(10 * 100 + 4 * 10 + 0);
  });

  it("a throwing next() rejects the capability (no synchronous throw) and does not close", async () => {
    const value = await runStandalone(`
export function test(): number {
  let returns = 0;
  let calls = 0;
  const err: any = { tag: 7 };
  const iter: any = {};
  iter[Symbol.iterator] = function (): any {
    return {
      next: function (): any { calls += 1; if (calls === 3) throw err; return { done: false, value: calls }; },
      return: function (): any { returns += 1; return {}; },
    };
  };
  let reason: any = null;
  let threw = 0;
  try {
    Promise.all(iter).then(function (): void {}, function (e: any): void { reason = e; });
  } catch (e) {
    threw = 1;
  }
  __drain_microtasks();
  return threw * 1000 + (reason === err ? 100 : 0) + returns * 10 + calls;
}`);
    expect(value).toBe(100 + 0 + 3);
  });

  it("a poisoned `done` getter rejects with its error and never reads `value`", async () => {
    const value = await runStandalone(`
export function test(): number {
  const err: any = { tag: 1 };
  let valueReads = 0;
  const poisoned: any = {};
  Object.defineProperty(poisoned, "done", { get: function (): any { throw err; } });
  Object.defineProperty(poisoned, "value", { get: function (): any { valueReads += 1; return 1; } });
  const iter: any = {};
  iter[Symbol.iterator] = function (): any { return { next: function (): any { return poisoned; } }; };
  let reason: any = null;
  Promise.race(iter).then(function (): void {}, function (e: any): void { reason = e; });
  __drain_microtasks();
  return (reason === err ? 10 : 0) + valueReads;
}`);
    expect(value).toBe(10);
  });

  it("an abrupt Call(resolve) closes a never-done iterator exactly once and rejects", async () => {
    const value = await runStandalone(`
export function test(): number {
  let returns = 0;
  let nexts = 0;
  const err: any = { tag: 2 };
  const iter: any = {};
  iter[Symbol.iterator] = function (): any {
    return {
      next: function (): any { nexts += 1; return { done: false, value: null }; },
      return: function (): any { returns += 1; return {}; },
    };
  };
  (Promise as any).resolve = function (): any { throw err; };
  let reason: any = null;
  Promise.all(iter).then(function (): void {}, function (e: any): void { reason = e; });
  __drain_microtasks();
  return (reason === err ? 100 : 0) + returns * 10 + nexts;
}`);
    expect(value).toBe(100 + 10 + 1);
  });

  it("GetPromiseResolve runs before GetIterator: a throwing resolve getter wins", async () => {
    const value = await runStandalone(`
export function test(): number {
  let iteratorGets = 0;
  const err: any = { tag: 3 };
  const iter: any = {};
  Object.defineProperty(iter, Symbol.iterator, { get: function (): any { iteratorGets += 1; throw new Error("unreachable"); } });
  Object.defineProperty(Promise, "resolve", { get: function (): any { throw err; } });
  let reason: any = null;
  Promise.race(iter).then(function (): void {}, function (e: any): void { reason = e; });
  __drain_microtasks();
  return (reason === err ? 10 : 0) + iteratorGets;
}`);
    expect(value).toBe(10);
  });

  it("interleaves next() with Call(resolve) per element (observable resolve)", async () => {
    const value = await runStandalone(`
export function test(): number {
  const log: string[] = [];
  const iter: any = {};
  iter[Symbol.iterator] = function (): any {
    let i = 0;
    return { next: function (): any { i += 1; log.push("n" + i); return i > 3 ? { done: true } : { done: false, value: i }; } };
  };
  const orig: any = Promise.resolve;
  (Promise as any).resolve = function (v: any): any { log.push("r" + v); return orig.call(Promise, v); };
  let len = -1;
  Promise.all(iter).then(function (v: any): void { len = v.length; });
  __drain_microtasks();
  return log.join(",") === "n1,r1,n2,r2,n3,r3,n4" ? len : -100 - log.length;
}`);
    expect(value).toBe(3);
  });

  it("grows the results list past its capacity when thenables resolve synchronously", async () => {
    const value = await runStandalone(`
export function test(): number {
  const iter: any = {};
  iter[Symbol.iterator] = function (): any {
    let i = 0;
    return {
      next: function (): any {
        i += 1;
        if (i > 9) return { done: true };
        const k = i;
        return { done: false, value: { then: function (res: any): void { res(k * 2); } } };
      },
    };
  };
  (Promise as any).resolve = function (v: any): any { return v; };
  let len = -1;
  let sum = 0;
  Promise.all(iter).then(function (v: any): void {
    len = v.length;
    for (let j = 0; j < v.length; j++) sum += v[j];
  });
  __drain_microtasks();
  return len * 1000 + sum;
}`);
    expect(value).toBe(9 * 1000 + 90);
  });

  it("control: an array-literal Promise.all is not routed through the drive", async () => {
    const binary = await compileStandalone(`
export function test(): number {
  let got = -1;
  Promise.all([1, Promise.resolve(2)]).then(function (v: any): void { got = v[1]; });
  __drain_microtasks();
  return got;
}`);
    const text = new TextDecoder("latin1").decode(binary);
    expect(text.includes("__combinator_drive")).toBe(false);
    const { instance } = await WebAssembly.instantiate(binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(2);
  });

  it("control: the host (gc) lane compiles the dynamic shape without the drive", async () => {
    const result = await compile(
      `const it: any = [1, 2];
export function test(): number { Promise.all(it); return 1; }`,
      { fileName: "issue-6651-promise-combinator-drive-gc.ts" },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(new TextDecoder("latin1").decode(result.binary).includes("__combinator_drive")).toBe(false);
    // The same source on standalone DOES take the drive — the negative checks
    // above are meaningful only because the name section carries these names.
    const standalone = await compileStandalone(`const it: any = [1, 2];
export function test(): number { Promise.all(it); return 1; }`);
    expect(new TextDecoder("latin1").decode(standalone).includes("__combinator_drive")).toBe(true);
  });
});
