// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5197 R3-2 — the bounded native-vector observable Promise.all/race route.
//
// These are protocol controls, not merely outcome checks. The legacy fast
// route subscribes native promises directly, so it cannot observe a patched
// `Promise.resolve` or a returned thenable's own `then`. The observable route
// is admitted only for direct native all/race calls whose input already lowers
// to the repository's externref vector; generic iterator draining and closing
// remain R3-4 work.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PRELUDE = "declare function __drain_microtasks(): void;\n";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(`${PRELUDE}${source}`, {
    fileName: "issue-5197-promise-observable-combinator-r3-2.ts",
    target: "standalone",
    nativeStrings: true,
  });
  expect(
    result.success,
    result.success ? "" : result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"),
  ).toBe(true);
  if (!result.success) return -1;

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  expect(imports, "the standalone protocol controls must remain host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/**
 * The maintained deferred-init path exposes the real top-level initializer
 * instead of relying on the default Wasm start section. This makes a passing
 * module-scope protocol result prove that the assignment and combinator ran.
 */
async function runStandaloneDeferredModuleInit(source: string): Promise<number> {
  const result = await compile(`${PRELUDE}${source}`, {
    deferTopLevelInit: true,
    fileName: "issue-5197-promise-observable-combinator-r3-2-module-init.ts",
    target: "standalone",
    nativeStrings: true,
  });
  expect(
    result.success,
    result.success ? "" : result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"),
  ).toBe(true);
  if (!result.success) return -1;

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  expect(imports, "the standalone module-init control must remain host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as { __module_init?: () => void; test(): number };
  expect(exports.__module_init).toBeTypeOf("function");
  exports.__module_init?.();
  return exports.test();
}

async function compileStandaloneWat(source: string): Promise<string> {
  const result = await compile(`${PRELUDE}${source}`, {
    fileName: "issue-5197-promise-observable-combinator-r3-2-import-guard.ts",
    target: "standalone",
    nativeStrings: true,
    emitWat: true,
  });
  expect(
    result.success,
    result.success ? "" : result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"),
  ).toBe(true);
  return result.wat ?? "";
}

describe("#5197 R3-2 — observable Promise combinator pipeline", () => {
  it("retains a module-scope intrinsic resolve replacement before the observable pipeline", async () => {
    await expect(
      runStandaloneDeferredModuleInit(`var p1 = new Promise(function(): void {});
var p2 = new Promise(function(): void {});
var p3 = new Promise(function(): void {});
var resolve: any = Promise.resolve;
var callCount: number = 0;
var wrongIdentity: number = 0;
var wrongArgumentCount: number = 0;
var wrongThis: number = 0;
var current: any = p1;
var next: any = p2;
var afterNext: any = p3;

(Promise as any).resolve = function(nextValue: any): any {
  if (nextValue !== current) wrongIdentity += 1;
  if (arguments.length !== 1) wrongArgumentCount += 1;
  if (this !== Promise) wrongThis += 1;
  current = next;
  next = afterNext;
  afterNext = null;
  callCount += 1;
  return resolve.apply(Promise, arguments);
};

Promise.all([p1, p2, p3]);

export function test(): number {
  return callCount === 3 && wrongIdentity === 0 && wrongArgumentCount === 0 && wrongThis === 0 ? 0 : 9;
}`),
    ).resolves.toBe(0);
  });

  it("does not treat a module-scope user binding named Promise as the intrinsic", async () => {
    await expect(
      runStandalone(`var Promise: any = { resolve: 1 };
Promise.resolve = 7;

export function test(): number {
  return Promise.resolve === 7 ? 0 : 9;
}`),
    ).resolves.toBe(0);
  });

  it("does not retain an import-rewriter Promise binding as intrinsic resolve setup", async () => {
    const wat = await compileStandaloneWat(`import { Promise } from "fixture";
var calls: number = 0;
Promise.resolve = function(value: any): any {
  calls += 1;
  return new Promise(function(resolve: any): void { resolve(value); });
};
Promise.all([1]);
export function test(): number { return calls; }
`);
    // `preprocessImports` turns the import into `declare const Promise: any`.
    // The static builtin still supplies resolve/all helpers, but the direct
    // intrinsic-write setter must not be emitted for that user binding.
    expect(wat).not.toContain("(func $__set_member_resolve");
    expect(wat).not.toContain("(func $__set_member_nonstrict_resolve");
  });

  it("evaluates every literal input before the one resolve Get and rejects its abrupt completion", async () => {
    await expect(
      runStandalone(`export function test(): number {
  let order: number = 0;
  let orderAtGet: number = 0;
  let getCount: number = 0;
  let rejected: number = 0;
  const error: any = { marker: 1 };
  function first(): any { if (order !== 0) return -1; order = 1; return 1; }
  function second(): any { if (order !== 1) return -2; order = 2; return 2; }
  Object.defineProperty(Promise, "resolve", {
    configurable: true,
    get: function(): any {
      getCount += 1;
      orderAtGet = order;
      throw error;
    },
  });
  Promise.all([first(), second()]).then(
    function(): void { rejected = 2; },
    function(reason: any): void { rejected = reason === error ? 1 : 3; },
  );
  __drain_microtasks();
  return order === 2 && orderAtGet === 2 && getCount === 1 && rejected === 1 ? 0 : 9;
}`),
    ).resolves.toBe(0);
  });

  it("gets resolve once, captures it across replacement, and calls it once per value with Promise", async () => {
    await expect(
      runStandalone(`export function test(): number {
  let getCount: number = 0;
  let capturedCalls: number = 0;
  let replacementCalls: number = 0;
  let wrongThis: number = 0;
  let wrongArgumentCount: number = 0;
  let settled: number = 0;
  const replacement: any = function(this: any, value: any): any {
    replacementCalls += 1;
    return new Promise(function(resolve: any): void { resolve(value); });
  };
  const captured: any = function(this: any, value: any): any {
    if (arguments.length !== 1) wrongArgumentCount += 1;
    if (this !== Promise) wrongThis += 1;
    capturedCalls += 1;
    if (capturedCalls === 1) {
      Object.defineProperty(Promise, "resolve", {
        configurable: true,
        value: replacement,
        writable: true,
      });
    }
    return new Promise(function(resolve: any): void { resolve(value); });
  };
  Object.defineProperty(Promise, "resolve", {
    configurable: true,
    get: function(): any { getCount += 1; return captured; },
  });
  Promise.all([1, 2]).then(
    function(values: any): void { settled = values[0] === 1 && values[1] === 2 ? 1 : 2; },
    function(): void { settled = 3; },
  );
  __drain_microtasks();
  return getCount === 1 && capturedCalls === 2 && replacementCalls === 0 && wrongThis === 0 && wrongArgumentCount === 0 && settled === 1 ? 0 : 9;
}`),
    ).resolves.toBe(0);
  });

  it("contrasts callback argc before and after the original first helper call", async () => {
    await expect(
      runStandalone(`export function test(): number {
  const p1 = new Promise(function(): void {});
  const p2 = new Promise(function(): void {});
  const p3 = new Promise(function(): void {});
  const resolve: any = Promise.resolve;
  let callbackEntries: number = 0;
  let wrongIdentity: number = 0;
  let wrongArgumentCountBeforeFirstHelper: number = 0;
  let wrongArgumentCountAfterFirstHelper: number = 0;
  let wrongThis: number = 0;
  let current: any = p1;
  let next: any = p2;
  let afterNext: any = p3;
  const assert: any = {
    sameValue: function(actual: any, expected: any): void {
      if (actual !== expected) throw { marker: 1 };
    },
  };
  (Promise as any).resolve = function(this: any, nextValue: any): any {
    callbackEntries += 1;
    // Test262's first callback operation is assert.sameValue(nextValue,
    // current), before its arguments.length assertion. __apply_closure's
    // temporary argc carrier makes both sides of that nested call useful
    // diagnostic evidence.
    if (arguments.length !== 1) wrongArgumentCountBeforeFirstHelper += 1;
    try {
      assert.sameValue(nextValue, current);
    } catch (_error) {
      wrongIdentity += 1;
    }
    if (arguments.length !== 1) wrongArgumentCountAfterFirstHelper += 1;
    if (this !== Promise) wrongThis += 1;
    current = next;
    next = afterNext;
    afterNext = null;
    return resolve.apply(Promise, arguments);
  };
  Promise.all([p1, p2, p3]);
  return (callbackEntries === 3 ? 0 : 1) |
    (wrongIdentity === 0 ? 0 : 2) |
    (wrongArgumentCountBeforeFirstHelper === 0 ? 0 : 4) |
    (wrongArgumentCountAfterFirstHelper === 0 ? 0 : 8) |
    (wrongThis === 0 ? 0 : 16);
}`),
    ).resolves.toBe(0);
  });

  it("diagnoses the original invoke-resolve callback order without reading arguments before its first helper", async () => {
    await expect(
      runStandalone(`export function test(): number {
  const p1 = new Promise(function(): void {});
  const p2 = new Promise(function(): void {});
  const p3 = new Promise(function(): void {});
  const resolve: any = Promise.resolve;
  let callbackEntries: number = 0;
  let wrongIdentity: number = 0;
  let wrongArgumentCount: number = 0;
  let wrongThis: number = 0;
  let current: any = p1;
  let next: any = p2;
  let afterNext: any = p3;
  const assert: any = {
    sameValue: function(actual: any, expected: any): void {
      if (actual !== expected) throw { marker: 1 };
    },
  };
  (Promise as any).resolve = function(this: any, nextValue: any): any {
    callbackEntries += 1;
    try {
      assert.sameValue(nextValue, current);
    } catch (_error) {
      wrongIdentity += 1;
    }
    if (arguments.length !== 1) wrongArgumentCount += 1;
    if (this !== Promise) wrongThis += 1;
    current = next;
    next = afterNext;
    afterNext = null;
    return resolve.apply(Promise, arguments);
  };
  Promise.all([p1, p2, p3]);
  return (callbackEntries === 3 ? 0 : 1) |
    (wrongIdentity === 0 ? 0 : 2) |
    (wrongArgumentCount === 0 ? 0 : 4) |
    (wrongThis === 0 ? 0 : 8);
}`),
    ).resolves.toBe(0);
  });

  it("gets a returned thenable's own then once and invokes that captured closure with its receiver", async () => {
    await expect(
      runStandalone(`export function test(): number {
  let getCount: number = 0;
  let firstCalls: number = 0;
  let secondCalls: number = 0;
  let wrongReceiver: number = 0;
  let settled: number = 0;
  const thenable: any = { value: 73 };
  Object.defineProperty(thenable, "then", {
    configurable: true,
    get: function(): any {
      getCount += 1;
      if (getCount === 1) {
        return function(this: any, onFulfilled: any, _onRejected: any): any {
          firstCalls += 1;
          if (this !== thenable) wrongReceiver += 1;
          onFulfilled(this.value);
          return undefined;
        };
      }
      return function(): any { secondCalls += 1; return undefined; };
    },
  });
  (Promise as any).resolve = function(_value: any): any { return thenable; };
  Promise.race([1]).then(
    function(value: any): void { settled = value === 73 ? 1 : 2; },
    function(): void { settled = 3; },
  );
  __drain_microtasks();
  return getCount === 1 && firstCalls === 1 && secondCalls === 0 && wrongReceiver === 0 && settled === 1 ? 0 : 9;
}`),
    ).resolves.toBe(0);
  });

  it("turns an abrupt per-element resolve Call into one rejected aggregate and stops the pipeline", async () => {
    await expect(
      runStandalone(`export function test(): number {
  let calls: number = 0;
  let rejected: number = 0;
  const error: any = { marker: 1 };
  (Promise as any).resolve = function(_value: any): any {
    calls += 1;
    throw error;
  };
  Promise.all([1, 2]).then(
    function(): void { rejected = 2; },
    function(reason: any): void { rejected = reason === error ? 1 : 3; },
  );
  __drain_microtasks();
  return calls === 1 && rejected === 1 ? 0 : 9;
}`),
    ).resolves.toBe(0);
  });

  it("keeps Promise.all's completion sentinel through a synchronous thenable throw", async () => {
    await expect(
      runStandalone(`export function test(): number {
  const marker: any = { marker: 1 };
  let settled: number = 0;
  (Promise as any).resolve = function(): any {
    return {
      then: function(resolve: any): any {
        resolve(1);
        throw marker;
      },
    };
  };
  Promise.all([1]).then(
    function(): void { settled = 2; },
    function(reason: any): void { settled = reason === marker ? 1 : 3; },
  );
  __drain_microtasks();
  return settled === 1 ? 0 : 9;
}`),
    ).resolves.toBe(0);
  });

  it("fulfills a synchronous observable thenable only after completion with its full results vector", async () => {
    await expect(
      runStandalone(`export function test(): number {
  let settled: number = 0;
  (Promise as any).resolve = function(): any {
    return {
      then: function(resolve: any): any {
        resolve(41);
        return undefined;
      },
    };
  };
  Promise.all([1]).then(
    function(values: any): void { settled = values.length === 1 && values[0] === 41 ? 1 : 2; },
    function(): void { settled = 3; },
  );
  __drain_microtasks();
  return settled === 1 ? 0 : 9;
}`),
    ).resolves.toBe(0);
  });

  it("reads and boxes each f64 vector element at its pipeline turn", async () => {
    await expect(
      runStandalone(`export function test(): number {
  const values: number[] = [1, 2];
  let calls: number = 0;
  let settled: number = 0;
  (Promise as any).resolve = function(value: any): any {
    calls += 1;
    if (calls === 1) values[1] = 42;
    return new Promise(function(resolve: any): void { resolve(value); });
  };
  Promise.all(values).then(
    function(result: any): void { settled = result[0] === 1 && result[1] === 42 ? 1 : 2; },
    function(): void { settled = 3; },
  );
  __drain_microtasks();
  return calls === 2 && settled === 1 ? 0 : 9;
}`),
    ).resolves.toBe(0);
  });

  it("reuses intrinsic Promise.race result handlers across two then Invokes", async () => {
    await expect(
      runStandalone(`export function test(): number {
  let calls: number = 0;
  let sameHandlers: number = 0;
  let settled: number = 0;
  let firstResolve: any = null;
  let firstReject: any = null;
  const thenable: any = {
    then: function(resolve: any, reject: any): any {
      calls += 1;
      if (calls === 1) {
        firstResolve = resolve;
        firstReject = reject;
        resolve(61);
      } else if (resolve === firstResolve && reject === firstReject) {
        sameHandlers = 1;
      }
      return undefined;
    },
  };
  (Promise as any).resolve = function(_value: any): any { return thenable; };
  Promise.race([1, 2]).then(
    function(value: any): void { settled = value === 61 ? 1 : 2; },
    function(): void { settled = 3; },
  );
  __drain_microtasks();
  return calls === 2 && sameHandlers === 1 && settled === 1 ? 0 : 9;
}`),
    ).resolves.toBe(0);
  });
});
