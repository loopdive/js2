// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Same compiler controls as immutable public comparison controller 76198.
const controls = {
  JS2WASM_IR_GVN: "0",
  JS2WASM_IR_OWNERSHIP: "0",
  JS2WASM_IR_ESCAPE: "0",
  IR_VERIFY_ALLOC: "0",
  JS2WASM_IR_VERIFY_DOMINANCE_NAIVE: "0",
  JS2WASM_IR_INLINE: "0",
};
let compile: typeof import("../src/index.js").compile;
beforeAll(async () => {
  for (const key of Object.keys(process.env)) if (/^(JS2WASM_|IR_VERIFY_)/.test(key)) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(controls)) vi.stubEnv(key, value);
  ({ compile } = await import("../src/index.js"));
}, 60_000);
afterAll(() => vi.unstubAllEnvs());

const prelude = `
declare function __drain_microtasks(): void;
const s: any = { getter: 0, original: 0, replacement: 0, value: 0, trace: 0, receiver: 0 };
export function getter(): number { return s.getter; }
export function original(): number { return s.original; }
export function replacement(): number { return s.replacement; }
export function value(): number { return s.value; }
export function trace(): number { return s.trace; }
export function receiver(): number { return s.receiver; }
`;

async function runStandalone(body: string, experimentalIR: boolean) {
  for (const [key, value] of Object.entries(controls)) expect(process.env[key], key).toBe(value);
  const result = await compile(prelude + "\nexport function test(): void {\n" + body + "\n}", {
    fileName: "issue-3518-promise-getter-capture.ts",
    target: "standalone",
    nativeStrings: true,
    experimentalIR,
    skipSemanticDiagnostics: false,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module), "native regression must not call host helpers").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, () => number>;
  exports.test!();
  return Object.fromEntries(
    ["getter", "original", "replacement", "value", "trace", "receiver"].map((name) => [name, exports[name]!()]),
  );
}

describe.each([false, true])("ordinary Promise then is captured once (experimentalIR=%s)", (experimentalIR) => {
  const run = (body: string) => runStandalone(body, experimentalIR);
  it("reads synchronously and invokes the original getter result later with its receiver", async () => {
    expect(
      await run(`
      const o: any = { tag: 42 };
      const first: any = function (this: any, resolve: any) {
        s.original++; s.trace = s.trace * 10 + 2;
        s.receiver = this === o ? 1 : 0; resolve(this.tag);
      };
      const replacement: any = function (resolve: any) { s.replacement++; resolve(99); };
      Object.defineProperty(o, "then", { configurable: true, get: function () {
        s.getter++; s.trace = s.trace * 10 + 1; return first;
      } });
      new Promise(function (resolve: any) { resolve(o); }).then(function (v: any) {
        s.value = v; s.trace = s.trace * 10 + 4;
      });
      Object.defineProperty(o, "then", { configurable: true, get: function () {
        s.getter++; return replacement;
      } });
      s.trace = s.trace * 10 + 3;
      __drain_microtasks();
    `),
    ).toEqual({ getter: 1, original: 1, replacement: 0, value: 42, trace: 1324, receiver: 1 });
  });

  it("keeps a poisoned getter's exact reason and does not invoke a replacement", async () => {
    expect(
      await run(`
      const reason: any = { marker: 71 };
      const o: any = {};
      Object.defineProperty(o, "then", { configurable: true, get: function () {
        s.getter++; throw reason;
      } });
      new Promise(function (resolve: any) { resolve(o); }).then(
        function () { s.value = -1; },
        function (caught: any) { s.value = caught === reason ? 42 : -2; });
      Object.defineProperty(o, "then", { value: function (resolve: any) {
        s.replacement++; resolve(99);
      } });
      __drain_microtasks();
    `),
    ).toMatchObject({ getter: 1, replacement: 0, value: 42 });
  });

  it("fulfills with the original object when the first getter result is not callable", async () => {
    expect(
      await run(`
      const o: any = {};
      Object.defineProperty(o, "then", { configurable: true, get: function () { s.getter++; return 7; } });
      new Promise(function (resolve: any) { resolve(o); }).then(function (v: any) {
        s.value = v === o ? 42 : -1;
      });
      Object.defineProperty(o, "then", { value: function (resolve: any) { s.replacement++; resolve(99); } });
      __drain_microtasks();
    `),
    ).toMatchObject({ getter: 1, replacement: 0, value: 42 });
  });

  it("captures a field value before that field is replaced", async () => {
    expect(
      await run(`
      const o: any = { tag: 42, then: function (this: any, resolve: any) {
        s.original++; s.receiver = this.tag === 42 ? 1 : 0; resolve(42);
      } };
      new Promise(function (resolve: any) { resolve(o); }).then(function (v: any) { s.value = v; });
      o.then = function (resolve: any) { s.replacement++; resolve(99); };
      __drain_microtasks();
    `),
    ).toMatchObject({ original: 1, replacement: 0, value: 42, receiver: 1 });
  });

  it("retains separate captures for two pending resolutions", async () => {
    expect(
      await run(`
      const a: any = { left: 11 };
      const b: any = { right: 31 };
      Object.defineProperty(a, "then", { configurable: true, get: function () {
        s.getter++; return function (resolve: any) { s.original++; resolve(11); };
      } });
      Object.defineProperty(b, "then", { configurable: true, get: function () {
        s.getter++; return function (resolve: any) { s.original++; resolve(31); };
      } });
      new Promise(function (resolve: any) { resolve(a); }).then(function (v: any) { s.value += v; });
      new Promise(function (resolve: any) { resolve(b); }).then(function (v: any) { s.value += v; });
      __drain_microtasks();
    `),
    ).toMatchObject({ getter: 2, original: 2, value: 42 });
  });

  it("does not overwrite an outer capture during a reentrant getter", async () => {
    expect(
      await run(`
      const inner: any = { then: function (resolve: any) { s.original++; resolve(11); } };
      const outer: any = {};
      Object.defineProperty(outer, "then", { get: function () {
        s.getter++;
        new Promise(function (resolve: any) { resolve(inner); }).then(function (v: any) { s.value += v; });
        return function (resolve: any) { s.original++; resolve(31); };
      } });
      new Promise(function (resolve: any) { resolve(outer); }).then(function (v: any) { s.value += v; });
      __drain_microtasks();
    `),
    ).toMatchObject({ getter: 1, original: 2, value: 42 });
  });

  it("preserves native adoption and compiled-method dispatch", async () => {
    expect(
      await run(`
      class Thenable {
        then(resolve: any): void { s.original++; resolve(31); }
      }
      const native: any = Promise.resolve(11);
      new Promise(function (resolve: any) { resolve(native); }).then(function (v: any) { s.value += v; });
      new Promise(function (resolve: any) { resolve(new Thenable()); }).then(function (v: any) { s.value += v; });
      __drain_microtasks();
    `),
    ).toMatchObject({ original: 1, value: 42 });
  });
});
