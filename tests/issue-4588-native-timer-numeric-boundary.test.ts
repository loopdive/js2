// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";
import * as lateImports from "../src/codegen/shared.js";

const TIMER_SOURCE =
  "export function run(): number { const h = +setTimeout(() => {}, 1.5); clearTimeout(h); return h; }";
const NUMERIC_NAMES = ["__typeof_number", "__unbox_number", "__box_number"] as const;

async function timerInstance(handle: unknown, clear?: (value: unknown) => void) {
  const result = await compile(TIMER_SOURCE, { fileName: "timer-native-numeric.ts", optimize: false });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const observed: { delay?: number; clear?: unknown } = {};
  const deps = {
    setTimeout(_callback: () => void, delay: number) {
      observed.delay = delay;
      return handle;
    },
    clearTimeout(value: unknown) {
      observed.clear = value;
      clear?.(value);
    },
  };
  const imports = buildCompiledImports(result, deps);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  imports.setExports?.(instance.exports as Record<string, Function>);
  for (const name of NUMERIC_NAMES) expect(typeof instance.exports[name], name).toBe("function");
  return { result, instance, observed, run: instance.exports.run as () => number };
}

function thrownHostValue(instance: WebAssembly.Instance, action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    const tag = instance.exports.__exn_tag as WebAssembly.Tag | undefined;
    if (tag && error instanceof WebAssembly.Exception && error.is(tag)) return error.getArg(tag, 0);
    return error;
  }
  throw new Error("expected an abrupt timer handle conversion");
}

describe("native timer numeric capability boundary", () => {
  it("round-trips a real Node Timeout and delegates compiled cancellation of its fractional outside-i31 handle exactly once", async () => {
    const real = setTimeout(() => {
      throw new Error("cancelled timer fired");
    }, 60_000);
    const expected = 2 ** 31 + 0.5;
    const events: unknown[] = [];
    Object.defineProperty(real, Symbol.toPrimitive, {
      configurable: true,
      value(this: unknown, hint: string) {
        events.push([this === real, hint]);
        return expected;
      },
    });
    try {
      // Real JavaScript reference conversion, then reset observations for the compiled invocation.
      expect(+real).toBe(expected);
      expect(events).toEqual([[true, "number"]]);
      events.length = 0;
      let hostClearCalls = 0;
      const actual = await timerInstance(real, (value) => {
        // This provider owns the real timer behind the chosen numeric handle.
        // The guest's clearTimeout must reach this exact host operation.
        expect(value).toBe(expected);
        hostClearCalls++;
        clearTimeout(real);
      });
      const value = actual.run();
      expect(value).toBe(expected);
      expect(actual.observed.delay).toBe(1.5);
      expect(actual.observed.clear).toBe(expected);
      expect(hostClearCalls).toBe(1);
      expect(events).toEqual([[true, "number"]]);
    } finally {
      clearTimeout(real);
    }
  });

  it("uses ToPrimitive on a normal function-valued handle input", async () => {
    const handle = function timerHandle() {};
    let calls = 0;
    handle.valueOf = () => {
      calls++;
      return 12.5;
    };
    const actual = await timerInstance(handle);
    expect(actual.run()).toBe(12.5);
    expect(actual.observed.clear).toBe(12.5);
    expect(calls).toBe(1);
  });

  it("rejects a function returned by the exotic method without coercing that function again", async () => {
    let calls = 0,
      second = 0;
    const returned = function returnedFunction() {};
    returned.valueOf = () => {
      second++;
      return 99;
    };
    const handle = {
      [Symbol.toPrimitive]() {
        calls++;
        return returned;
      },
    };
    expect(() => +handle).toThrow(TypeError);
    calls = 0;
    const actual = await timerInstance(handle);
    expect(thrownHostValue(actual.instance, actual.run)).toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
    expect(second).toBe(0);
    expect(actual.observed.clear).toBeUndefined();
  });

  it("continues ordinary ToPrimitive after valueOf returns a function", async () => {
    let valueOfCalls = 0,
      toStringCalls = 0;
    const handle = {
      valueOf() {
        valueOfCalls++;
        return function notPrimitive() {};
      },
      toString() {
        toStringCalls++;
        return "12.5";
      },
    };
    expect(+handle).toBe(12.5);
    valueOfCalls = 0;
    toStringCalls = 0;
    const actual = await timerInstance(handle);
    expect(actual.run()).toBe(12.5);
    expect(valueOfCalls).toBe(1);
    expect(toStringCalls).toBe(1);
  });

  it("accepts null returned by the exotic method as the primitive zero", async () => {
    let calls = 0;
    const handle = {
      [Symbol.toPrimitive]() {
        calls++;
        return null;
      },
    };
    expect(+handle).toBe(0);
    calls = 0;
    const actual = await timerInstance(handle);
    expect(actual.run()).toBe(0);
    expect(calls).toBe(1);
  });

  it("preserves the actual abrupt object identity from handle conversion", async () => {
    const sentinel = { reason: "host conversion" };
    let calls = 0;
    const handle = {
      [Symbol.toPrimitive]() {
        calls++;
        throw sentinel;
      },
    };
    const actual = await timerInstance(handle);
    expect(thrownHostValue(actual.instance, actual.run)).toBe(sentinel);
    expect(calls).toBe(1);
  });

  for (const [label, primitive] of [
    ["Symbol", Symbol("timer")],
    ["BigInt", 1n],
  ] as const) {
    it("rejects " + label + " handle conversion like unary plus", async () => {
      const handle = {
        [Symbol.toPrimitive]() {
          return primitive;
        },
      };
      expect(() => +handle).toThrow(TypeError);
      const actual = await timerInstance(handle);
      expect(thrownHostValue(actual.instance, actual.run)).toBeInstanceOf(TypeError);
    });
  }
});

const sourceNamesakes = [
  ["__box_number", "value: number", "any", "value"],
  ["__typeof_number", "value: any", "boolean", "true"],
  ["__unbox_number", "value: any", "number", "7"],
] as const;

describe("native numeric public export ownership", () => {
  for (const [name, param, result, value] of sourceNamesakes) {
    for (const use of ["timer", "typed Promise with a dynamic namesake signature"] as const) {
      it("rejects a same-shaped source namesake " + name + " for " + use, async () => {
        const boundary =
          use === "timer" ? TIMER_SOURCE : "export function run(): Promise<number> { return Promise.resolve(7); }";
        const source =
          "export function " + name + "(" + param + "): " + result + " { return " + value + "; } " + boundary;
        const actual = await compile(source, { fileName: "numeric-namesake.ts", optimize: false });
        expect(actual.success, JSON.stringify(actual.errors)).toBe(false);
        expect(actual.binary.byteLength).toBe(0);
        expect(actual.errors.map((row) => row.message).join("\n")).toMatch(/native numeric boundary/);
      });
    }

    it("rejects a source export alias colliding with " + name, async () => {
      const source =
        "function sourceHelper(" +
        param +
        "): " +
        result +
        " { return " +
        value +
        "; } export { sourceHelper as " +
        name +
        " }; " +
        TIMER_SOURCE;
      const actual = await compile(source, { fileName: "numeric-export-alias.ts", optimize: false });
      expect(actual.success, JSON.stringify(actual.errors)).toBe(false);
      expect(actual.binary.byteLength).toBe(0);
      expect(actual.errors.map((row) => row.message).join("\n")).toMatch(/native numeric boundary/);
    });

    it("executes a pure typed source export named " + name + " when no dynamic numeric boundary owns it", async () => {
      const sourceBody = name === "__typeof_number" ? "return value === 13;" : "return value + 17;";
      const sourceResult = name === "__typeof_number" ? "boolean" : "number";
      const source = "export function " + name + "(value: number): " + sourceResult + " { " + sourceBody + " }";
      const actual = await compile(source, { fileName: "ordinary-source-numeric-name.ts", optimize: false });
      expect(actual.success, JSON.stringify(actual.errors)).toBe(true);
      expect(WebAssembly.validate(actual.binary)).toBe(true);
      const imports = buildCompiledImports(actual);
      const { instance } = await WebAssembly.instantiate(actual.binary, imports);
      imports.setInstance?.(instance);
      imports.setExports?.(instance.exports as Record<string, Function>);
      const exports = wrapExports(instance, { signatures: actual.exportSignatures });
      expect(exports[name](13)).toBe(name === "__typeof_number" ? true : 30);
      expect(exports[name](2)).toBe(name === "__typeof_number" ? false : 19);
    });
  }
});

describe("export-result Promise boundary authority", () => {
  for (const annotation of ["Promise<number>", "any"] as const) {
    it("settles an actual exported " + annotation + " Promise result", async () => {
      const actual = await compile("export function run(): " + annotation + " { return Promise.resolve(7); }", {
        fileName: "exported-promise-result.ts",
        target: "gc",
        optimize: false,
        deferTopLevelInit: true,
      });
      expect(actual.success, JSON.stringify(actual.errors)).toBe(true);
      const imports = buildCompiledImports(actual);
      const { instance } = await WebAssembly.instantiate(actual.binary, imports);
      imports.setInstance?.(instance);
      imports.setExports?.(instance.exports as Record<string, Function>);
      (instance.exports.__module_init as (() => void) | undefined)?.();
      const exports = wrapExports(instance, { signatures: actual.exportSignatures });
      await expect(exports.run()).resolves.toBe(7);
    });
  }

  it("does not request Promise notification imports for only a dynamic parameter and a scalar result", async () => {
    const requests: string[] = [];
    const original = lateImports.ensureLateImport;
    const spy = vi.spyOn(lateImports, "ensureLateImport").mockImplementation((...args) => {
      requests.push(args[1]);
      return original(...args);
    });
    let actual: CompileResult;
    try {
      actual = await compile("export function run(value: any): number { return 7; }", {
        fileName: "dynamic-param-scalar-result.ts",
        target: "gc",
        optimize: false,
      });
    } finally {
      spy.mockRestore();
    }
    expect(actual!.success, JSON.stringify(actual!.errors)).toBe(true);
    expect(requests.filter((name) => /^__boundary_promise_(resolve|reject)$/.test(name))).toEqual([]);
    expect(actual!.imports.filter((row) => /^__boundary_promise_(resolve|reject)$/.test(row.name))).toEqual([]);
    const imports = buildCompiledImports(actual!);
    const { instance } = await WebAssembly.instantiate(actual!.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.run as (value: unknown) => number)({})).toBe(7);
  });
});

describe("dynamic result early reservations obey the existing target policy", () => {
  it("records unused early notifications but removes them from a scalar-only final binary", async () => {
    const requests: string[] = [];
    const original = lateImports.ensureLateImport;
    const spy = vi.spyOn(lateImports, "ensureLateImport").mockImplementation((...args) => {
      requests.push(args[1]);
      return original(...args);
    });
    let actual: CompileResult;
    try {
      actual = await compile("export function run(): any { return 7; }", {
        fileName: "unused-promise-reservations.ts",
        target: "gc",
        optimize: false,
      });
    } finally {
      spy.mockRestore();
    }
    expect(actual!.success, JSON.stringify(actual!.errors)).toBe(true);
    expect(requests).toContain("__boundary_promise_resolve");
    expect(requests).toContain("__boundary_promise_reject");
    expect(WebAssembly.validate(actual!.binary)).toBe(true);
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(actual!.binary)).filter((row) =>
        /^__boundary_promise_(resolve|reject)$/.test(row.name),
      ),
    ).toEqual([]);
    const imports = buildCompiledImports(actual!);
    const { instance } = await WebAssembly.instantiate(actual!.binary, imports);
    imports.setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: actual!.exportSignatures });
    expect(exports.run()).toBe(7);
  });

  for (const [label, options] of [
    ["standalone", { target: "standalone" }],
    ["WASI", { target: "wasi" }],
    ["strict no-host", { target: "gc", strictNoHostImports: true }],
    ["interop off", { target: "gc", hostBridge: "off" }],
  ] as const) {
    it("does not reserve host Promise notifications with " + label, async () => {
      const requests: string[] = [];
      const original = lateImports.ensureLateImport;
      const spy = vi.spyOn(lateImports, "ensureLateImport").mockImplementation((...args) => {
        requests.push(args[1]);
        return original(...args);
      });
      let actual: CompileResult;
      try {
        actual = await compile("export function run(): any { return 7; }", {
          fileName: "policy-dynamic-result.ts",
          optimize: false,
          ...options,
        });
      } finally {
        spy.mockRestore();
      }
      expect(actual!.success, JSON.stringify(actual!.errors)).toBe(true);
      expect(WebAssembly.validate(actual!.binary)).toBe(true);
      expect(requests.filter((name) => /^__boundary_promise_(resolve|reject)$/.test(name))).toEqual([]);
      expect(actual!.imports.filter((row) => /^__boundary_promise_(resolve|reject)$/.test(row.name))).toEqual([]);
      if (label !== "interop off") {
        expect(
          WebAssembly.Module.imports(new WebAssembly.Module(actual!.binary)).filter((row) => row.module === "env"),
        ).toEqual([]);
      }
    });
  }
});

describe("erased type exports do not claim the numeric runtime namespace", () => {
  for (const typeExport of [
    "type Marker = number; export type { Marker as __box_number };",
    "type Marker = number; export { type Marker as __box_number };",
  ] as const) {
    it("preserves a timer with erased " + typeExport, async () => {
      const actual = await compile(typeExport + TIMER_SOURCE, {
        fileName: "erased-type-numeric-export.ts",
        optimize: false,
      });
      expect(actual.success, JSON.stringify(actual.errors)).toBe(true);
      expect(WebAssembly.validate(actual.binary)).toBe(true);
      let clearCalls = 0;
      const imports = buildCompiledImports(actual, {
        setTimeout(_callback: () => void, delay: number) {
          expect(delay).toBe(1.5);
          return 91;
        },
        clearTimeout(value: unknown) {
          expect(value).toBe(91);
          clearCalls++;
        },
      });
      const { instance } = await WebAssembly.instantiate(actual.binary, imports);
      imports.setInstance?.(instance);
      imports.setExports?.(instance.exports as Record<string, Function>);
      expect((instance.exports.run as () => number)()).toBe(91);
      expect(clearCalls).toBe(1);
    });
  }
});
