// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import type { Instr } from "../src/wasm/model/instructions.js";
import { buildCreateListFromArrayLikeDefinition } from "../src/runtime/wasmgc/values/create-list-from-array-like-body.js";
import { buildFunctionPrototypeInvokerDefinition } from "../src/runtime/wasmgc/values/function-prototype-invoker-bodies.js";
import { functionPrototypeBodyRuntime } from "./helpers/ir-function-prototype-body-controls.js";

function thrown(run: () => unknown): unknown {
  let caught: unknown,
    didThrow = false;
  try {
    run();
  } catch (error) {
    didThrow = true;
    caught = error;
  }
  expect(didThrow).toBe(true);
  return caught;
}
function flatten(body: readonly Instr[]): Instr[] {
  return body.flatMap((instruction) => [
    instruction,
    ...("body" in instruction ? flatten(instruction.body) : []),
    ...("then" in instruction ? flatten(instruction.then) : []),
    ...("else" in instruction && instruction.else ? flatten(instruction.else) : []),
  ]);
}
const sizes = [0, 1, 7, 8, 9, 17, 257];
const thisValues = [undefined, null, false, 0, -0, "receiver", Symbol("receiver"), { receiver: true }];
const invalidKeys = [1, null, undefined, false, 1n, {}, new String("wrapped")];
const lengthCases = [
  { name: "negative", value: -3, count: 0 },
  { name: "fraction", value: 2.9, count: 2 },
  { name: "NaN", value: NaN, count: 0 },
  { name: "negative infinity", value: -Infinity, count: 0 },
  { name: "string", value: "3.8", count: 3 },
  { name: "coercible object", value: { valueOf: () => 2 }, count: 2 },
];

for (const displaced of [false, true]) {
  const runtime = functionPrototypeBodyRuntime(displaced);
  describe(`actual Wasm call/apply/list components, displaced=${displaced}, semantic observer imports`, () => {
    it("pins nonempty case and actual resource populations, issued vector ABI and exact canonical bodies", () => {
      expect(sizes).toHaveLength(7);
      expect(thisValues).toHaveLength(8);
      expect(invalidKeys).toHaveLength(7);
      expect(lengthCases).toHaveLength(6);
      expect(runtime.census.completedFunctions).toBe(runtime.census.functions);
      expect(runtime.census.functions).toBe(14);
      expect(runtime.census.imports).toBeGreaterThanOrEqual(15);
      expect(runtime.census.types).toBeGreaterThan(10);
      expect(runtime.census.exports).toBe(10);
      expect(runtime.binary.byteLength).toBeGreaterThan(300);
      expect(runtime.pack.layout).toEqual({
        objVecTypeIdx: runtime.pack.carrier.typeIndex,
        objVecArrTypeIdx: runtime.pack.array.typeIndex,
      });
      for (const [name, definition] of Object.entries(runtime.definitions)) {
        const fn = runtime.module.functions.find(
          (fn) =>
            fn.name ===
            (
              {
                all: "$CreateListAll",
                "property-key": "$CreateListPropertyKey",
                call: "$FunctionCall",
                apply: "$FunctionApply",
              } as Record<string, string>
            )[name],
        )!;
        expect(fn).toBeDefined();
        expect(fn.body).toEqual(definition.body);
        expect(fn.locals).toEqual(definition.locals);
      }
      for (const method of ["call", "apply"] as const) {
        expect(runtime.definitions[method].body.at(-1)).toEqual({
          op: "return_call",
          funcIdx: runtime.invokerBindings.genericCall,
        });
        expect(
          runtime.module.types[
            runtime.module.functions.find((fn) => fn.name === (method === "call" ? "$FunctionCall" : "$FunctionApply"))!
              .typeIdx
          ],
        ).toMatchObject({
          params: [{ kind: "externref" }, { kind: "ref", typeIdx: runtime.pack.carrier.typeIndex }],
          results: [{ kind: "externref" }],
        });
      }
      const ops = flatten(runtime.definitions.all.body);
      expect(ops.some((instruction) => /trunc|convert_i32/.test(instruction.op))).toBe(false);
      expect(ops.filter((instruction) => instruction.op === "f64.ge")).toHaveLength(1);
      expect(ops.filter((instruction) => instruction.op === "f64.add")).toHaveLength(1);
      expect(
        ops.filter((instruction) => instruction.op === "call" && instruction.funcIdx === runtime.listBindings.toLength),
      ).toHaveLength(1);
      const indexAt = ops.findIndex(
        (instruction) => instruction.op === "call" && instruction.funcIdx === runtime.listBindings.indexToString,
      );
      expect(ops[indexAt - 1]).toEqual({ op: "local.get", index: 2 });
      expect(runtime.definitions.all.locals[1]!.type).toEqual({ kind: "f64" });
      const r = runtime.instantiate();
      expect(runtime.tagIndex).toBe(displaced ? 2 : 0);
      expect(r.exports.exception).toBeInstanceOf(WebAssembly.Tag);
      expect(r.exports.length(r.vector([]))).toBe(0);
    });

    for (const size of sizes) {
      it(`call consumes only thisArg and copies every remaining actual vector value, incoming=${size}`, () => {
        const r = runtime.instantiate();
        const values = Array.from({ length: size }, (_, index) => ({ index }));
        const input = r.vector(values);
        const target = function (this: unknown, ...args: unknown[]) {
          return { receiver: this, args };
        };
        const result = r.exports.call(target, input);
        expect(result).toEqual({ receiver: values[0], args: values.slice(1) });
        expect(r.records).toHaveLength(1);
        expect(r.records[0]!.target).toBe(target);
        expect(r.records[0]!.thisArg).toBe(values[0]);
        expect(r.records[0]!.args).toEqual(values.slice(1));
        r.records[0]!.args.forEach((value, index) => expect(value).toBe(values[index + 1]));
        expect(r.read(input)).toEqual(values);
      });
      it(`apply materializes every element across real vector growth, outgoing=${size}`, () => {
        const r = runtime.instantiate();
        const values = Array.from({ length: size }, (_, index) => (index === 3 ? undefined : { index }));
        const receiver = { receiver: size };
        const input = r.vector([receiver, values, "ignored"]);
        const target = function (this: unknown, ...args: unknown[]) {
          return { receiver: this, args };
        };
        expect(r.exports.apply(target, input)).toEqual({ receiver, args: values });
        expect(r.records[0]).toEqual({ target, thisArg: receiver, args: values });
        r.records[0]!.args.forEach((value, index) => expect(value).toBe(values[index]));
        expect(r.read(input)).toEqual([receiver, values, "ignored"]);
        expect(r.trace.filter((x) => x === "get:length")).toHaveLength(1);
      });
      it(`apply ignores all excess incoming positions, incoming=${size}`, () => {
        const r = runtime.instantiate();
        const receiver = {};
        const values =
          size === 0
            ? []
            : size === 1
              ? [receiver]
              : [
                  receiver,
                  { 0: "first", length: 1 },
                  ...Array(size - 2).fill({
                    get length() {
                      throw Error("ignored");
                    },
                  }),
                ];
        const input = r.vector(values);
        const target = (...args: unknown[]) => args;
        expect(r.exports.apply(target, input)).toEqual(size < 2 ? [] : ["first"]);
        expect(r.records[0]!.thisArg).toBe(values[0]);
        expect(r.read(input)).toEqual(values);
      });
    }
    for (const receiver of thisValues)
      for (const method of ["call", "apply"] as const)
        it(`${method} forwards unchanged this value ${typeof receiver}/${String(receiver)}`, () => {
          const r = runtime.instantiate();
          const input = r.vector(method === "call" ? [receiver, "a", undefined] : [receiver, ["a", undefined]]);
          const target = function (this: unknown, ...args: unknown[]) {
            return { receiver: this, args };
          };
          const result = r.exports[method](target, input) as { receiver: unknown; args: unknown[] };
          expect(Object.is(result.receiver, receiver)).toBe(true);
          expect(Object.is(r.records[0]!.thisArg, receiver)).toBe(true);
          expect(result.args).toEqual(["a", undefined]);
        });
    for (const incoming of [[], [undefined], [null], [undefined, undefined], [null, null], [false, undefined]])
      it(`apply nullish/missing argArray forwards an empty list, input length=${incoming.length}/${String(incoming[0])}`, () => {
        const r = runtime.instantiate();
        const target = (...args: unknown[]) => args;
        expect(r.exports.apply(target, r.vector(incoming))).toEqual([]);
        expect(r.records[0]!.thisArg).toBe(incoming[0]);
        expect(r.trace.some((x) => x.startsWith("get:"))).toBe(false);
      });

    for (const method of ["call", "apply"] as const) {
      it(`${method} checks target before hostile array-like observations`, () => {
        const r = runtime.instantiate();
        let hits = 0;
        const hostile = {
          get length() {
            hits++;
            throw Error("length");
          },
          get 0() {
            hits++;
            throw Error("index");
          },
          get [Symbol.iterator]() {
            hits++;
            throw Error("iterator");
          },
        };
        const error = thrown(() => r.exports[method](42, r.vector([undefined, hostile])));
        expect(error).toBeInstanceOf(WebAssembly.Exception);
        const exception = error as WebAssembly.Exception;
        expect(exception.is(r.exports.exception)).toBe(true);
        expect(exception.getArg(r.exports.exception, 0)).toBeInstanceOf(TypeError);
        expect(hits).toBe(0);
        expect(r.trace).toEqual(["isCallable", "typeError"]);
        expect(r.records).toEqual([]);
      });
      it(`${method} never observes target name/length/prototype`, () => {
        const r = runtime.instantiate();
        let hits = 0;
        const ordinary = function (this: unknown, ...args: unknown[]) {
          return args;
        };
        const target = new Proxy(ordinary, {
          get() {
            hits++;
            throw Error("poisoned target property");
          },
        });
        expect(r.exports[method](target, r.vector(method === "call" ? [null, 1, 2] : [null, [1, 2]]))).toEqual([1, 2]);
        expect(hits).toBe(0);
      });
    }
    it("generic Get preserves inherited getters, holes, proxy order and exact receiver; never HasProperty/iterator", () => {
      const r = runtime.instantiate();
      const gets: PropertyKey[] = [];
      let getterThis: unknown;
      const base = {
        get 1() {
          getterThis = this;
          return "inherited";
        },
      };
      const object = Object.assign(Object.create(base), { length: 4, 0: "own", 3: "last" });
      const proxy = new Proxy(object, {
        get(target, key, receiver) {
          gets.push(key);
          if (key === Symbol.iterator) throw Error("iterator");
          return Reflect.get(target, key, receiver);
        },
        has() {
          throw Error("HasProperty");
        },
        ownKeys() {
          throw Error("enumeration");
        },
      });
      expect(r.read(r.exports.all(proxy))).toEqual(["own", "inherited", undefined, "last"]);
      expect(getterThis).toBe(proxy);
      expect(gets).toEqual(["length", "0", "1", "2", "3"]);
    });
    it("reads length once and sees index getters mutate/delete later indices", () => {
      const r = runtime.instantiate();
      let lengthHits = 0;
      const object: any = { 1: "old", 2: "removed" };
      Object.defineProperties(object, {
        length: {
          get() {
            lengthHits++;
            return 3;
          },
        },
        0: {
          get() {
            object[1] = "new";
            expect(Reflect.deleteProperty(object, "2")).toBe(true);
            return "first";
          },
        },
      });
      expect(r.read(r.exports.all(object))).toEqual(["first", "new", undefined]);
      expect(lengthHits).toBe(1);
      expect(Object.hasOwn(object, "2")).toBe(false);
    });
    it("handles actual String wrappers and callable array-likes through generic Get", () => {
      const r = runtime.instantiate();
      expect(r.read(r.exports.all(new String("abc")))).toEqual(["a", "b", "c"]);
      const object = Object.assign((_a: unknown, _b: unknown) => {}, { 0: "x", 1: "y" });
      expect(r.read(r.exports.all(object))).toEqual(["x", "y"]);
    });
    for (const primitive of [undefined, null, "abc", 3, true, Symbol("x"), 1n])
      it(`direct CreateList rejects primitive ${typeof primitive} before Get`, () => {
        const r = runtime.instantiate();
        const error = thrown(() => r.exports.all(primitive)) as WebAssembly.Exception;
        expect(error.is(r.exports.exception)).toBe(true);
        expect(error.getArg(r.exports.exception, 0)).toBeInstanceOf(TypeError);
        expect(r.trace).toEqual(["isObject", "typeError"]);
      });
    for (const row of lengthCases)
      it(`full ToLength observer conversion: ${row.name}`, () => {
        const r = runtime.instantiate();
        const object = { length: row.value, 0: "a", 1: "b", 2: "c" };
        expect(r.read(r.exports.all(object))).toEqual(["a", "b", "c"].slice(0, row.count));
        expect(r.trace.filter((x) => x === "toLength")).toHaveLength(1);
      });
    for (const length of [Symbol("length"), 1n])
      it(`ToLength rejects ${typeof length} through actual numeric coercion`, () => {
        const r = runtime.instantiate();
        expect(thrown(() => r.exports.all({ length }))).toBeInstanceOf(TypeError);
        expect(r.trace).toEqual(["isObject", "get:length", "toLength"]);
      });
    for (const length of [Infinity, 2 ** 32, 2 ** 53 - 1])
      it(`retains f64 length ${String(length)} and reaches the first abrupt indexed Get`, () => {
        const r = runtime.instantiate();
        const marker = {};
        const object = {
          length,
          get 0() {
            throw marker;
          },
        };
        expect(thrown(() => r.exports.all(object))).toBe(marker);
        expect(r.trace).toEqual(["isObject", "get:length", "toLength", "index:0", "get:0"]);
      });
    it("passes a raw f64 high index to the explicit index String observer contract", () => {
      const importRow = runtime.module.imports.find(
        (row) => row.module === "observer" && row.name === "indexToString",
      )!;
      expect(importRow.desc.kind).toBe("func");
      if (importRow.desc.kind !== "func") throw Error("wrong index observer import");
      expect(runtime.module.types[importRow.desc.typeIdx]).toMatchObject({
        params: [{ kind: "f64" }],
        results: [{ kind: "externref" }],
      });
      // This is dependency-contract coverage only, not execution of billions of list iterations.
      const seen: number[] = [];
      const r = runtime.instantiate({
        indexToString(index: number) {
          seen.push(index);
          return String(index);
        },
      });
      expect(r.exports.index(2 ** 32)).toBe("4294967296");
      expect(r.exports.index(2 ** 53 - 1)).toBe("9007199254740991");
      expect(seen).toEqual([2 ** 32, 2 ** 53 - 1]);
    });

    it("property-key mode accepts actual strings and symbols without coercion", () => {
      const r = runtime.instantiate();
      const symbol = Symbol("key");
      const values = ["a", symbol, ""];
      const result = r.read(r.exports["property-key"]({ 0: values[0], 1: symbol, 2: "", length: 3 }));
      expect(result).toEqual(values);
      expect(result[1]).toBe(symbol);
      expect(r.trace.filter((x) => x === "isPropertyKey")).toHaveLength(3);
    });
    for (const invalid of invalidKeys)
      it(`property-key mode refuses first invalid ${typeof invalid} while all mode retains it unchanged`, () => {
        const r = runtime.instantiate();
        let later = 0,
          coerced = 0;
        if (invalid !== null && typeof invalid === "object")
          Object.defineProperty(invalid, Symbol.toPrimitive, {
            configurable: true,
            value() {
              coerced++;
              throw Error("coercion");
            },
          });
        const object = {
          length: 3,
          0: "valid",
          1: invalid,
          get 2() {
            later++;
            return "later";
          },
        };
        const error = thrown(() => r.exports["property-key"](object)) as WebAssembly.Exception;
        expect(error.is(r.exports.exception)).toBe(true);
        expect(error.getArg(r.exports.exception, 0)).toBeInstanceOf(TypeError);
        expect(later).toBe(0);
        expect(coerced).toBe(0);
        expect(r.records).toEqual([]);
        const ops = flatten(runtime.definitions["property-key"].body);
        const predicate = ops.findIndex((x) => x.op === "call" && x.funcIdx === runtime.listBindings.isPropertyKey);
        const push = ops.findIndex((x) => x.op === "call" && x.funcIdx === runtime.listBindings.push);
        expect(predicate).toBeGreaterThan(0);
        expect(push).toBeGreaterThan(predicate);
        const result = r.read(r.exports.all(object));
        expect(result[1]).toBe(invalid);
        // Deep equality can coerce a String wrapper in the assertion instrument.
        // Check every element directly so only the emitted algorithm is observed.
        expect(result).toHaveLength(3);
        expect(result[0]).toBe("valid");
        expect(result[2]).toBe("later");
        expect(coerced).toBe(0);
      });

    for (const stage of ["length Get", "ToLength", "indexed Get", "target Call"] as const)
      for (const tagged of [false, true])
        it(`preserves actual abrupt identity at ${stage}, exact Wasm tag=${tagged}`, () => {
          const r = runtime.instantiate();
          const payload = { stage };
          const marker = tagged ? new WebAssembly.Exception(r.exports.exception, [payload]) : payload;
          const object =
            stage === "length Get"
              ? {
                  get length() {
                    throw marker;
                  },
                }
              : stage === "ToLength"
                ? {
                    length: {
                      [Symbol.toPrimitive]() {
                        throw marker;
                      },
                    },
                  }
                : stage === "indexed Get"
                  ? {
                      length: 1,
                      get 0() {
                        throw marker;
                      },
                    }
                  : [1];
          const target =
            stage === "target Call"
              ? () => {
                  throw marker;
                }
              : (...args: unknown[]) => args;
          const actual = thrown(() => r.exports.apply(target, r.vector([null, object])));
          expect(actual).toBe(marker);
          if (tagged) {
            expect((actual as WebAssembly.Exception).is(r.exports.exception)).toBe(true);
            expect((actual as WebAssembly.Exception).getArg(r.exports.exception, 0)).toBe(payload);
          }
          expect(r.records).toHaveLength(stage === "target Call" ? 1 : 0);
          expect(r.frames).toEqual([]);
        });

    for (const family of ["ordinary", "arrow", "bound", "proxy", "cross-realm"] as const)
      it(`executes ${family} targets through the explicit semantic Call observer`, () => {
        const r = runtime.instantiate();
        const receiver = {},
          boundThis = {};
        const ordinary = function (this: unknown, ...args: unknown[]) {
          return { receiver: this, args };
        };
        const target =
          family === "ordinary"
            ? ordinary
            : family === "arrow"
              ? (...args: unknown[]) => ({ receiver: "lexical", args })
              : family === "bound"
                ? ordinary.bind(boundThis, "bound")
                : family === "proxy"
                  ? new Proxy(ordinary, {
                      apply(target, thisArg, args) {
                        return Reflect.apply(target, thisArg, ["proxy", ...args]);
                      },
                    })
                  : runInNewContext("(function(...args){return {receiver:this,args}})");
        const result = r.exports.apply(target, r.vector([receiver, ["x", "y"]])) as {
          receiver: unknown;
          args: unknown[];
        };
        expect(result.receiver).toBe(family === "arrow" ? "lexical" : family === "bound" ? boundThis : receiver);
        expect(result.args).toEqual(
          family === "bound" ? ["bound", "x", "y"] : family === "proxy" ? ["proxy", "x", "y"] : ["x", "y"],
        );
        expect(r.records[0]!.target).toBe(target);
        expect(r.records[0]!.thisArg).toBe(receiver);
      });
    it("nested call/apply in getters and targets preserve outer vector and observer frames", () => {
      const r = runtime.instantiate();
      const receiver = {},
        nestedReceiver = {},
        events: string[] = [];
      const nested = function (this: unknown, ...args: unknown[]) {
        events.push("nested");
        expect(this).toBe(nestedReceiver);
        return args;
      };
      const list = {
        length: 2,
        get 0() {
          expect(r.exports.call(nested, r.vector([nestedReceiver, "getter"]))).toEqual(["getter"]);
          return "outer0";
        },
        1: "outer1",
      };
      const target = function (this: unknown, ...args: unknown[]) {
        expect(this).toBe(receiver);
        expect(r.frames).toEqual([]);
        expect(r.exports.apply(nested, r.vector([nestedReceiver, ["target"]]))).toEqual(["target"]);
        return args;
      };
      const input = r.vector([receiver, list]);
      expect(r.exports.apply(target, input)).toEqual(["outer0", "outer1"]);
      expect(events).toEqual(["nested", "nested"]);
      expect(r.records).toHaveLength(3);
      expect(r.records[1]).toEqual({ target, thisArg: receiver, args: ["outer0", "outer1"] });
      expect(r.read(input)).toEqual([receiver, list]);
      expect(r.frames).toEqual([]);
    });
  });
}

describe("pure invoker builder configuration and fresh data", () => {
  const runtime = functionPrototypeBodyRuntime(false);
  const builders = [
    {
      name: "list",
      bindings: runtime.listBindings,
      build: (input: any) => buildCreateListFromArrayLikeDefinition(input),
    },
    {
      name: "call",
      bindings: runtime.invokerBindings,
      build: (input: any) => buildFunctionPrototypeInvokerDefinition("call", input),
    },
    {
      name: "apply",
      bindings: runtime.invokerBindings,
      build: (input: any) => buildFunctionPrototypeInvokerDefinition("apply", input),
    },
  ];
  for (const builder of builders) {
    for (const value of [undefined, -1, NaN, 0.5, Infinity, 2 ** 32])
      it(`${builder.name} rejects malformed coordinate ${String(value)}`, () => {
        expect(builder.build(builder.bindings).body.length).toBeGreaterThan(10);
        expect(() => builder.build({ ...builder.bindings, newVector: value })).toThrow("invalid coordinate newVector");
      });
    for (const role of builder.name === "list"
      ? [
          "vector",
          "isObject",
          "get",
          "toLength",
          "indexToString",
          "newVector",
          "push",
          "typeError",
          "exceptionTag",
          "lengthKey",
          "errorMessage",
          "isPropertyKey",
        ]
      : [
          "vector",
          "newVector",
          "push",
          "isCallable",
          "isUndefined",
          "isNull",
          "undefinedValue",
          "createListFromArrayLike",
          "genericCall",
          "typeError",
          "exceptionTag",
          "errorMessage",
        ])
      it(`${builder.name} refuses own accessor-backed role ${role} with zero accessor hits`, () => {
        expect(builder.build(builder.bindings).body.length).toBeGreaterThan(10);
        let hits = 0;
        const input = { ...builder.bindings };
        Object.defineProperty(input, role, {
          get() {
            hits++;
            return (builder.bindings as any)[role];
          },
        });
        expect(() => builder.build(input)).toThrow("missing/non-data binding " + role);
        expect(hits).toBe(0);
      });
    it(`${builder.name} rejects inherited/missing roles and malformed nested vector coordinates`, () => {
      expect(() => builder.build(Object.create(builder.bindings))).toThrow("missing/non-data binding");
      const missing = { ...builder.bindings };
      expect(Reflect.deleteProperty(missing, "newVector")).toBe(true);
      expect(Object.hasOwn(missing, "newVector")).toBe(false);
      expect(() => builder.build(missing)).toThrow("missing/non-data binding newVector");
      for (const value of [undefined, -1, NaN, 0.5, 2 ** 32])
        expect(() =>
          builder.build({ ...builder.bindings, vector: { ...builder.bindings.vector, objVecTypeIdx: value } }),
        ).toThrow("invalid coordinate objVecTypeIdx");
      let hits = 0;
      const vector = { ...builder.bindings.vector };
      Object.defineProperty(vector, "objVecArrTypeIdx", {
        get() {
          hits++;
          return 0;
        },
      });
      expect(() => builder.build({ ...builder.bindings, vector })).toThrow("missing/non-data binding objVecArrTypeIdx");
      expect(hits).toBe(0);
    });
    it(`${builder.name} validates nested operand accessors without invoking them and isolates returned trees`, () => {
      const message: Instr[] = [{ op: "if", blockType: { kind: "empty" }, then: [{ op: "call", funcIdx: 1 }] }];
      let hits = 0;
      const nested = { op: "call" };
      Object.defineProperty(nested, "funcIdx", {
        get() {
          hits++;
          return 1;
        },
      });
      const invalid = [{ op: "if", blockType: { kind: "empty" }, then: [nested] }];
      expect(() => builder.build({ ...builder.bindings, errorMessage: invalid })).toThrow(
        "non-data operand field errorMessage",
      );
      expect(hits).toBe(0);
      const a = builder.build({ ...builder.bindings, errorMessage: message });
      const b = builder.build({ ...builder.bindings, errorMessage: message });
      const saved = structuredClone(b);
      (message[0] as any).then[0].funcIdx = 99;
      (a.body[0] as any).index = 99;
      (a.locals[0]!.type as any).kind = "i64";
      expect(b).toEqual(saved);
      const cyclic: any[] = [];
      cyclic.push({ op: "if", then: cyclic });
      expect(() => builder.build({ ...builder.bindings, errorMessage: cyclic })).toThrow(
        "invalid operand data errorMessage",
      );
      expect(() => builder.build({ ...builder.bindings, errorMessage: [] })).toThrow("missing operand errorMessage");
    });
  }
  it("refuses unknown modes/methods and requires property-key predicate without observing it in all mode", () => {
    expect(() => buildCreateListFromArrayLikeDefinition(runtime.listBindings, "bad" as any)).toThrow("unknown mode");
    expect(() => buildFunctionPrototypeInvokerDefinition("bad" as any, runtime.invokerBindings)).toThrow(
      "unknown method",
    );
    const { isPropertyKey: _removed, ...missing } = runtime.listBindings;
    expect(() => buildCreateListFromArrayLikeDefinition(missing, "property-key")).toThrow(
      "missing/non-data binding isPropertyKey",
    );
    expect(buildCreateListFromArrayLikeDefinition(missing).body).toEqual(runtime.definitions.all.body);
    expect(() => buildCreateListFromArrayLikeDefinition({ ...runtime.listBindings, isPropertyKey: undefined })).toThrow(
      "invalid coordinate isPropertyKey",
    );
    expect(
      flatten(runtime.definitions.all.body).some(
        (x) => x.op === "call" && x.funcIdx === runtime.listBindings.isPropertyKey,
      ),
    ).toBe(false);
  });
});
