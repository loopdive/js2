// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// A generic source rest parameter (`...args: T`, `T extends unknown[]`) lowers
// to one externref formal rather than the canonical vec-ref formal. The host
// closure dispatchers still classify it as JavaScript arity zero. They must
// therefore materialize that hidden rest-array argument before `call_ref`;
// otherwise `__call_fn_0` supplies only closure self to a two-param funcref.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const TYPESCRIPT_OR_SHAPE = `
export function or<T extends unknown[], U>(...fs: ((...args: T) => U)[]): (...args: T) => U {
  return (...args) => {
    let lastResult: U;
    for (const f of fs) {
      lastResult = f(...args);
      if (lastResult) return lastResult;
    }
    return lastResult!;
  };
}

export function test(): number {
  const positive = (value: number) => value > 0;
  const predicate: any = or(positive);
  return predicate(1) ? 1 : 0;
}
`;

const HOST_DISPATCH_SOURCE = `
export function makeArrow<T extends unknown[]>(bias: number): (...args: T) => number {
  return (...args: T) => bias + args.length;
}

export function makeMethod<T extends unknown[]>(bias: number): (...args: T) => number {
  return function (...args: T): number {
    return bias + (this as any).offset + args.length;
  };
}
`;

describe("#1058 externref-backed closure rest host dispatch", () => {
  it("keeps TypeScript's captured generic-rest predicate dispatcher valid", async () => {
    const result = await compile(TYPESCRIPT_OR_SHAPE, {
      fileName: "issue-1058-typescript-or-rest.ts",
      target: "standalone",
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("materializes empty and populated rest arrays for plain and method host calls", async () => {
    const result = await compile(HOST_DISPATCH_SOURCE, {
      fileName: "issue-1058-closure-rest-host-dispatch.ts",
      skipSemanticDiagnostics: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = instance.exports as unknown as {
      makeArrow(bias: number): unknown;
      makeMethod(bias: number): unknown;
      __call_fn_0(closure: unknown): number;
      __call_fn_2(closure: unknown, first: unknown, second: unknown): number;
      __call_fn_method_0(receiver: unknown, closure: unknown): number;
      __call_fn_method_2(receiver: unknown, closure: unknown, first: unknown, second: unknown): number;
    };

    const arrow = exports.makeArrow(10);
    expect(exports.__call_fn_0(arrow)).toBe(10);
    expect(exports.__call_fn_2(arrow, 1, 2)).toBe(12);

    const method = exports.makeMethod(10);
    const receiver = { offset: 5 };
    expect(exports.__call_fn_method_0(receiver, method)).toBe(15);
    expect(exports.__call_fn_method_2(receiver, method, 1, 2)).toBe(17);
  });
});
