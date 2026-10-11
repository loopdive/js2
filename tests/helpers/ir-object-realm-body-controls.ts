// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createEmptyModule } from "../../src/ir/types.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { ValType } from "../../src/wasm/model/instructions.js";
import { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";
import {
  buildObjectPrototypeMethodDefinition,
  type ObjectPrototypeMethod,
} from "../../src/runtime/wasmgc/values/object-prototype-method-bodies.js";
import {
  buildObjectPrototypeAccessorDefinition,
  type ObjectPrototypeAccessorMethod,
} from "../../src/runtime/wasmgc/values/object-prototype-accessor-bodies.js";
import { buildObjectConstructorDefinition } from "../../src/runtime/wasmgc/values/object-constructor-body.js";

export const methods = [
  "hasOwnProperty",
  "propertyIsEnumerable",
  "isPrototypeOf",
  "toLocaleString",
  "valueOf",
] as const;
export const accessors = [
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "get __proto__",
  "set __proto__",
] as const;
export type RealmBodyName = ObjectPrototypeMethod | ObjectPrototypeAccessorMethod | "Object";
const isObject = (value: unknown): value is object =>
  value !== null && (typeof value === "object" || typeof value === "function");
function toObject(value: unknown): object {
  if (value == null) throw new TypeError("ToObject nullish");
  return Object(value);
}
const descriptor = (value: unknown): PropertyDescriptor => value as PropertyDescriptor;
// Imported semantic controls, deliberately not native-owner completion evidence.
// No control invokes a tested prototype method. Native Object provides ToObject
// and subclass allocation controls for constructor composition, not the emitted body.
// ToPropertyKey uses a computed key; descriptor/prototype/Get/Call use Reflect.
const controlFunctions = {
  toObject,
  toPropertyKey: (value: unknown) => Reflect.ownKeys({ [value as PropertyKey]: true })[0],
  getOwnProperty: (object: unknown, key: unknown) =>
    Reflect.getOwnPropertyDescriptor(object as object, key as PropertyKey),
  isUndefined: (value: unknown) => +(value === undefined),
  descriptorEnumerable: (value: unknown) => +!!descriptor(value).enumerable,
  booleanValue: (value: number) => !!value,
  isObject: (value: unknown) => +isObject(value),
  isNull: (value: unknown) => +(value === null),
  getPrototypeOf: (object: unknown) => Reflect.getPrototypeOf(object as object),
  sameValue: (a: unknown, b: unknown) => +Object.is(a, b),
  get: (object: unknown, key: unknown, receiver: unknown) =>
    Reflect.get(object as object, key as PropertyKey, receiver),
  isCallable: (value: unknown) => +(typeof value === "function"),
  call0: (fn: unknown, receiver: unknown) => Reflect.apply(fn as (...args: unknown[]) => unknown, receiver, []),
  throwTypeError: () => {
    throw new TypeError("internal operation refused");
  },
  makeAccessorDescriptor: (fn: unknown, setter: number) =>
    setter ? { set: fn, enumerable: true, configurable: true } : { get: fn, enumerable: true, configurable: true },
  defineOwnProperty: (object: unknown, key: unknown, desc: unknown) =>
    +Reflect.defineProperty(object as object, key as PropertyKey, descriptor(desc)),
  undefinedValue: () => undefined,
  isAccessorDescriptor: (value: unknown) =>
    +(Object.hasOwn(descriptor(value), "get") || Object.hasOwn(descriptor(value), "set")),
  descriptorGetter: (value: unknown) => descriptor(value).get,
  descriptorSetter: (value: unknown) => descriptor(value).set,
  requireObjectCoercible: (value: unknown) => {
    if (value == null) throw new TypeError("RequireObjectCoercible nullish");
    return value;
  },
  setPrototypeOf: (object: unknown, proto: unknown) =>
    +Reflect.setPrototypeOf(object as object, proto as object | null),
  ordinaryCreate: () => Object.create(Object.prototype),
  createFromConstructor: (target: unknown) => Reflect.construct(Object, [], target as new () => object),
  activeFunction: () => Object,
  toStringKey: () => "toString",
};
type Control = keyof typeof controlFunctions;
const predicates = new Set<Control>([
  "isUndefined",
  "descriptorEnumerable",
  "isObject",
  "isNull",
  "sameValue",
  "isCallable",
  "defineOwnProperty",
  "isAccessorDescriptor",
  "setPrototypeOf",
]);
const zeroArgs = new Set<Control>([
  "throwTypeError",
  "undefinedValue",
  "ordinaryCreate",
  "activeFunction",
  "toStringKey",
]);
const twoArgs = new Set<Control>(["getOwnProperty", "sameValue", "call0", "makeAccessorDescriptor", "setPrototypeOf"]);
export function objectRealmBodyRuntime(displaced: boolean) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const ext: ValType = { kind: "externref" },
    i32: ValType = { kind: "i32" };
  if (displaced) {
    tx.reserveFunctionImport("offset:import", "offset", "noop", { params: [], results: [] });
    tx.reserveType("offset:type", { kind: "struct", name: "Offset", fields: [] });
  }
  const controls = Object.fromEntries(
    (Object.keys(controlFunctions) as Control[]).map((key) => {
      const params = zeroArgs.has(key)
        ? []
        : key === "get" || key === "defineOwnProperty"
          ? [ext, ext, ext]
          : twoArgs.has(key)
            ? [ext, key === "makeAccessorDescriptor" ? i32 : ext]
            : [key === "booleanValue" ? i32 : ext];
      return [
        key,
        tx.reserveFunctionImport("control:" + key, "control", key, {
          params,
          results: key === "throwTypeError" ? [] : [predicates.has(key) ? i32 : ext],
        }),
      ];
    }),
  ) as Record<Control, ReturnType<typeof tx.reserveFunctionImport>>;
  const tokens = Object.fromEntries(
    [...methods, ...accessors, "Object" as const].map((name) => {
      const arity = name.startsWith("__define")
        ? 3
        : name === "valueOf" || name === "toLocaleString" || name === "get __proto__"
          ? 1
          : 2;
      return [
        name,
        tx.reserveFunction("body:" + name, name, { params: Array.from({ length: arity }, () => ext), results: [ext] }),
      ];
    }),
  ) as Record<RealmBodyName, ReturnType<typeof tx.reserveFunction>>;
  const handles = Object.fromEntries(
    (Object.keys(controls) as Control[]).map((key) => [key, controls[key].handle]),
  ) as Record<Control, (typeof controls)[Control]["handle"]>;
  const operands = {
    toStringKey: [{ op: "call" as const, funcIdx: handles.toStringKey }],
    activeFunction: [{ op: "call" as const, funcIdx: handles.activeFunction }],
  };
  tx.freezeReservations();
  for (const name of methods)
    tx.fillFunction(
      tokens[name],
      buildObjectPrototypeMethodDefinition(name, { ...handles, toStringKey: operands.toStringKey }),
    );
  for (const name of accessors) tx.fillFunction(tokens[name], buildObjectPrototypeAccessorDefinition(name, handles));
  tx.fillFunction(
    tokens.Object,
    buildObjectConstructorDefinition({ ...handles, activeFunction: operands.activeFunction }),
  );
  for (const name of Object.keys(tokens) as RealmBodyName[]) tx.defineExport("export:" + name, name, tokens[name]);
  tx.seal();
  const wasm = new WebAssembly.Module(emitBinary(module) as BufferSource);
  const instantiate = (
    trace: string[] = [],
    overrides: Partial<Record<Control, (...args: never[]) => unknown>> = {},
  ) => {
    const control = Object.fromEntries(
      (Object.keys(controlFunctions) as Control[]).map((key) => [
        key,
        (...args: never[]) => {
          trace.push(key);
          const fn = overrides[key] ?? controlFunctions[key];
          return (fn as (...args: never[]) => unknown)(...args);
        },
      ]),
    );
    const instance = new WebAssembly.Instance(wasm, { control, offset: { noop() {} } });
    return instance.exports as Record<RealmBodyName, (...args: unknown[]) => unknown>;
  };
  return { instantiate, module, handles, operands };
}
