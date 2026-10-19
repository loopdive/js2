// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const source = `
  export function check(value: any, target: any): number { return value instanceof target ? 1 : 0; }
  export function numeric(value: number, target: any): number { return value instanceof target ? 1 : 0; }
  export function echo(value: any): any { return value; }
`;
type Exports = {
  check: (value: unknown, target: unknown) => number;
  numeric: (value: number, target: unknown) => number;
  echo: (value: unknown) => unknown;
};

describe("#6979 native dynamic instanceof at the JS value boundary", () => {
  let result: CompileResult;
  let ex: Exports;
  beforeAll(async () => {
    result = await compile(source, { trackIrOutcomes: true });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    ex = wrapCompiledExports(result, instance) as Exports;
  });

  it("owns both operator bodies in prepared IR, without a legacy body", () => {
    expect(result.irBodyRouteAudit?.target).toBe("gc");
    for (const name of ["check", "numeric"]) {
      const row = result.irOutcomes?.find((item) => item.displayName === name);
      expect(row).toMatchObject({
        kind: "emitted",
        directBodyEmissions: 0,
        irBodyEmissions: 1,
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect(row?.r2Withdrawal).toBeUndefined();
      expect(result.irBodyRouteAudit?.legacyEntries.filter((item) => item.bodyName === name)).toEqual([]);
    }
  });

  it("keeps JS-owned instances and constructors identical, with positive and negative membership", () => {
    class Foreign {}
    const value = new Foreign();
    expect(ex.echo(value)).toBe(value);
    expect(ex.echo(Foreign)).toBe(Foreign);
    expect(ex.check(value, Foreign)).toBe(1);
    expect(ex.check({}, Foreign)).toBe(0);
    expect(ex.check(7, Foreign)).toBe(0);
  });

  it("reads a live getter once and calls its result once with original receiver, value and arity", () => {
    const value = {};
    const events: unknown[] = [];
    let answer = true;
    const handler = new Proxy(
      function (this: unknown, received: unknown) {
        // biome-ignore lint/style/noArguments: observe the real call arity, not a synthesized/rest argument list.
        events.push(["call", this === target, received === value, arguments.length]);
        return answer;
      },
      {
        get(fn, key, receiver) {
          events.push(["handler-get", key]);
          return Reflect.get(fn, key, receiver);
        },
      },
    );
    const target = new Proxy(
      {
        get [Symbol.hasInstance]() {
          events.push("get");
          return handler;
        },
      },
      {
        get(obj, key, receiver) {
          events.push(["target-get", key]);
          return Reflect.get(obj, key, receiver);
        },
      },
    );
    expect(ex.check(value, target)).toBe(1);
    expect(events).toEqual([["target-get", Symbol.hasInstance], "get", ["call", true, true, 1]]);
    events.length = 0;
    answer = false;
    expect(ex.check(value, target)).toBe(0);
    expect(events).toEqual([["target-get", Symbol.hasInstance], "get", ["call", true, true, 1]]);
  });

  it("does not fold a numeric LHS before invoking a custom handler", () => {
    const values: unknown[] = [];
    const target = {
      [Symbol.hasInstance](value: unknown) {
        values.push(value);
        return value === 7;
      },
    };
    expect(ex.numeric(7, target)).toBe(1);
    expect(ex.numeric(8, target)).toBe(0);
    expect(values).toEqual([7, 8]);
  });

  it.each([false, 0, "", null, undefined, true, 3, "yes", {}])(
    "uses native truthiness for handler result %s",
    (answer) => {
      expect(ex.check({}, { [Symbol.hasInstance]: () => answer })).toBe(answer ? 1 : 0);
    },
  );

  it("propagates the original getter and handler exceptions", () => {
    const failure = {};
    const throws = [
      {
        get [Symbol.hasInstance]() {
          throw failure;
        },
      },
      {
        [Symbol.hasInstance]() {
          throw failure;
        },
      },
    ];
    for (const target of throws) {
      let received: unknown;
      try {
        ex.check({}, target);
      } catch (error) {
        received = error;
      }
      expect(received).toBe(failure);
    }
  });

  it.each([null, undefined])("treats handler %s as absent before ordinary membership", (handler) => {
    class Foreign {}
    Object.defineProperty(Foreign, Symbol.hasInstance, { value: handler });
    expect(ex.check({}, Foreign)).toBe(0);
    expect(() => ex.check({}, { [Symbol.hasInstance]: handler })).toThrow(TypeError);
  });

  it.each([
    null,
    undefined,
    2,
    true,
    "foo",
    Symbol("rhs"),
    {},
    { [Symbol.hasInstance]: 1 },
    { [Symbol.hasInstance]: class Handler {} },
  ])("throws TypeError for invalid RHS/handler %s", (target) => {
    expect(() => ex.check({}, target)).toThrow(TypeError);
  });

  it("delegates the JS default method without recursing into an own override", () => {
    class Foreign {}
    const value = new Foreign();
    let calls = 0;
    Object.defineProperty(Foreign, Symbol.hasInstance, {
      value: function (received: unknown) {
        calls++;
        return Function.prototype[Symbol.hasInstance].call(this, received);
      },
    });
    expect(ex.check(value, Foreign)).toBe(1);
    expect(calls).toBe(1);
  });
});

for (const target of ["standalone", "wasi"] as const) {
  it(`#6979 native dynamic builtin constructor membership has no JS imports — ${target}`, async () => {
    const result = await compile(
      `
      export function check(n: number): number {
        var ctor: any = Object;
        var value: any = {};
        return value instanceof ctor ? n + 1 : 0;
      }
    `,
      { target, trackIrOutcomes: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    const check = instance.exports.check as (n: number) => number;
    expect(check(41)).toBe(42);
    expect(check(6)).toBe(7);
  });
}
