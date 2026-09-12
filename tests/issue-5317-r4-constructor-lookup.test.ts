// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<number> {
  const result = await compile(`export function test(): number { ${body} }`, {
    fileName: "issue-5317-constructor.ts",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

const DYNAMIC_VIEW = `const ctors: any[] = [Int32Array]; var answer = 0;
  for (const C of ctors) { const view: any = new C(new ArrayBuffer(16));`;

describe("#5317 TypedArray ordinary constructor lookup", () => {
  it("retains all nine intrinsic constructor identities without reflection", async () => {
    expect(
      await run(`const ctors: any[] = [Int8Array, Uint8Array, Uint8ClampedArray,
      Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array];
      var count = 0; for (const C of ctors) { var view: any = new C(2);
        if (view.constructor === C) count++; } return count;`),
    ).toBe(9);
  });

  for (const value of ["undefined", "null", "73"]) {
    it(`preserves an inherited constructor data value of ${value}`, async () => {
      expect(
        await run(`${DYNAMIC_VIEW}
        Object.defineProperty(Int32Array.prototype, "constructor", { value: ${value}, configurable: true });
        answer = view.constructor === ${value} ? 1 : 0;
      } return answer;`),
      ).toBe(1);
    });
  }

  for (const location of ["view", "Int32Array.prototype"]) {
    it(`calls a getter on ${location} once with the original receiver`, async () => {
      expect(
        await run(`${DYNAMIC_VIEW}
        var calls = 0; var receiver;
        Object.defineProperty(${location}, "constructor", { configurable: true,
          get: function() { calls++; receiver = this; return undefined; } });
        var value = view.constructor;
        answer = (calls === 1 ? 1 : 0) + (receiver === view ? 2 : 0) +
          (value === undefined ? 4 : 0);
      } return answer;`),
      ).toBe(7);
    });
  }

  it("preserves an explicit Reflect.get receiver for an own accessor", async () => {
    expect(
      await run(`${DYNAMIC_VIEW}
      var receiver = {}; var seen;
      Object.defineProperty(view, "constructor", { get: function() { seen = this; return 73; } });
      var value = Reflect.get(view, "constructor", receiver);
      answer = (seen === receiver ? 1 : 0) + (value === 73 ? 2 : 0);
    } return answer;`),
    ).toBe(3);
  });

  it("observes deletion and does not reseed a replaced constructor", async () => {
    expect(
      await run(`${DYNAMIC_VIEW}
      var proto: any = Int32Array.prototype;
      var descriptor: any = Object.getOwnPropertyDescriptor(Int32Array.prototype, "constructor");
      var flags = descriptor.writable && descriptor.configurable && !descriptor.enumerable;
      delete proto.constructor;
      var absent = !Object.prototype.hasOwnProperty.call(proto, "constructor");
      var inherited = view.constructor === Object.getPrototypeOf(Int32Array);
      Object.defineProperty(proto, "constructor", { value: undefined, configurable: true });
      var first = view.constructor; var second = view.constructor;
      answer = (flags ? 1 : 0) + (absent ? 2 : 0) + (inherited ? 4 : 0) +
        (first === undefined && second === undefined ? 8 : 0);
    } return answer;`),
    ).toBe(15);
  });

  it("uses the prototype selected by Reflect.construct", async () => {
    expect(
      await run(`function NewTarget() {} NewTarget.prototype = { constructor: 87 };
      var ctors: any[] = [Int32Array]; var answer = 0;
      for (const C of ctors) { var view: any = Reflect.construct(C, [4], NewTarget);
        answer = view.constructor === 87 ? 1 : 0; } return answer;`),
    ).toBe(1);
  });

  it("propagates the exact inherited getter exception before the callback", async () => {
    expect(
      await run(`${DYNAMIC_VIEW}
      var sentinel = {}; var callbacks = 0;
      Object.defineProperty(Int32Array.prototype, "constructor", { configurable: true,
        get: function() { throw sentinel; } });
      try { view.map(function(x) { callbacks++; return x; }); }
      catch (error) { answer = (error === sentinel ? 1 : 0) + (callbacks === 0 ? 2 : 0); }
    } return answer;`),
    ).toBe(3);
  });
});
