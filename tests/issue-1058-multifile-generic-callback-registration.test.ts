// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, wrapExports } from "../src/index.js";

describe("#1058 multi-file generic callback registration", () => {
  it("registers a later source file's concrete callback return ABI", async () => {
    const result = await compileMulti(
      {
        "./warm.ts": `
export function invokeWarm<T>(callback: (value: number) => T): T {
  return callback(1);
}

export function warm(): number {
  return invokeWarm(value => value + 1);
}
`,
        "./callback.ts": `
export interface Box {
  value: number;
}

export function invokeLater<T>(callback: (value: number) => T): T {
  return callback(7);
}

function makeBoxes(value: number): Box[] {
  return [{ value }];
}

export function callbackResult(): number {
  return invokeLater(makeBoxes)[0].value;
}

export function visitBoxes<T>(callback: (values: Box[]) => T | undefined, values: Box[]): T | undefined {
  return callback(values);
}

export function capturedResult(): number {
  let count = 0;
  function addWorkItem(_value: Box | Box[]): void {
    count += 3;
  }
  visitBoxes(addWorkItem, [{ value: 1 }]);
  return count;
}

export function reduceTwice<T, U>(
  callback: (pos: number, end: number, kind: number, trailing: boolean, state: T, accumulator: U) => U,
  state: T,
  initial: U,
): U {
  let accumulator = callback(0, 1, 2, false, state, initial);
  accumulator = callback(1, 2, 3, true, state, accumulator);
  return accumulator;
}

function appendRange(
  _pos: number,
  end: number,
  _kind: number,
  _trailing: boolean,
  _state: unknown,
  ranges: Box[] = [],
): Box[] {
  ranges.push({ value: end });
  return ranges;
}

export function reducerResult(): number {
  return (reduceTwice(appendRange, undefined, undefined) as Box[]).length;
}
`,
        "./main.ts": `
import "./warm.js";
import { callbackResult, capturedResult, reducerResult } from "./callback.js";

export function callbackOnly(): number { return callbackResult(); }
export function capturedOnly(): number { return capturedResult(); }
export function reducerOnly(): number { return reducerResult(); }

export function test(): number {
  return callbackResult() * 10000 + capturedResult() * 100 + reducerResult();
}
`,
      },
      "./main.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map(error => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as {
      callbackOnly(): number;
      capturedOnly(): number;
      reducerOnly(): number;
      test(): number;
    };
    let callbackValue: number;
    let capturedValue: number;
    let reducerValue: number;
    try {
      callbackValue = exports.callbackOnly();
    } catch (error) {
      throw new Error(`callbackOnly trapped: ${String(error)}`);
    }
    try {
      capturedValue = exports.capturedOnly();
    } catch (error) {
      throw new Error(`capturedOnly trapped: ${String(error)}`);
    }
    try {
      reducerValue = exports.reducerOnly();
    } catch (error) {
      throw new Error(`reducerOnly trapped: ${String(error)}`);
    }
    expect(callbackValue).toBe(7);
    expect(capturedValue).toBe(3);
    expect(reducerValue).toBe(2);
    expect(exports.test()).toBe(70302);
  });
});
