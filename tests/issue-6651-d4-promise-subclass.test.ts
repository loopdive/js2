// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6651 cluster D, slice D4 (#5197 G9) — `class X extends Promise` in standalone.
//
// A Promise-subclass instance is the native `$Promise` carrier built by `super(executor)`; its
// [[Prototype]] rides in the carrier's `$bag.$proto` (the #2917 vec-link design), `instanceof`
// walks that link, the class object is constructible by the native construct dispatcher, and
// `Promise.{resolve,reject}.call(C)` / `Promise.{all,race}.call(C, …)` run NewPromiseCapability(C)
// through a real [[Construct]].
//
// Every behaviour case was RED on the slice's base: reading a Promise subclass as a value emitted
// the host import `env::__promise_subclass_ctor`, so none of these sources compiled host-free.
// The controls pin what must NOT move: the gc lane keeps the host constructor, and a standalone
// module with no Promise subclass never names the new helpers.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PRELUDE = "declare function __drain_microtasks(): void;\n";

async function compileStandalone(source: string): Promise<Uint8Array> {
  const result = await compile(`${PRELUDE}${source}`, {
    fileName: "issue-6651-d4-promise-subclass.ts",
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
  expect(imports, "a Promise subclass must stay host-free").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test(): number }).test();
}

/** The test262 `ctx-ctor.js` class: counts constructions and captures the executor. */
const SUB = `
const log: any = { executor: null as any, count: 0 };
class SubPromise extends Promise<any> {
  constructor(a: any) {
    super(a);
    log.executor = a;
    log.count += 1;
  }
}
function id(x: any): any { return x; }
/** 1000 constructor · 100 instanceof · 10 one construction · 1 executor is a function */
function score(instance: any): number {
  return (instance.constructor === SubPromise ? 1000 : 0) + (instance instanceof SubPromise ? 100 : 0) +
    (log.count === 1 ? 10 : 0) + (typeof log.executor === "function" ? 1 : 0);
}
`;

describe("#6651 D4 — class X extends Promise (standalone)", () => {
  for (const [label, call] of [
    ["Promise.all.call(SubPromise, [])", "Promise.all.call(SubPromise, [])"],
    ["Promise.race.call(SubPromise, [])", "Promise.race.call(SubPromise, [])"],
    ["Promise.resolve.call(SubPromise)", "Promise.resolve.call(SubPromise)"],
    ["Promise.reject.call(SubPromise)", "Promise.reject.call(SubPromise)"],
  ] as const) {
    it(`${label} constructs SubPromise once, with a function executor (ctx-ctor)`, async () => {
      const value = await runStandalone(`${SUB}
export function test(): number { const instance: any = ${call}; return score(instance); }`);
      expect(value).toBe(1111);
    });
  }

  it("new SubPromise(executor) runs the executor and the constructor body; the instance settles", async () => {
    const value = await runStandalone(`${SUB}
export function test(): number {
  let got = 0;
  const p: any = id(new SubPromise(function (resolve: any): void { resolve(7); }));
  p.then(function (v: any): void { got = v; });
  __drain_microtasks();
  return score(p) * 10 + got;
}`);
    // (#5197 r3) `p.then` performs SpeciesConstructor(p) = SubPromise and constructs it
    // (§27.2.5.4), so `log.count` is 2 afterwards — node answers 11017 (was 11117
    // while the native `then` skipped species).
    expect(value).toBe(11017);
  });

  it("the implicit constructor of `class Custom extends Promise {}` builds a real carrier from its executor", async () => {
    const value = await runStandalone(`
class Custom extends Promise<any> {}
function id(x: any): any { return x; }
export function test(): number {
  let got = 0;
  const c: any = id(new Custom(function (resolve: any): void { resolve(5); }));
  c.then(function (v: any): void { got = v; });
  __drain_microtasks();
  return (c instanceof Custom ? 100 : 0) + (c instanceof Promise ? 10 : 0) + got;
}`);
    expect(value).toBe(115);
  });

  it("instanceof answers false for a plain promise and for a sibling subclass", async () => {
    const value = await runStandalone(`
class A extends Promise<any> { constructor(e: any) { super(e); } }
class B extends Promise<any> { constructor(e: any) { super(e); } }
function id(x: any): any { return x; }
export function test(): number {
  const a: any = id(new A(function (): void {}));
  const plain: any = id(new Promise(function (): void {}));
  return (a instanceof A ? 100 : 0) + (a instanceof B ? 10 : 0) + (plain instanceof A ? 1 : 0);
}`);
    expect(value).toBe(100);
  });

  it("Promise.all.call(SubPromise, []) fulfils with [] — `resolve` is inherited from %Promise%", async () => {
    const value = await runStandalone(`${SUB}
export function test(): number {
  let got = -1;
  const p: any = Promise.all.call(SubPromise, []);
  p.then(function (v: any): void { got = v.length; }, function (): void { got = 99; });
  __drain_microtasks();
  return got;
}`);
    expect(value).toBe(0);
  });

  it("Promise.resolve.call(SubPromise, x) returns x when x.constructor is SubPromise", async () => {
    const value = await runStandalone(`${SUB}
export function test(): number {
  const x: any = new SubPromise(function (): void {});
  const y: any = Promise.resolve.call(SubPromise, x);
  return (y === x ? 10 : 0) + log.count;
}`);
    expect(value).toBe(11);
  });

  it("Promise.reject.call(SubPromise, r) rejects SubPromise's capability with r", async () => {
    const value = await runStandalone(`${SUB}
export function test(): number {
  let got = 0;
  const p: any = Promise.reject.call(SubPromise, 8);
  p.then(null, function (r: any): void { got = r; });
  __drain_microtasks();
  return got;
}`);
    expect(value).toBe(8);
  });

  it("control: the gc lane keeps the host Promise-subclass constructor and never names the new helper", async () => {
    const result = await compile(
      `class S extends Promise<any> { constructor(e: any) { super(e); } }
export function test(): number { const p: any = Promise.resolve.call(S); return p instanceof S ? 1 : 0; }`,
      { fileName: "issue-6651-d4-gc.ts" },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const text = new TextDecoder("latin1").decode(result.binary);
    expect(text.includes("__promise_subclass_ctor")).toBe(true);
    expect(text.includes("__promise_proto_instanceof")).toBe(false);
  });

  it("control: a standalone module with no Promise subclass never names the new helper", async () => {
    const binary = await compileStandalone(`
class K { constructor(e: any) { e(function (): void {}, function (): void {}); } }
function id(x: any): any { return x; }
export function test(): number { const p: any = id(new Promise(function (): void {})); return p instanceof Promise ? 1 : 0; }`);
    expect(new TextDecoder("latin1").decode(binary).includes("__promise_proto_instanceof")).toBe(false);
  });
});
