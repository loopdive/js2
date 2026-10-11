// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6651 cluster D, slice D5 (#5197 R3-7) — `%Promise.prototype%` members read off a native
// `$Promise` through the dynamic property path, standalone.
//
// A native promise had no readable `then`: `__extern_get` had no `$Promise` arm, so a VALUE read
// (`p.then`, `id(p).then`, `p["then"]`) and the combinators' `Invoke(nextPromise, "then", …)`
// answered `undefined`. Every behaviour case below was RED on the slice's base (6 of 9). The three
// controls are green on both and pin what must NOT move: a program that writes
// `Promise.prototype.then` keeps reading its override back through the brand companion, an own
// `then` still shadows, and a module that never reads a promise member as a value does not gain the
// member closure.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PRELUDE = "declare function __drain_microtasks(): void;\nfunction id(x: any): any { return x; }\n";

async function compileStandalone(source: string, emitWat = false): Promise<{ binary: Uint8Array; wat: string }> {
  const result = await compile(`${PRELUDE}${source}`, {
    fileName: "issue-6651-d5-promise-dynamic-then.ts",
    target: "standalone",
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
  const { binary } = await compileStandalone(source);
  const module = await WebAssembly.compile(binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  expect(imports, "the dynamic promise member read must stay host-free").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test(): number }).test();
}

describe("#6651 D5 — dynamic reads of Promise.prototype members on a native promise", () => {
  it("typeof id(p).then / .catch / .finally is 'function'", async () => {
    const value = await runStandalone(`
export function test(): number {
  const p: any = id(Promise.resolve(1));
  return (typeof p.then === "function" ? 100 : 0) + (typeof p.catch === "function" ? 10 : 0) +
    (typeof p.finally === "function" ? 1 : 0);
}`);
    expect(value).toBe(111);
  });

  it("the read is the %Promise.prototype% member itself (identity), typed or untyped", async () => {
    const value = await runStandalone(`
export function test(): number {
  const typed = Promise.resolve(1);
  const untyped: any = id(typed);
  return (untyped.then === Promise.prototype.then ? 10 : 0) + ((typed as any)["catch"] === Promise.prototype.catch ? 1 : 0);
}`);
    expect(value).toBe(11);
  });

  it("p.then.length / p.catch.length on a Promise-typed receiver are the spec lengths (S25.4.5.3_A1.1_T2)", async () => {
    const value = await runStandalone(`
export function test(): number {
  const p = new Promise<void>(function (): void {});
  return p.then.length * 10 + p.catch.length;
}`);
    expect(value).toBe(21);
  });

  it("an extracted then, called with the promise as this, subscribes", async () => {
    const value = await runStandalone(`
export function test(): number {
  let got = 0;
  const p: any = id(Promise.resolve(7));
  const t: any = p.then;
  t.call(p, function (v: any): void { got = v; });
  __drain_microtasks();
  return got;
}`);
    expect(value).toBe(7);
  });

  it("Promise.all.call(C) over a C.resolve that answers native promises settles (D1 Invoke)", async () => {
    const value = await runStandalone(`
function C(executor: any): any { return new Promise(executor); }
(C as any).resolve = function (v: any): any { return Promise.resolve(v); };
export function test(): number {
  let got = -1;
  const all: any = Promise.all.call(C, [3, 4]);
  all.then(function (v: any): void { got = v.length * 10 + v[1]; });
  __drain_microtasks();
  return got;
}`);
    expect(value).toBe(24);
  });

  it("control: a program that WRITES Promise.prototype.then reads the override back (companion path, green on base too)", async () => {
    const value = await runStandalone(`
const orig: any = id(Promise.resolve(0)).then; // a dynamic read, so no Promise.prototype member value use
let calls = 0;
const override = function (this: any, a: any, b: any): any { calls++; return orig.call(this, a, b); };
(Promise.prototype as any).then = override;
export function test(): number {
  const p: any = id(Promise.resolve(1));
  const t: any = p.then;
  t.call(p, function (): void {});
  // An un-overridden member still resolves beside the written one.
  return (typeof p.catch === "function" ? 100 : 0) + (t === override ? 10 : 0) + calls;
}`);
    expect(value).toBe(111);
  });

  it("Promise.all([...]) Invokes an overridden Promise.prototype.then on native elements (§27.2.4.1.1)", async () => {
    const value = await runStandalone(`
const orig: any = Promise.prototype.then;
let calls = 0;
(Promise.prototype as any).then = function (this: any, a: any, b: any): any { calls++; return orig.call(this, a, b); };
export function test(): number {
  let got = 0;
  Promise.all([Promise.resolve(5), Promise.resolve(6)]).then(function (v: any): void { got = v[0] + v[1]; });
  __drain_microtasks();
  return got * 100 + calls;
}`);
    // Two element Invokes plus the test's own `.then`: the result arrives and the override ran.
    expect(Math.floor(value / 100)).toBe(11);
    expect(value % 100).toBeGreaterThanOrEqual(2);
  });

  it("control: an OWN then still shadows the prototype member", async () => {
    const value = await runStandalone(`
export function test(): number {
  const p: any = Promise.resolve(1);
  const own = function (): number { return 42; };
  p.then = own;
  return id(p).then === own ? 1 : 0;
}`);
    expect(value).toBe(1);
  });

  it("control: a module that never reads a promise member as a value does not mint the member closure", async () => {
    const { wat } = await compileStandalone(
      `
export function test(): number {
  let got = 0;
  Promise.resolve(3).then(function (v: any): void { got = v; });
  __drain_microtasks();
  return got;
}`,
      true,
    );
    expect(wat.length).toBeGreaterThan(0);
    expect(wat).not.toMatch(/\(func \$__proto_method_-?\d+_then\b/);
  });
});
