// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6651 cluster D, slice D3 (#5197 G10) — `Promise.{all,race,allSettled,any}.call(C, iterable)`
// where `C` is a COMPILED CLASS, in standalone: NewPromiseCapability constructs `C` through the
// native construct driver (a class has no [[Call]], so D1's `__apply_closure` bridge cannot serve
// it), and the iterable is driven step by step with IteratorClose on an abrupt element step.
//
// Every behaviour case was RED on the slice's base: a class receiver fell through to the
// `env::Promise_<method>` host import, which a standalone module cannot satisfy, so the source
// did not compile host-free at all. The control pins what must NOT move: the host (gc) lane never
// names the drive while standalone does. (A Promise-subclass receiver — #5197 G9 — was a second,
// negative control until D4 gave it a standalone representation; it is now admitted.)
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PRELUDE = "declare function __drain_microtasks(): void;\n";

async function compileStandalone(source: string): Promise<Uint8Array> {
  const result = await compile(`${PRELUDE}${source}`, {
    fileName: "issue-6651-d3-class-receiver-combinator.ts",
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
  expect(imports, "a class-receiver combinator must stay host-free").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test(): number }).test();
}

/** A capability-capturing class whose `resolve` answers a thenable that doubles (or rejects a negative). */
const CAPTURE = `
const log: any = { resolved: [] as any[], rejected: [] as any[] };
class C {
  constructor(executor: any) {
    executor(function (v: any): void { log.resolved.push(v); }, function (e: any): void { log.rejected.push(e); });
  }
  static resolve(v: any): any {
    return { then: function (f: any, r: any): void { if (v < 0) r(v); else f(v * 2); } };
  }
}
`;

/** The test262 `resolve-throws-iterator-return-*` shape: a `next()` that never reports done. */
const BAD_PROMISE = `
const log: any = { rejects: 0, reason: "", returns: 0 };
class BadPromise {
  constructor(executor: any) {
    executor(function (): void { log.rejects = 100; }, function (e: any): void { log.rejects += 1; log.reason = e; });
  }
  static resolve(): any { throw "bad promise resolve"; }
}
`;

describe("#6651 D3 — Promise combinators over a compiled-class receiver (standalone)", () => {
  for (const method of ["all", "race", "allSettled", "any"]) {
    it(`Promise.${method}.call(BadPromise, <never-done iterator>) rejects once; a non-callable return is swallowed`, async () => {
      const value = await runStandalone(`${BAD_PROMISE}
export function test(): number {
  const iterator: any = {
    [Symbol.iterator](): any { return this; },
    next(): any { return { done: false }; },
    return: 0,
  };
  Promise.${method}.call(BadPromise, iterator);
  return log.rejects * 10 + (log.reason === "bad promise resolve" ? 1 : 0);
}`);
      expect(value).toBe(11);
    });
  }

  it("an abrupt element step closes the iterator exactly once (callable return)", async () => {
    const value = await runStandalone(`${BAD_PROMISE}
export function test(): number {
  const iterator: any = {
    [Symbol.iterator](): any { return this; },
    next(): any { return { done: false }; },
    return(): any { log.returns += 1; return {}; },
  };
  Promise.all.call(BadPromise, iterator);
  return log.returns * 10 + log.rejects;
}`);
    expect(value).toBe(11);
  });

  it("Promise.all.call(C, [1, 2, 3]) resolves C's capability with the element values in order", async () => {
    const value = await runStandalone(`${CAPTURE}
export function test(): number {
  const p: any = Promise.all.call(C, [1, 2, 3]);
  const arr: any = log.resolved[0];
  return (p instanceof C ? 10000 : 0) + log.resolved.length * 1000 + arr.length * 100 + arr[0] + arr[2];
}`);
    expect(value).toBe(10000 + 1000 + 300 + 2 + 6);
  });

  it("Promise.allSettled.call(C, …) records fulfilled/rejected results through one shared [[AlreadyCalled]]", async () => {
    const value = await runStandalone(`${CAPTURE}
export function test(): number {
  Promise.allSettled.call(C, [1, -2]);
  const arr: any = log.resolved[0];
  const ok = arr[0].status === "fulfilled" && arr[0].value === 2 && arr[1].status === "rejected" && arr[1].reason === -2;
  return log.resolved.length * 10 + (ok ? 1 : 0);
}`);
    expect(value).toBe(11);
  });

  it("Promise.any.call(C, …) rejects with an AggregateError when every element rejects", async () => {
    const value = await runStandalone(`${CAPTURE}
export function test(): number {
  Promise.any.call(C, [-1, -2]);
  const err: any = log.rejected[0];
  return log.rejected.length * 100 + (err instanceof AggregateError ? 10 : 0) + err.errors.length;
}`);
    expect(value).toBe(112);
  });

  it("Promise.race.call(C, …) hands C's own resolve to every element", async () => {
    const value = await runStandalone(`${CAPTURE}
export function test(): number {
  Promise.race.call(C, [3, 4]);
  return log.resolved.length * 100 + log.resolved[0];
}`);
    expect(value).toBe(206);
  });

  it("a class whose constructor never calls the executor throws TypeError synchronously", async () => {
    const value = await runStandalone(`
class F { constructor(executor: any) {} static resolve(v: any): any { return v; } }
export function test(): number {
  try { Promise.all.call(F, []); } catch (e) { return e instanceof TypeError ? 1 : 2; }
  return 0;
}`);
    expect(value).toBe(1);
  });

  it("control: the host (gc) lane never takes the class-receiver drive; standalone does", async () => {
    const source = `class K { constructor(ex: any) { ex(function (): void {}, function (): void {}); } static resolve(v: any): any { return v; } }
export function test(): number { Promise.all.call(K, []); return 1; }`;
    const gc = await compile(source, { fileName: "issue-6651-d3-gc.ts" });
    expect(gc.success).toBe(true);
    if (!gc.success) return;
    expect(new TextDecoder("latin1").decode(gc.binary).includes("__promise_class_drive")).toBe(false);
    const standalone = await compileStandalone(source);
    expect(new TextDecoder("latin1").decode(standalone).includes("__promise_class_drive")).toBe(true);
  });

  it("a Promise-subclass receiver (#5197 G9) is admitted since D4 — its class object is constructible", async () => {
    const result = await compile(
      `class S extends Promise<any> {}
export function test(): number { Promise.all.call(S, []); return 1; }`,
      { fileName: "issue-6651-d3-subclass.ts", target: "standalone", nativeStrings: true },
    );
    const text = result.success ? new TextDecoder("latin1").decode(result.binary) : "";
    expect(text.includes("__promise_class_drive")).toBe(true);
  });
});
