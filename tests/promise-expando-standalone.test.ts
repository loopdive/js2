// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Standalone native Promises are WasmGC `$Promise` structs rather than
// `$Object`s. Keep ordinary own-property semantics on that representation: Deno
// stores an async op's promise id under a private Symbol and later reads the
// same property in refOpPromise/unrefOpPromise.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function instantiateStandalone(source: string): Promise<WebAssembly.Exports> {
  const result = await compile(source, {
    target: "standalone",
    experimentalIR: false,
    fileName: "promise-expando-canary.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

describe("standalone native Promise own properties", () => {
  it("passes the exact Deno promise-id expando canary", async () => {
    const exports = await instantiateStandalone(`
      const promiseIdSymbol: any = Symbol.for("Deno.core.internalPromiseId");
      export function test(): number {
        const wrappedPromise: any = Promise.resolve(1);
        wrappedPromise[promiseIdSymbol] = 0;
        wrappedPromise.named = 43;
        return (wrappedPromise[promiseIdSymbol] === 0 ? 1 : 0) +
          (wrappedPromise.named === 43 ? 2 : 0);
      }
    `);
    expect((exports.test as () => number)()).toBe(3);
  });

  it("keys the property bag by Promise identity", async () => {
    const exports = await instantiateStandalone(`
      const key: any = Symbol.for("promise.identity");
      export function test(): number {
        const first: any = Promise.resolve(1);
        const alias: any = first;
        const second: any = Promise.resolve(2);
        first[key] = 11;
        first.named = 12;
        second[key] = 21;
        second.named = 22;
        return alias[key] === 11 && alias.named === 12 &&
          second[key] === 21 && second.named === 22 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("keeps Promise.prototype methods visible through the dynamic carrier path", async () => {
    const exports = await instantiateStandalone(`
      const retainedPromisePrototype: any = Promise.prototype;
      export function test(): number {
        const promise: any = Promise.resolve(1);
        promise.named = 42;
        return retainedPromisePrototype !== undefined &&
          typeof promise.then === "function" &&
          typeof promise.catch === "function" &&
          typeof promise.finally === "function" ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("invokes dynamically-read then, catch, and finally methods", async () => {
    const exports = await instantiateStandalone(`
      declare function __drain_microtasks(): void;
      const retainedPromisePrototype: any = Promise.prototype;
      let score = 0;
      export function test(): number {
        const fulfilled: any = Promise.resolve(4);
        const rejected: any = Promise.reject(8);
        const thenMethod: any = fulfilled.then;
        const catchMethod: any = rejected.catch;
        const finallyMethod: any = fulfilled.finally;
        thenMethod.call(fulfilled, (value: number) => { score += value; });
        catchMethod.call(rejected, (reason: number) => { score += reason; });
        finallyMethod.call(fulfilled, () => { score += 100; });
        __drain_microtasks();
        return retainedPromisePrototype !== undefined ? score : -1;
      }
    `);
    expect((exports.test as () => number)()).toBe(112);
  });

  it("exposes string and Symbol expandos through own-property reflection", async () => {
    const exports = await instantiateStandalone(`
      const key: any = Symbol.for("promise.reflection");
      export function test(): number {
        const promise: any = Promise.resolve(1);
        promise[key] = 31;
        promise.named = 32;
        const named: any = Reflect.getOwnPropertyDescriptor(promise, "named");
        const symbolic: any = Reflect.getOwnPropertyDescriptor(promise, key);
        const ownNames: any = Reflect.ownKeys(promise);
        let sawNamed = false;
        for (let i = 0; i < ownNames.length; i++) {
          if (ownNames[i] === "named") sawNamed = true;
        }
        return Object.prototype.hasOwnProperty.call(promise, key) &&
          Object.prototype.hasOwnProperty.call(promise, "named") &&
          Reflect.has(promise, key) && Reflect.get(promise, key) === 31 &&
          named !== undefined && named.value === 32 &&
          symbolic !== undefined && symbolic.value === 31 && sawNamed ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });
});
