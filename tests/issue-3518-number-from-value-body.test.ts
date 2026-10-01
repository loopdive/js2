// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  buildNumberFromValueDefinition,
  type NumberFromValueBindings,
} from "../src/runtime/wasmgc/values/number-from-value-body.js";
import {
  buildAnyValueType,
  buildUndefinedInitializer,
  buildBoxNumberType,
  buildBoxBooleanType,
} from "../src/runtime/wasmgc/values/primitive-layouts.js";
import {
  buildBoxNumberBody,
  buildBoxNumberLocals,
  buildUnboxNumberBody,
  buildUnboxNumberLocals,
} from "../src/runtime/wasmgc/values/number-bodies.js";
import {
  buildStringToNumberLocals,
  buildStringToNumberPrelude,
  buildStringToNumberResult,
} from "../src/runtime/wasmgc/values/string-number-bodies.js";
import {
  buildDecimalPowerArrayType,
  buildDecimalPowerArrayInitializer,
} from "../src/runtime/wasmgc/values/decimal-scale-bodies.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeSymbolCarrierResources,
  fillNativeSymbolCarrierResources,
} from "../src/backend/wasmgc/resources/native-symbol-carrier.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
} from "../src/backend/wasmgc/resources/native-bigint.js";
import {
  declareNativeBigIntNumberResources,
  reserveNativeBigIntNumberResources,
  fillNativeBigIntNumberResources,
  requireCompletedNativeBigIntNumber,
} from "../src/backend/wasmgc/resources/native-bigint-number.js";

const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" },
  f64: ValType = { kind: "f64" };
const errors = {
  nonCallableError: "@@toPrimitive is not callable",
  nonPrimitiveError: "Cannot convert object to primitive value",
  symbolError: "Cannot convert a Symbol value to a number",
} as const;
const stringValues = [
  "",
  "  ",
  "-0",
  " 42 ",
  "3.125",
  "1e3",
  "0x10",
  "0o10",
  "0b10",
  "Infinity",
  "-Infinity",
  "bad",
  "+0x10",
];
const texts = [...new Set(["number", "valueOf", "toString", ...Object.values(errors), ...stringValues])];
const bigints = [0n, -1n, (1n << 53n) + 1n, (1n << 96n) + 1n, -((1n << 200n) + 1n), 1n << 1024n];

/**
 * Controlled algorithm bindings, not public IR/provider acceptance. Get and call
 * imports execute real JS getters/methods; an explicit callable set describes this
 * fixture's methods (including call-time class refusals), never typeof-function.
 * Primitives use actual native layouts, native StringToNumber and the completed
 * full-width BigInt conversion owner. No Number/parse conversion is imported.
 */
function runtime(offset: boolean) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const imported = {
    get: tx.reserveFunctionImport("binding:get", "binding", "get", { params: [ext, ext, ext], results: [ext] }),
    isCallable: tx.reserveFunctionImport("binding:callable", "binding", "isCallable", {
      params: [ext],
      results: [i32],
    }),
    method0: tx.reserveFunctionImport("binding:method0", "binding", "method0", { params: [ext, ext], results: [ext] }),
    method1: tx.reserveFunctionImport("binding:method1", "binding", "method1", {
      params: [ext, ext, ext],
      results: [ext],
    }),
    typeError: tx.reserveFunctionImport("binding:error", "binding", "typeError", { params: [ext], results: [ext] }),
  };
  const prefix = offset ? tx.reserveFunction("prefix", "prefix", { params: [], results: [] }) : undefined;
  if (offset) tx.reserveType("prefix:type", { kind: "struct", name: "Prefix", fields: [] });
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: offset,
    literals: texts.map((value) => ({ value, encoding: "wtf16" as const })),
  });
  const flatten = reserveNativeStringFlattenResources(tx, "flatten", strings);
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const bigintPlan = declareNativeBigIntResources("bigint"),
    bigint = reserveNativeBigIntResources(tx, "bigint", bigintPlan),
    bigintNumberPlan = declareNativeBigIntNumberResources("bigint-number"),
    bigintDependencies = { bigint, bigintPlan },
    bigintNumber = reserveNativeBigIntNumberResources(tx, "bigint-number", bigintNumberPlan, bigintDependencies);
  const anyType = tx.reserveType("undefined:type", buildAnyValueType()),
    numberType = tx.reserveType("number:type", buildBoxNumberType()),
    booleanType = tx.reserveType("boolean:type", buildBoxBooleanType()),
    powers = tx.reserveType("powers:type", buildDecimalPowerArrayType());
  const undefinedValue = tx.reserveGlobal("undefined", "undefined", { kind: "ref", typeIdx: anyType.typeIndex }, false),
    powerGlobal = tx.reserveGlobal("powers", "powers", { kind: "ref", typeIdx: powers.typeIndex }, false);
  const fn = (name: string, params: ValType[], results: ValType[]) =>
    tx.reserveFunction(name, name, { params, results });
  const boxNumber = fn("boxNumber", [f64], [ext]),
    boxBoolean = fn("boxBoolean", [i32], [ext]),
    getUndefined = fn("getUndefined", [], [ext]),
    scanner = fn("scanner", [ext], [f64]),
    primitive = fn("primitive", [ext], [f64]),
    isPrimitive = fn("isPrimitive", [ext], [i32]),
    isNullish = fn("isNullish", [ext], [i32]),
    isSymbol = fn("isSymbol", [ext], [i32]),
    number = fn("number", [ext], [f64]);
  const textFunctions = texts.map((_, index) => fn("text" + index, [], [ext]));
  const bigintFunctions = bigints.map((_, index) => fn("bigint" + index, [], [ext]));
  const exception = tx.reserveTag("exception", { params: [ext], results: [] }, { kind: "defined", name: "exception" });
  tx.freezeReservations();
  if (prefix) tx.fillFunction(prefix, { locals: [], body: [] });
  fillNativeStringLiteralResources(tx, strings);
  fillNativeStringFlattenResources(tx, flatten);
  fillNativeSymbolCarrierResources(tx, symbols);
  fillNativeBigIntResources(tx, bigint);
  fillNativeBigIntNumberResources(tx, bigintNumber);
  requireCompletedNativeBigIntNumber(tx, bigintNumber, bigintNumberPlan, bigintDependencies);
  tx.fillGlobal(undefinedValue, buildUndefinedInitializer(anyType.typeIndex));
  tx.fillGlobal(powerGlobal, buildDecimalPowerArrayInitializer(powers.typeIndex));
  tx.fillFunction(boxNumber, { locals: buildBoxNumberLocals(), body: buildBoxNumberBody(numberType.typeIndex) });
  tx.fillFunction(boxBoolean, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "struct.new", typeIdx: booleanType.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(getUndefined, {
    locals: [],
    body: [{ op: "global.get", index: tx.physicalIndex(undefinedValue) }, { op: "extern.convert_any" }],
  });
  tx.fillFunction(scanner, {
    locals: buildStringToNumberLocals(strings.layout),
    body: [
      ...buildStringToNumberPrelude(strings.layout, flatten.flatten.handle),
      ...buildStringToNumberResult({ arrayTypeIndex: powers.typeIndex, globalIndex: tx.physicalIndex(powerGlobal) }),
    ],
  });
  tx.fillFunction(primitive, {
    locals: buildUnboxNumberLocals(),
    body: buildUnboxNumberBody(numberType.typeIndex, booleanType.typeIndex, {
      kind: "native-string",
      anyStringTypeIdx: strings.layout.anyStrTypeIdx,
      toNumber: scanner.handle,
    }),
  });
  const typeTest = (typeIdx: number): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx },
  ];
  const nullOrUndefined: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    ...typeTest(anyType.typeIndex),
    { op: "i32.or" },
  ];
  tx.fillFunction(isNullish, { locals: [], body: structuredClone(nullOrUndefined) });
  tx.fillFunction(isSymbol, { locals: [], body: typeTest(symbols.types.symbol.typeIndex) });
  tx.fillFunction(isPrimitive, {
    locals: [],
    body: [
      ...structuredClone(nullOrUndefined),
      ...[
        -20,
        numberType.typeIndex,
        booleanType.typeIndex,
        strings.layout.anyStrTypeIdx,
        symbols.types.symbol.typeIndex,
        bigint.type.typeIndex,
      ].flatMap((typeIdx): Instr[] => [...typeTest(typeIdx), { op: "i32.or" }]),
    ],
  });
  const literal = (text: string): Instr[] => {
    const binding = requireNativeStringLiteral(tx, strings, text, "wtf16");
    return [
      binding.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(binding.global) }
        : { op: "call", funcIdx: binding.function.handle },
      { op: "extern.convert_any" },
    ];
  };
  for (const [index, text] of texts.entries())
    tx.fillFunction(textFunctions[index]!, { locals: [], body: literal(text) });
  for (const [index, value] of bigints.entries()) {
    let body: Instr[];
    if (value >= -(1n << 63n) && value < 1n << 63n)
      body = [
        { op: "i64.const", value },
        { op: "call", funcIdx: bigint.box.handle },
      ];
    else {
      const limbs: Instr[] = [];
      for (let rest = value < 0n ? -value : value; rest > 0n; rest >>= 32n)
        limbs.push({ op: "i32.const", value: Number(BigInt.asIntN(32, rest)) });
      body = [
        { op: "i64.const", value: BigInt.asIntN(64, value) },
        { op: "i32.const", value: value < 0n ? -1 : 1 },
        ...limbs,
        { op: "array.new_fixed", typeIdx: bigint.limbs.typeIndex, length: limbs.length },
        { op: "struct.new", typeIdx: bigint.wide.typeIndex },
        { op: "extern.convert_any" },
      ];
    }
    tx.fillFunction(bigintFunctions[index]!, { locals: [], body });
  }
  const bindings: NumberFromValueBindings = {
    get: imported.get.handle,
    isPrimitive: isPrimitive.handle,
    isCallable: imported.isCallable.handle,
    isNullish: isNullish.handle,
    isSymbol: isSymbol.handle,
    isBigInt: bigint.isBigInt.handle,
    method0: imported.method0.handle,
    method1: imported.method1.handle,
    primitiveToNumber: primitive.handle,
    bigintToNumber: bigintNumber.number.handle,
    typeError: imported.typeError.handle,
    exceptionTag: tx.physicalIndex(exception),
    operands: {
      toPrimitiveSymbol: [
        { op: "i32.const", value: 3 },
        { op: "call", funcIdx: symbols.functions.box.handle },
      ],
      numberHint: literal("number"),
      valueOfKey: literal("valueOf"),
      toStringKey: literal("toString"),
      nonCallableError: literal(errors.nonCallableError),
      nonPrimitiveError: literal(errors.nonPrimitiveError),
      symbolError: literal(errors.symbolError),
    },
  };
  tx.fillFunction(number, buildNumberFromValueDefinition(bindings));
  for (const token of [boxNumber, boxBoolean, getUndefined, number, ...textFunctions, ...bigintFunctions])
    tx.defineExport("export:" + token.object.name, token.object.name, token);
  tx.defineExport("export:symbol", "boxSymbol", symbols.functions.box);
  tx.defineExport("export:exception", "exception", exception);
  tx.seal();
  const bytes = emitBinary(module),
    wasm = new WebAssembly.Module(bytes as BufferSource);
  const trace: string[] = [],
    receivers: unknown[] = [],
    gets: { target: unknown; key: PropertyKey; receiver: unknown }[] = [],
    hints: unknown[] = [],
    callable = new Set<unknown>();
  const keyValues = new Map<unknown, PropertyKey>(),
    nativeTexts = new Map<string, unknown>(),
    nativeBigints = new Map<bigint, unknown>(),
    nativeSymbols = new Map<symbol, unknown>();
  let api: Record<string, (...args: any[]) => any> & { exception: WebAssembly.Tag };
  const encode = (value: unknown): unknown => {
    if (value === undefined) return api.getUndefined();
    if (typeof value === "number") return api.boxNumber(value);
    if (typeof value === "boolean") return api.boxBoolean(value ? 1 : 0);
    if (typeof value === "string") {
      if (!nativeTexts.has(value)) throw Error("unplanned fixture string " + value);
      return nativeTexts.get(value);
    }
    if (typeof value === "bigint") {
      if (!nativeBigints.has(value)) throw Error("unplanned fixture BigInt");
      return nativeBigints.get(value);
    }
    if (typeof value === "symbol") {
      if (!nativeSymbols.has(value)) nativeSymbols.set(value, api.boxSymbol(100 + nativeSymbols.size));
      return nativeSymbols.get(value);
    }
    return value;
  };
  const key = (value: unknown): PropertyKey => {
    if (!keyValues.has(value)) throw Error("unrecognized native key/hint/message");
    return keyValues.get(value)!;
  };
  api = new WebAssembly.Instance(wasm, {
    binding: {
      get(target: object, property: unknown, receiver: unknown) {
        const propertyKey = key(property);
        gets.push({ target, key: propertyKey, receiver });
        trace.push("get:" + (propertyKey === Symbol.toPrimitive ? "@@toPrimitive" : String(propertyKey)));
        return encode(Reflect.get(target, propertyKey, receiver));
      },
      isCallable(method: unknown) {
        return callable.has(method) ? 1 : 0;
      },
      method0(receiver: unknown, method: (...args: unknown[]) => unknown) {
        trace.push("call:0");
        receivers.push(receiver);
        return encode(Reflect.apply(method, receiver, []));
      },
      method1(receiver: unknown, method: (...args: unknown[]) => unknown, hint: unknown) {
        trace.push("call:1");
        receivers.push(receiver);
        hints.push(key(hint));
        return encode(Reflect.apply(method, receiver, [key(hint)]));
      },
      typeError(message: unknown) {
        trace.push("throw:TypeError");
        return new TypeError(String(key(message)));
      },
    },
  }).exports as typeof api;
  for (const [index, text] of texts.entries()) {
    const value = api["text" + index]!();
    nativeTexts.set(text, value);
    keyValues.set(value, text);
  }
  for (const [index, value] of bigints.entries()) nativeBigints.set(value, api["bigint" + index]!());
  keyValues.set(api.boxSymbol(3), Symbol.toPrimitive);
  return {
    bindings,
    bytes,
    trace,
    receivers,
    gets,
    hints,
    exception: api.exception,
    run: (value: unknown) => api.number(encode(value)) as number,
    method: <T extends ((...args: any[]) => any) | (new (...args: any[]) => any)>(value: T): T => {
      callable.add(value);
      return value;
    },
    clear: () => {
      trace.length = 0;
      receivers.length = 0;
      gets.length = 0;
      hints.length = 0;
      callable.clear();
    },
  };
}

function capture(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw Error("expected an exception");
}
function typeError(r: ReturnType<typeof runtime>, action: () => unknown, message: string): void {
  const error = capture(action);
  expect(error instanceof WebAssembly.Exception).toBe(true);
  if (!(error instanceof WebAssembly.Exception)) throw error;
  expect(error.is(r.exception)).toBe(true);
  const payload = error.getArg(r.exception, 0);
  expect(payload instanceof TypeError).toBe(true);
  expect((payload as TypeError).message).toBe(message);
}
const primitiveCases: readonly [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["false", false],
  ["true", true],
  ["positive zero", 0],
  ["negative zero", -0],
  ["NaN", NaN],
  ["number", 3.125],
  ["infinity", Infinity],
  ["negative infinity", -Infinity],
  ...stringValues.map((value): [string, unknown] => ["string " + JSON.stringify(value), value]),
  ...bigints.map((value): [string, unknown] => ["BigInt " + value, value]),
];

for (const offset of [false, true])
  describe(`full Number body with controlled bindings, offset=${offset}`, () => {
    let r: ReturnType<typeof runtime>;
    beforeAll(() => {
      r = runtime(offset);
    });
    beforeEach(() => r.clear());

    it("instantiates actual native layouts, scanner and completed BigInt owner with only explicit control imports", () => {
      const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.bytes as BufferSource));
      expect(imports.map((row) => row.name)).toEqual(["get", "isCallable", "method0", "method1", "typeError"]);
      expect(imports.every((row) => row.module === "binding")).toBe(true);
      expect(r.bindings.bigintToNumber).not.toBe(r.bindings.primitiveToNumber);
    });
    it.each(primitiveCases)("bypasses every Get/call for primitive %s", (_, value) => {
      expect(Object.is(r.run(value), Number(value))).toBe(true);
      expect(r.trace).toEqual([]);
    });
    it("rejects primitive Symbol without attempting a Get or numeric unbox", () => {
      typeError(r, () => r.run(Symbol("value")), errors.symbolError);
      expect(r.trace).toEqual(["throw:TypeError"]);
    });
    it.each([undefined, null])("uses ordered ordinary conversion for nullish exotic %s", (exotic) => {
      const object = {
        [Symbol.toPrimitive]: exotic,
        valueOf: r.method(() => 7),
        get toString() {
          throw Error("must not Get toString");
        },
      };
      expect(r.run(object)).toBe(7);
      expect(r.trace).toEqual(["get:@@toPrimitive", "get:valueOf", "call:0"]);
      expect(Object.is(r.receivers[0], object)).toBe(true);
      expect(r.hints).toEqual([]);
    });
    it("uses the original receiver for an inherited exotic getter and method with exactly the number hint", () => {
      const getterReceivers: unknown[] = [],
        methodReceivers: unknown[] = [],
        args: unknown[][] = [];
      const method = r.method(function (this: unknown, ...values: unknown[]) {
        methodReceivers.push(this);
        args.push(values);
        return " 42 ";
      });
      const proto = {
        get [Symbol.toPrimitive]() {
          getterReceivers.push(this);
          return method;
        },
      };
      const object = Object.create(proto);
      expect(r.run(object)).toBe(42);
      expect(r.trace).toEqual(["get:@@toPrimitive", "call:1"]);
      expect([getterReceivers[0], methodReceivers[0], r.receivers[0]].every((value) => Object.is(value, object))).toBe(
        true,
      );
      expect(Object.is(object, proto)).toBe(false);
      expect(args).toEqual([["number"]]);
      expect(r.hints).toEqual(["number"]);
      expect(r.gets).toEqual([{ target: object, key: Symbol.toPrimitive, receiver: object }]);
    });
    it("passes the original object as target and receiver through both inherited ordinary getters", () => {
      const observed: unknown[] = [];
      const valueOfMethod = r.method(function (this: unknown) {
        observed.push(this);
        return {};
      });
      const toStringMethod = r.method(function (this: unknown) {
        observed.push(this);
        return " 42 ";
      });
      const proto = {
        get valueOf() {
          observed.push(this);
          return valueOfMethod;
        },
        get toString() {
          observed.push(this);
          return toStringMethod;
        },
      };
      const object = Object.create(proto);
      expect(r.run(object)).toBe(Number(object));
      expect(observed).toHaveLength(8);
      expect(observed.every((receiver) => receiver === object)).toBe(true);
      expect(r.gets.map((read) => read.key)).toEqual([Symbol.toPrimitive, "valueOf", "toString"]);
      expect(r.gets.every((read) => read.target === object && read.receiver === object)).toBe(true);
    });
    it.each([false, 1, "bad", {}, Symbol("non-callable")])(
      "rejects noncallable exotic %s without ordinary fallback",
      (method) => {
        const object = {
          [Symbol.toPrimitive]: method,
          get valueOf() {
            throw Error("must not fall back");
          },
        };
        typeError(r, () => r.run(object), errors.nonCallableError);
        expect(r.trace).toEqual(["get:@@toPrimitive", "throw:TypeError"]);
      },
    );
    it.each([{}, function notPrimitive() {}])(
      "rejects an exotic object result %s without ordinary fallback",
      (result) => {
        const object = {
          [Symbol.toPrimitive]: r.method(() => result),
          get valueOf() {
            throw Error("must not fall back");
          },
        };
        typeError(r, () => r.run(object), errors.nonPrimitiveError);
        expect(r.trace).toEqual(["get:@@toPrimitive", "call:1", "throw:TypeError"]);
      },
    );
    it("reads toString only after the valueOf call and preserves original receiver for inherited methods", () => {
      const effects: string[] = [],
        seen: unknown[] = [];
      const proto = {
        get valueOf() {
          effects.push("get valueOf");
          seen.push(this);
          return r.method(function (this: unknown) {
            effects.push("call valueOf");
            seen.push(this);
            return {};
          });
        },
        get toString() {
          effects.push("get toString");
          seen.push(this);
          return r.method(function (this: unknown, ...args: unknown[]) {
            effects.push("call toString");
            seen.push(this);
            expect(args).toEqual([]);
            return "3.125";
          });
        },
      };
      const object = Object.create(proto);
      expect(r.run(object)).toBe(3.125);
      expect(effects).toEqual(["get valueOf", "call valueOf", "get toString", "call toString"]);
      expect(seen.every((value) => Object.is(value, object))).toBe(true);
      expect(r.trace).toEqual(["get:@@toPrimitive", "get:valueOf", "call:0", "get:toString", "call:0"]);
    });
    it("observes mutation of toString by valueOf instead of fetching both methods early", () => {
      const object = {
        valueOf: r.method(() => {
          object.toString = r.method(() => " 42 ");
          return {};
        }),
        toString: r.method(() => "bad"),
      };
      expect(r.run(object)).toBe(42);
      expect(r.trace).toEqual(["get:@@toPrimitive", "get:valueOf", "call:0", "get:toString", "call:0"]);
    });
    it.each([undefined, null, false, 1, "bad", {}, Symbol("non-callable")])(
      "skips ordinary noncallable valueOf %s",
      (candidate) => {
        const object = { valueOf: candidate, toString: r.method(() => " 42 ") };
        expect(r.run(object)).toBe(42);
        expect(r.trace).toEqual(["get:@@toPrimitive", "get:valueOf", "get:toString", "call:0"]);
      },
    );
    it.each(["noncallable", "object result"] as const)("throws after exhausting ordinary conversion: %s", (kind) => {
      const object = {
        valueOf: r.method(() => ({})),
        toString: kind === "noncallable" ? {} : r.method(() => ({})),
      };
      typeError(r, () => r.run(object), errors.nonPrimitiveError);
      expect(r.trace).toEqual([
        "get:@@toPrimitive",
        "get:valueOf",
        "call:0",
        "get:toString",
        ...(kind === "object result" ? ["call:0"] : []),
        "throw:TypeError",
      ]);
    });
    for (const phase of ["exotic", "valueOf", "toString"] as const)
      it.each(["class", "proxy-class"] as const)(
        `attempts the ${phase} %s [[Call]] and propagates its class refusal like native Number`,
        (kind) => {
          const make = (register: boolean) => {
            const effects: string[] = [],
              calls: { receiver: unknown; args: unknown[] }[] = [];
            const target = class NumberMethod {};
            const method =
              kind === "class"
                ? target
                : new Proxy(target, {
                    apply(target, receiver, args) {
                      effects.push("class [[Call]]");
                      calls.push({ receiver, args });
                      return Reflect.apply(target, receiver, args);
                    },
                  });
            const fallback = () => {
              effects.push("call valueOf");
              return {};
            };
            if (register) {
              r.method(method);
              r.method(fallback);
            }
            const object = {
              get [Symbol.toPrimitive]() {
                effects.push("get exotic");
                return phase === "exotic" ? method : undefined;
              },
              get valueOf() {
                effects.push("get valueOf");
                return phase === "valueOf" ? method : fallback;
              },
              get toString() {
                effects.push("get toString");
                return method;
              },
            };
            return { object, effects, calls };
          };
          const oracle = make(false),
            actual = make(true);
          const expected = capture(() => Number(oracle.object)),
            error = capture(() => r.run(actual.object));
          expect(expected instanceof TypeError).toBe(true);
          expect(error instanceof TypeError).toBe(true);
          expect((error as TypeError).message).toBe((expected as TypeError).message);
          expect(actual.effects).toEqual(oracle.effects);
          expect(r.trace).toEqual(
            phase === "exotic"
              ? ["get:@@toPrimitive", "call:1"]
              : [
                  "get:@@toPrimitive",
                  "get:valueOf",
                  "call:0",
                  ...(phase === "toString" ? ["get:toString", "call:0"] : []),
                ],
          );
          expect(Object.is(r.receivers.at(-1), actual.object)).toBe(true);
          expect(r.hints).toEqual(phase === "exotic" ? ["number"] : []);
          if (kind === "proxy-class") {
            expect(actual.calls).toHaveLength(1);
            expect(Object.is(actual.calls[0]!.receiver, actual.object)).toBe(true);
            expect(actual.calls[0]!.args).toEqual(phase === "exotic" ? ["number"] : []);
          }
        },
      );
    it.each(["exotic", "valueOf"] as const)(
      "invokes a proxy-class apply trap for %s and matches native Number",
      (phase) => {
        const make = (register: boolean) => {
          const calls: { receiver: unknown; args: unknown[] }[] = [];
          const method = new Proxy(class NumberMethod {}, {
            apply(_target, receiver, args) {
              calls.push({ receiver, args });
              return " 42 ";
            },
          });
          if (register) r.method(method);
          const object: object = phase === "exotic" ? { [Symbol.toPrimitive]: method } : { valueOf: method };
          return { object, calls };
        };
        const oracle = make(false),
          actual = make(true);
        const result = r.run(actual.object);
        expect(result).toBe(Number(oracle.object));
        expect(result).toBe(42);
        expect(actual.calls).toHaveLength(1);
        expect(Object.is(actual.calls[0]!.receiver, actual.object)).toBe(true);
        expect(actual.calls[0]!.args).toEqual(oracle.calls[0]!.args);
        expect(actual.calls[0]!.args).toEqual(phase === "exotic" ? ["number"] : []);
        expect(r.trace).toEqual(
          phase === "exotic" ? ["get:@@toPrimitive", "call:1"] : ["get:@@toPrimitive", "get:valueOf", "call:0"],
        );
      },
    );
    for (const method of ["exotic", "valueOf", "toString"] as const) {
      it.each([
        ["undefined", undefined],
        ["null", null],
        ["false", false],
        ["negative zero", -0],
        ["NaN", NaN],
        ["numeric string", " 42 "],
        ["wide BigInt", bigints[3]],
      ] as const)(`converts ${method} primitive result %s`, (_, result) => {
        const convert = r.method(() => result);
        const object: object =
          method === "exotic"
            ? { [Symbol.toPrimitive]: convert }
            : method === "valueOf"
              ? { valueOf: convert }
              : { valueOf: r.method(() => ({})), toString: convert };
        expect(Object.is(r.run(object), Number(result))).toBe(true);
        expect(r.trace).toEqual(
          method === "exotic"
            ? ["get:@@toPrimitive", "call:1"]
            : [
                "get:@@toPrimitive",
                "get:valueOf",
                "call:0",
                ...(method === "toString" ? ["get:toString", "call:0"] : []),
              ],
        );
      });
      it(`rejects a Symbol result of ${method} at Number conversion`, () => {
        const convert = r.method(() => Symbol("result"));
        const object: object =
          method === "exotic"
            ? { [Symbol.toPrimitive]: convert }
            : method === "valueOf"
              ? { valueOf: convert }
              : { valueOf: r.method(() => ({})), toString: convert };
        typeError(r, () => r.run(object), errors.symbolError);
        expect(r.trace.at(-1)).toBe("throw:TypeError");
        expect(r.trace.filter((value) => value.startsWith("get:"))).toEqual(
          method === "exotic"
            ? ["get:@@toPrimitive"]
            : ["get:@@toPrimitive", "get:valueOf", ...(method === "toString" ? ["get:toString"] : [])],
        );
      });
    }
    for (const phase of [
      "get exotic",
      "call exotic",
      "get valueOf",
      "call valueOf",
      "get toString",
      "call toString",
    ] as const)
      it.each(["host", "tagged"] as const)(
        `propagates ${phase} %s exception unchanged and stops all later work`,
        (kind) => {
          const payload = { sentinel: phase },
            thrown = kind === "tagged" ? new WebAssembly.Exception(r.exception, [payload]) : payload;
          const fail = r.method(() => {
            throw thrown;
          });
          const object: Record<PropertyKey, unknown> = {};
          if (phase === "get exotic") Object.defineProperty(object, Symbol.toPrimitive, { get: fail });
          if (phase === "call exotic") object[Symbol.toPrimitive] = fail;
          if (phase === "get valueOf") Object.defineProperty(object, "valueOf", { get: fail });
          if (phase === "call valueOf") object.valueOf = fail;
          if (phase.includes("toString")) {
            object.valueOf = r.method(() => ({}));
            if (phase === "get toString") Object.defineProperty(object, "toString", { get: fail });
            else object.toString = fail;
          }
          expect(
            Object.is(
              capture(() => r.run(object)),
              thrown,
            ),
          ).toBe(true);
          const expected = ["get:@@toPrimitive"];
          if (phase === "call exotic") expected.push("call:1");
          if (phase.includes("valueOf") || phase.includes("toString")) expected.push("get:valueOf");
          if (phase === "call valueOf" || phase.includes("toString")) expected.push("call:0");
          if (phase.includes("toString")) expected.push("get:toString");
          if (phase === "call toString") expected.push("call:0");
          expect(r.trace).toEqual(expected);
        },
      );
  });

describe("mandatory pure Number bindings", () => {
  const handles = [
    "get",
    "isPrimitive",
    "isCallable",
    "isNullish",
    "isSymbol",
    "isBigInt",
    "method0",
    "method1",
    "primitiveToNumber",
    "bigintToNumber",
    "typeError",
    "exceptionTag",
  ] as const;
  const operands = [
    "toPrimitiveSymbol",
    "numberHint",
    "valueOfKey",
    "toStringKey",
    "nonCallableError",
    "nonPrimitiveError",
    "symbolError",
  ] as const;
  const valid = (): NumberFromValueBindings =>
    ({
      ...Object.fromEntries(handles.map((key, index) => [key, index])),
      operands: Object.fromEntries(operands.map((key) => [key, [{ op: "ref.null.extern" }]])),
    }) as unknown as NumberFromValueBindings;
  it.each(handles)("rejects missing or unresolved %s after a structural positive", (key) => {
    expect(buildNumberFromValueDefinition(valid()).body.length).toBeGreaterThan(0);
    for (const value of [undefined, -1, 0.5, NaN])
      expect(() => buildNumberFromValueDefinition({ ...valid(), [key]: value } as NumberFromValueBindings)).toThrow(
        "unresolved binding " + key,
      );
  });
  it.each(operands)("rejects missing or empty operand %s", (key) => {
    expect(buildNumberFromValueDefinition(valid()).body.length).toBeGreaterThan(0);
    for (const value of [undefined, []])
      expect(() =>
        buildNumberFromValueDefinition({
          ...valid(),
          operands: { ...valid().operands, [key]: value },
        } as NumberFromValueBindings),
      ).toThrow("unresolved operand " + key);
  });
  it("copies literal instructions without mutating or borrowing the input operand arrays", () => {
    const bindings = valid(),
      snapshot = structuredClone(bindings),
      first = buildNumberFromValueDefinition(bindings),
      second = buildNumberFromValueDefinition(bindings);
    expect(bindings).toEqual(snapshot);
    const block = first.body[0];
    if (block?.op !== "block") throw Error("missing conversion block");
    const instruction = block.body.find((row) => row.op === "ref.null.extern");
    expect(instruction).toBeDefined();
    expect(Object.is(instruction, bindings.operands.toPrimitiveSymbol[0])).toBe(false);
    Object.assign(instruction!, { marker: "changed" });
    expect(bindings).toEqual(snapshot);
    expect(second).toEqual(buildNumberFromValueDefinition(bindings));
  });
  it.each(["get", "operands"] as const)("refuses top-level %s getters without running them", (key) => {
    const input = valid();
    let reads = 0;
    Object.defineProperty(input, key, {
      get: () => {
        reads++;
        return 0;
      },
    });
    expect(() => buildNumberFromValueDefinition(input)).toThrow();
    expect(reads).toBe(0);
  });
  it.each(operands)("refuses nested %s accessors without running them", (key) => {
    const input = valid();
    let reads = 0;
    Object.defineProperty(input.operands, key, {
      get: () => {
        reads++;
        return [{ op: "ref.null.extern" }];
      },
    });
    expect(() => buildNumberFromValueDefinition(input)).toThrow();
    expect(reads).toBe(0);
  });
  it.each(["sparse", "accessor", "cyclic", "symbol", "prototype", "unresolved"] as const)(
    "refuses malformed %s instruction data",
    (shape) => {
      const input = valid();
      let reads = 0;
      const instruction: Record<string | symbol, unknown> = { op: "ref.null.extern" };
      let operand: unknown[] = [instruction];
      if (shape === "sparse") operand = new Array(1);
      if (shape === "accessor")
        Object.defineProperty(instruction, "op", {
          get: () => {
            reads++;
            return "ref.null.extern";
          },
        });
      if (shape === "cyclic") instruction.body = operand;
      if (shape === "symbol") instruction[Symbol("extra")] = true;
      if (shape === "prototype") Object.setPrototypeOf(instruction, { extra: true });
      if (shape === "unresolved") instruction.op = undefined;
      Object.assign(input.operands, { numberHint: operand });
      expect(() => buildNumberFromValueDefinition(input)).toThrow();
      expect(reads).toBe(0);
    },
  );
  it.each(["hidden", "inherited", "extra", "symbol"] as const)("refuses %s binding fields", (shape) => {
    const input = valid();
    if (shape === "hidden") Object.defineProperty(input, "get", { enumerable: false });
    if (shape === "inherited") {
      Object.setPrototypeOf(input, { get: input.get });
      Reflect.deleteProperty(input, "get");
    }
    if (shape === "extra") Object.assign(input, { extra: 0 });
    if (shape === "symbol") Object.defineProperty(input, Symbol("extra"), { value: 0 });
    expect(() => buildNumberFromValueDefinition(input)).toThrow();
  });
  it.each(["funcIdx", "typeIdx", "tagIdx", "index", "depth", "fieldIdx"] as const)(
    "rejects unresolved operand coordinate %s",
    (key) => {
      for (const value of [-1, 0.5, NaN, 0x100000000]) {
        const input = valid();
        Object.assign(input.operands, { numberHint: [{ op: "call", [key]: value }] });
        expect(() => buildNumberFromValueDefinition(input)).toThrow();
      }
    },
  );
  it("refuses hidden instruction fields and extra array fields", () => {
    const first = valid();
    Object.defineProperty(first.operands.numberHint[0]!, "hidden", { value: true });
    expect(() => buildNumberFromValueDefinition(first)).toThrow();
    const second = valid();
    Object.assign(second.operands.numberHint, { extra: true });
    expect(() => buildNumberFromValueDefinition(second)).toThrow();
  });
  it.each(handles)("refuses overflowing %s coordinates", (key) => {
    expect(() => buildNumberFromValueDefinition({ ...valid(), [key]: 0x100000000 })).toThrow();
  });
});
