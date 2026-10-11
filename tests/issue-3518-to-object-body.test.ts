// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { buildToObjectDefinition, type ToObjectBindings } from "../src/runtime/wasmgc/values/to-object-body.js";

// Actual Wasm owns ToObject control flow. Imported semantic controls deliberately
// do not certify native wrapper/prototype/String-exotic provider completion.
const brands = ["Boolean", "Number", "String", "Symbol", "BigInt"] as const;
const predicates = ["isUndefined", "isNull", ...brands.map((brand) => "is" + brand)] as const;
const factories = ["booleanCreate", "numberCreate", "stringCreate", "symbolCreate", "bigintCreate"] as const;
const functionKeys = [...predicates, ...factories, "typeError"];
const nativeObject = Object;
const message = "Cannot convert undefined or null to object";
function runtime(offset: boolean) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const ext: ValType = { kind: "externref" },
    i32: ValType = { kind: "i32" };
  if (offset) tx.reserveTag("prefix:tag", { params: [], results: [] }, { kind: "defined", name: "prefix" });
  const prefix = offset
    ? tx.reserveFunctionImport("prefix:fn", "control", "prefix", { params: [], results: [] })
    : undefined;
  const functions = Object.fromEntries(
    functionKeys.map((key) => [
      key,
      tx.reserveFunctionImport("control:" + key, "control", key, {
        params: [ext],
        results: [key.startsWith("is") ? i32 : ext],
      }),
    ]),
  );
  const literal = tx.reserveFunctionImport("literal", "control", "literal", { params: [], results: [ext] });
  const exception = tx.reserveTag("exception", { params: [ext], results: [] }, { kind: "defined", name: "exception" });
  const run = tx.reserveFunction("run", "run", { params: [ext], results: [ext] });
  tx.freezeReservations();
  const bindings = {
    ...Object.fromEntries(functionKeys.map((key) => [key, functions[key]!.handle])),
    exceptionTag: tx.physicalIndex(exception),
    errorMessage: [{ op: "call", funcIdx: literal.handle }],
  } as unknown as ToObjectBindings;
  tx.fillFunction(run, buildToObjectDefinition(bindings));
  tx.defineExport("export:run", "run", run);
  tx.defineExport("export:exception", "exception", exception);
  tx.seal();
  const trace: string[] = [],
    allocations: { brand: string; value: unknown; wrapper: object }[] = [],
    errors: TypeError[] = [];
  const failures = new Map<string, unknown>();
  const visit = (name: string) => {
    trace.push(name);
    if (failures.has(name)) throw failures.get(name);
  };
  const controls: Record<string, (...args: any[]) => any> = {
    ...(prefix ? { prefix: () => {} } : {}),
    isUndefined: (value: unknown) => {
      visit("isUndefined");
      return Number(value === undefined);
    },
    isNull: (value: unknown) => {
      visit("isNull");
      return Number(value === null);
    },
    literal: () => {
      visit("literal");
      return message;
    },
    typeError: (text: string) => {
      visit("typeError");
      const error = new TypeError(text);
      errors.push(error);
      return error;
    },
  };
  brands.forEach((brand, index) => {
    controls["is" + brand] = (value: unknown) => {
      visit("is" + brand);
      switch (brand) {
        case "Boolean":
          return Number(typeof value === "boolean");
        case "Number":
          return Number(typeof value === "number");
        case "String":
          return Number(typeof value === "string");
        case "Symbol":
          return Number(typeof value === "symbol");
        case "BigInt":
          return Number(typeof value === "bigint");
      }
    };
    controls[factories[index]!] = (value: unknown) => {
      visit(factories[index]!);
      const wrapper = nativeObject(value) as object;
      allocations.push({ brand, value, wrapper });
      return wrapper;
    };
  });
  const compiled = new WebAssembly.Module(emitBinary(module) as BufferSource);
  const api = new WebAssembly.Instance(compiled, { control: controls }).exports as unknown as {
    run(value: unknown): object;
    exception: WebAssembly.Tag;
  };
  return {
    ...api,
    trace,
    allocations,
    errors,
    failures,
    bindings,
    imports: WebAssembly.Module.imports(compiled),
    reset() {
      trace.length = 0;
      allocations.length = 0;
      errors.length = 0;
      failures.clear();
    },
  };
}
function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw Error("expected an abrupt completion");
}
const primitiveCases: [string, unknown][] = [
  ["Boolean", false],
  ["Boolean", true],
  ["Number", 0],
  ["Number", -0],
  ["Number", NaN],
  ["Number", Infinity],
  ["Number", -Infinity],
  ["Number", 42],
  ["String", ""],
  ["String", "a"],
  ["String", "\uD800"],
  ["String", "\uDC00"],
  ["String", "a😀z"],
  ["String", "é"],
  ["Symbol", Symbol("private")],
  ["Symbol", Symbol.iterator],
  ["BigInt", 0n],
  ["BigInt", -(1n << 200n)],
  ["BigInt", (1n << 1024n) + 1n],
];
const unbox: Record<string, (this: any) => unknown> = {
  Boolean: Boolean.prototype.valueOf,
  Number: Number.prototype.valueOf,
  String: String.prototype.valueOf,
  Symbol: Symbol.prototype.valueOf,
  BigInt: BigInt.prototype.valueOf,
};
const prototypes: Record<string, object> = {
  Boolean: Boolean.prototype,
  Number: Number.prototype,
  String: String.prototype,
  Symbol: Symbol.prototype,
  BigInt: BigInt.prototype,
};

describe.each([false, true])("complete ToObject body, shifted=%s", (offset) => {
  let r: ReturnType<typeof runtime>;
  beforeAll(() => {
    r = runtime(offset);
  });
  beforeEach(() => r.reset());
  it("declares its semantic-control imports and actual exception coordinate", () => {
    expect(r.imports.map((row) => row.name)).toEqual([...(offset ? ["prefix"] : []), ...functionKeys, "literal"]);
    expect(r.bindings.exceptionTag).toBe(offset ? 1 : 0);
  });
  it.each(primitiveCases)("allocates a fresh %s wrapper for %s", (brand, value) => {
    const first = r.run(value),
      second = r.run(value);
    expect(first).not.toBe(second);
    expect(Reflect.apply(unbox[brand]!, first, [])).toBe(value);
    expect(Reflect.apply(unbox[brand]!, second, [])).toBe(value);
    expect(Object.getPrototypeOf(first)).toBe(prototypes[brand]);
    expect(r.allocations).toEqual([
      { brand, value, wrapper: first },
      { brand, value, wrapper: second },
    ]);
    const position = brands.indexOf(brand as (typeof brands)[number]);
    const one = [
      "isUndefined",
      "isNull",
      ...brands.slice(0, position + 1).map((name) => "is" + name),
      factories[position],
    ];
    expect(r.trace).toEqual([...one, ...one]);
    if (brand === "String") {
      const oracle = nativeObject(value);
      expect(Reflect.ownKeys(first)).toEqual(Reflect.ownKeys(oracle));
      for (const key of Reflect.ownKeys(oracle))
        expect(Object.getOwnPropertyDescriptor(first, key)).toEqual(Object.getOwnPropertyDescriptor(oracle, key));
    }
  });
  it.each([undefined, null])("throws the exact tagged TypeError for %s before allocation", (value) => {
    const error = thrown(() => r.run(value));
    expect(error).toBeInstanceOf(WebAssembly.Exception);
    expect((error as WebAssembly.Exception).is(r.exception)).toBe(true);
    expect((error as WebAssembly.Exception).getArg(r.exception, 0)).toBe(r.errors[0]);
    expect(r.errors[0]).toBeInstanceOf(TypeError);
    expect(r.errors[0]!.message).toBe(message);
    expect(r.trace).toEqual(["isUndefined", ...(value === null ? ["isNull"] : []), "literal", "typeError"]);
    expect(r.allocations).toHaveLength(0);
  });
  it("preserves ordinary, callable, foreign-realm and wrapper identities without reading properties", () => {
    const trap = () => {
      throw Error("observable property operation");
    };
    const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    const revoked = Proxy.revocable(function callable() {}, {});
    revoked.revoke();
    const values = [
      {},
      [],
      function callable() {},
      class Constructor {},
      hostile,
      revoked.proxy,
      nativeObject(-0),
      nativeObject(Symbol()),
      runInNewContext("({ value: 1 })"),
    ];
    for (const value of values) {
      r.reset();
      expect(r.run(value)).toBe(value);
      expect(r.trace).toEqual(predicates);
      expect(r.allocations).toHaveLength(0);
    }
  });
  it("does not invoke ToPrimitive or any user conversion method", () => {
    let calls = 0;
    const object = {
      get valueOf() {
        calls++;
        throw 1;
      },
      get toString() {
        calls++;
        throw 2;
      },
      get [Symbol.toPrimitive]() {
        calls++;
        throw 3;
      },
    };
    expect(r.run(object)).toBe(object);
    expect(calls).toBe(0);
  });
  it.each(factories)("propagates %s factory failure unchanged", (factory) => {
    const index = factories.indexOf(factory),
      value = primitiveCases.find(([brand]) => brand === brands[index])![1];
    const error = new WebAssembly.Exception(r.exception, [{ reason: factory }]);
    r.failures.set(factory, error);
    expect(thrown(() => r.run(value))).toBe(error);
    expect(r.trace.at(-1)).toBe(factory);
    expect(r.allocations).toHaveLength(0);
  });
  it.each([
    "isUndefined",
    "isNull",
    "isBoolean",
    "isNumber",
    "isString",
    "isSymbol",
    "isBigInt",
    "literal",
    "typeError",
  ])("propagates abrupt %s without later work", (stage) => {
    const payload = { stage };
    r.failures.set(stage, payload);
    expect(thrown(() => r.run(stage === "literal" || stage === "typeError" ? null : {}))).toBe(payload);
    expect(r.trace.at(-1)).toBe(stage);
    expect(r.allocations).toHaveLength(0);
  });
});

describe("ToObject binding data", () => {
  const valid = (): ToObjectBindings =>
    ({
      ...Object.fromEntries(functionKeys.map((key, index) => [key, index])),
      exceptionTag: 0,
      errorMessage: [{ op: "call", funcIdx: 0 }],
    }) as unknown as ToObjectBindings;
  it.each([...functionKeys, "exceptionTag"])("rejects unresolved coordinate %s", (key) => {
    for (const value of [undefined, -1, 0.25, NaN, Infinity, 2 ** 32, "1"]) {
      const input = valid();
      Object.assign(input, { [key]: value });
      expect(() => buildToObjectDefinition(input)).toThrow(/coordinate/);
    }
  });
  it("rejects inherited and accessor bindings without reading them", () => {
    const input = valid();
    Reflect.deleteProperty(input, "isNull");
    Object.setPrototypeOf(input, { isNull: 1 });
    expect(() => buildToObjectDefinition(input)).toThrow(/non-data/);
    let reads = 0;
    Object.defineProperty(input, "isNull", {
      get() {
        reads++;
        return 1;
      },
    });
    expect(() => buildToObjectDefinition(input)).toThrow(/non-data/);
    expect(reads).toBe(0);
  });
  it.each([undefined, null, [], {}])("rejects missing error-message operand %s", (operand) => {
    const input = valid();
    Object.assign(input, { errorMessage: operand });
    expect(() => buildToObjectDefinition(input)).toThrow(/operand/);
  });
  it("captures scalar coordinates and deep-copies each error operand", () => {
    const input = valid(),
      result = buildToObjectDefinition(input),
      before = structuredClone(result);
    Object.assign(input, { isNull: 999 });
    (input.errorMessage as Instr[]).push({ op: "drop" });
    Object.assign(input.errorMessage[0]!, { op: "unreachable" });
    expect(result).toEqual(before);
  });
});
