// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// `f(a)(b)` — invoking the result of a call.
//
// The signature-directed dispatcher only engages when the callee expression's
// TS type carries a call signature. An `any`-typed callee (every untyped `.js`
// dependency, anything behind an `as any`) has none, so the shape fell to
// `compileCallDispatchTail`'s graceful fallback: the INNER call ran, then its
// closure and every outer argument were dropped and the whole expression
// answered `undefined`. Compile succeeded and nothing was reported.
//
// The `it.each(rows)(name, body)` registration used by every upstream npm
// unit suite is exactly this shape.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function runSource(source: string): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("curried call dispatch", () => {
  it("invokes the closure returned by a top-level function", async () => {
    expect(
      await runSource(`
function h(a: any): any { return function (b: any): any { return a + b; }; }
export function test(): any { return h(1)(2); }`),
    ).toBe(3);
  });

  it("invokes the closure returned by an assigned object member", async () => {
    expect(
      await runSource(`
const o: any = {};
o.p = function (a: any): any { return function (b: any): any { return a + b; }; };
export function test(): any { return o.p(1)(2); }`),
    ).toBe(3);
  });

  it("invokes the closure returned by an object-literal member", async () => {
    expect(
      await runSource(`
const o = { p: function (a: any): any { return function (b: any): any { return a + b; }; } };
export function test(): any { return o.p(1)(2); }`),
    ).toBe(3);
  });

  it("invokes the closure returned by a class method", async () => {
    expect(
      await runSource(`
class C { p(a: any): any { return function (b: any): any { return a + b; }; } }
const c = new C();
export function test(): any { return c.p(1)(2); }`),
    ).toBe(3);
  });

  it("invokes a zero-argument curried chain", async () => {
    expect(
      await runSource(`
const o: any = {};
o.p = function (): any { return function (): any { return 9; }; };
export function test(): any { return o.p()(); }`),
    ).toBe(9);
  });

  it("registers cases through the `it.each`-shaped double call", async () => {
    // The reduced shape of the upstream-suite shim: a factory call whose
    // result is invoked immediately with the test name and body.
    expect(
      await runSource(`
const registered: any[] = [];
function record(name: string, body: any): void { registered.push({ name: name, body: body }); }
function each(cases: any): any {
  return function (name: any, body: any): void {
    for (let i = 0; i < cases.length; i++) {
      const row = cases[i];
      record(String(name) + i, function () { return body(row[0], row[1]); });
    }
  };
}
each([["a", 1], ["b", 2]])("case", function (n: any, v: any) { return n + ":" + v; });
export function test(): any { return [registered.length, registered[0].body(), registered[1].body()]; }`),
    ).toEqual([2, "a:1", "b:2"]);
  });
});
