// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";
import { createBoundaryObjectAdapter } from "../src/runtime/boundary-object-adapter.js";

const source = `
  export function names(value:any):any { return Object.getOwnPropertyNames(value); }
  export function symbols(value:any):any { return Object.getOwnPropertySymbols(value); }
  export function all(value:any):any { return Reflect.ownKeys(value); }
  export function enumerable(value:any):any { return Object.keys(value); }
`;
async function instantiate() {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return {
    result,
    exports: wrapCompiledExports(result, instance) as Record<string, (value: unknown) => ArrayLike<unknown>>,
  };
}

describe("#6979 native own-key filtering over one JS boundary primitive", () => {
  it("does not import separate name and symbol filtering providers", async () => {
    const { result } = await instantiate();
    const names = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => i.name);
    expect(names).toContain("__boundary_object_own_keys");
    expect(names).not.toContain("__boundary_object_get_own_property_names");
    expect(names).not.toContain("__boundary_object_get_own_property_symbols");
  });

  it("preserves string ordering, non-enumerable names and exact symbol identity", async () => {
    const { exports } = await instantiate();
    const first = Symbol("first"),
      second = Symbol.for("boundary-key-filter");
    const prototype = { inherited: 1 };
    const obj = Object.create(prototype, { hidden: { value: 1 }, z: { value: 2, enumerable: true } });
    obj[second] = 4;
    obj[9] = 9;
    obj[2] = 2;
    obj.a = 3;
    obj[first] = 5;
    expect(Array.from(exports.names!(obj))).toEqual(Object.getOwnPropertyNames(obj));
    const symbols = Array.from(exports.symbols!(obj));
    expect(symbols).toEqual([second, first]);
    expect(symbols[0]).toBe(second);
    expect(symbols[1]).toBe(first);
    expect(Array.from(exports.all!(obj))).toEqual(Reflect.ownKeys(obj));
    expect(Array.from(exports.enumerable!(obj))).toEqual(Object.keys(obj));
  });

  it("does exactly one ownKeys call, with no descriptor/get/prototype traps", async () => {
    const { exports } = await instantiate();
    const symbol = Symbol("probe"),
      token = {};
    const log: string[] = [];
    const target = { visible: 1, [symbol]: 2 };
    const proxy = new Proxy(target, {
      ownKeys() {
        log.push("ownKeys");
        return [symbol, "visible"];
      },
      getOwnPropertyDescriptor() {
        log.push("descriptor");
        throw token;
      },
      get() {
        log.push("get");
        throw token;
      },
      getPrototypeOf() {
        log.push("prototype");
        throw token;
      },
    });
    expect(Array.from(exports.names!(proxy))).toEqual(["visible"]);
    expect(log).toEqual(["ownKeys"]);
    log.length = 0;
    const symbols = Array.from(exports.symbols!(proxy));
    expect(symbols[0]).toBe(symbol);
    expect(log).toEqual(["ownKeys"]);
    log.length = 0;
    let thrown: unknown;
    try {
      exports.enumerable!(proxy);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(token);
    expect(log).toEqual(["ownKeys", "descriptor"]);
  });

  it("handles empty lists and mixed lists larger than the native vector's initial capacity", async () => {
    const { exports } = await instantiate();
    expect(Array.from(exports.names!({}))).toEqual([]);
    expect(Array.from(exports.symbols!({}))).toEqual([]);
    const obj: Record<PropertyKey, unknown> = {};
    const symbols: symbol[] = [];
    for (let index = 0; index < 24; index++) {
      obj[`key${index}`] = index;
      const symbol = Symbol(`symbol${index}`);
      symbols.push(symbol);
      obj[symbol] = index;
    }
    expect(Array.from(exports.names!(obj))).toEqual(Object.getOwnPropertyNames(obj));
    const observed = Array.from(exports.symbols!(obj));
    expect(observed).toEqual(symbols);
    observed.forEach((symbol, index) => expect(symbol).toBe(symbols[index]));
  });

  it("propagates original ownKeys exceptions and rejects invalid or revoked proxies", async () => {
    const { exports } = await instantiate();
    const token = {};
    const throwing = new Proxy(
      {},
      {
        ownKeys() {
          throw token;
        },
      },
    );
    const duplicate = new Proxy(
      {},
      {
        ownKeys() {
          return ["x", "x"];
        },
      },
    );
    const invalid = new Proxy(
      {},
      {
        ownKeys() {
          return [42] as unknown as string[];
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const name of ["names", "symbols"]) {
      let thrown: unknown;
      try {
        exports[name]!(throwing);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(token);
      expect(() => exports[name]!(duplicate)).toThrow(TypeError);
      expect(() => exports[name]!(invalid)).toThrow(TypeError);
      expect(() => exports[name]!(revoked.proxy)).toThrow(TypeError);
    }
  });

  it("keeps the boundary primitive admission-gated", () => {
    const token = {};
    let conversions = 0;
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw token;
        },
      },
    );
    const primitive = createBoundaryObjectAdapter("ownKeys", {
      getExports: () => ({}),
      isAdmitted: () => false,
      toPropertyKey: () => {
        throw token;
      },
      toHostValue: () => {
        throw token;
      },
      fromHostValue: () => {
        throw token;
      },
      toNativeVector: () => {
        conversions++;
        throw token;
      },
      readArguments: () => {
        throw token;
      },
      toAccessor: () => {
        throw token;
      },
    });
    expect(primitive(proxy)).toBeNull();
    expect(conversions).toBe(0);
  });

  it("does not consult a replaced ambient Reflect.ownKeys implementation", async () => {
    const { exports } = await instantiate();
    const symbol = Symbol("ambient-isolation");
    const obj = { a: 1, [symbol]: 2 };
    const original = Reflect.ownKeys;
    const token = {};
    let names: unknown[] = [],
      symbols: unknown[] = [],
      all: unknown[] = [];
    let ambientCalls = 0;
    let caught: unknown;
    try {
      Reflect.ownKeys = () => {
        ambientCalls++;
        throw token;
      };
      names = Array.from(exports.names!(obj));
      symbols = Array.from(exports.symbols!(obj));
      all = Array.from(exports.all!(obj));
    } catch (error) {
      caught = error;
    } finally {
      Reflect.ownKeys = original;
    }
    expect(ambientCalls).toBe(0);
    expect(caught).toBeUndefined();
    expect(names).toEqual(["a"]);
    expect(symbols).toEqual([symbol]);
    expect(all).toEqual(["a", symbol]);
  });
});
