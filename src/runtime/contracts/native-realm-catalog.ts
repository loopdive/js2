// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Semantic data only. A catalog entry is never an implementation or completion capability.
 * ECMA-262 2026 §§9.3.2, 10.2.4, 18, 20.1, 20.2:
 * https://tc39.es/ecma262/2026/multipage/fundamental-objects.html
 */
export type NativeRealmPropertyKey =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "symbol"; readonly value: "Symbol.hasInstance" };
export type NativeRealmPropertyValue =
  | { readonly kind: "intrinsic"; readonly id: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number };
export type NativeRealmProperty = {
  readonly key: NativeRealmPropertyKey;
  readonly enumerable: false;
  readonly configurable: boolean;
  readonly normativeOptional?: true;
  readonly legacy?: true;
} & (
  | { readonly kind: "data"; readonly writable: boolean; readonly value: NativeRealmPropertyValue }
  | { readonly kind: "accessor"; readonly get: string; readonly set: string }
);
export interface NativeRealmIntrinsic {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly prototype: string | null;
  readonly extensible: boolean;
  readonly immutablePrototype: boolean;
  readonly constructible: boolean;
  readonly normativeOptional: boolean;
  readonly legacy: boolean;
  readonly properties: readonly NativeRealmProperty[];
  readonly callable?: {
    readonly initialName: string;
    readonly length: number;
    readonly algorithm: string;
    readonly implementation: "function-prototype" | "throw-type-error" | "unavailable";
    readonly requires: readonly string[];
  };
}
const objectPrototype = "%Object.prototype%",
  functionPrototype = "%Function.prototype%",
  throwTypeError = "%ThrowTypeError%";
const key = (value: string): NativeRealmPropertyKey => ({ kind: "string", value });
function data(
  name: string,
  value: NativeRealmPropertyValue,
  writable = true,
  configurable = true,
): NativeRealmProperty {
  return { key: key(name), kind: "data", value, writable, enumerable: false, configurable };
}
function reference(name: string, id: string, writable = true, configurable = true): NativeRealmProperty {
  return data(name, { kind: "intrinsic", id }, writable, configurable);
}
function accessor(name: string, get: string, set: string): NativeRealmProperty {
  return { key: key(name), kind: "accessor", get, set, enumerable: false, configurable: true };
}
function callable(
  id: string,
  initialName: string,
  length: number,
  algorithm: string,
  requires: readonly string[],
  properties: readonly NativeRealmProperty[] = [],
  constructible = false,
  implementation: NonNullable<NativeRealmIntrinsic["callable"]>["implementation"] = "unavailable",
  legacy = false,
): NativeRealmIntrinsic {
  const restricted = id === throwTypeError;
  return {
    id,
    aliases: [id],
    prototype: id === functionPrototype ? objectPrototype : functionPrototype,
    extensible: !restricted,
    immutablePrototype: false,
    constructible,
    normativeOptional: legacy,
    legacy,
    callable: { initialName, length, algorithm, implementation, requires },
    properties: [
      data("length", { kind: "number", value: length }, false, !restricted),
      data("name", { kind: "string", value: initialName }, false, !restricted),
      ...properties,
    ],
  };
}
type Method = readonly [name: string, length: number, requires: readonly string[]];
const objectStatics: readonly Method[] = [
  ["assign", 2, ["ToObject", "OwnPropertyKeys", "GetOwnProperty", "Get", "Set"]],
  ["create", 2, ["OrdinaryObjectCreate", "ObjectDefineProperties"]],
  ["defineProperties", 2, ["ObjectDefineProperties"]],
  ["defineProperty", 3, ["ToPropertyKey", "ToPropertyDescriptor", "DefinePropertyOrThrow"]],
  ["entries", 1, ["ToObject", "EnumerableOwnProperties", "CreateArrayFromList"]],
  ["freeze", 1, ["SetIntegrityLevel"]],
  ["fromEntries", 1, ["RequireObjectCoercible", "OrdinaryObjectCreate", "AddEntriesFromIterable", "ToPropertyKey"]],
  ["getOwnPropertyDescriptor", 2, ["ToObject", "ToPropertyKey", "GetOwnProperty", "FromPropertyDescriptor"]],
  ["getOwnPropertyDescriptors", 1, ["ToObject", "OwnPropertyKeys", "GetOwnProperty", "FromPropertyDescriptor"]],
  ["getOwnPropertyNames", 1, ["GetOwnPropertyKeys"]],
  ["getOwnPropertySymbols", 1, ["GetOwnPropertyKeys"]],
  ["getPrototypeOf", 1, ["ToObject", "GetPrototypeOf"]],
  ["groupBy", 2, ["GroupBy", "OrdinaryObjectCreate", "CreateArrayFromList"]],
  ["hasOwn", 2, ["ToObject", "ToPropertyKey", "HasOwnProperty"]],
  ["is", 2, ["SameValue"]],
  ["isExtensible", 1, ["IsExtensible"]],
  ["isFrozen", 1, ["TestIntegrityLevel"]],
  ["isSealed", 1, ["TestIntegrityLevel"]],
  ["keys", 1, ["ToObject", "EnumerableOwnProperties", "CreateArrayFromList"]],
  ["preventExtensions", 1, ["PreventExtensions"]],
  ["seal", 1, ["SetIntegrityLevel"]],
  ["setPrototypeOf", 2, ["RequireObjectCoercible", "SetPrototypeOf"]],
  ["values", 1, ["ToObject", "EnumerableOwnProperties", "CreateArrayFromList"]],
];
const objectMethods: readonly Method[] = [
  ["hasOwnProperty", 1, ["ToPropertyKey", "ToObject", "HasOwnProperty"]],
  ["isPrototypeOf", 1, ["ToObject", "GetPrototypeOf", "SameValue"]],
  ["propertyIsEnumerable", 1, ["ToPropertyKey", "ToObject", "GetOwnProperty"]],
  ["toLocaleString", 0, ["Invoke"]],
  ["toString", 0, ["ToObject", "IsArray", "Get:Symbol.toStringTag"]],
  ["valueOf", 0, ["ToObject"]],
];
const legacyMethods: readonly Method[] = [
  ["__defineGetter__", 2, ["ToObject", "IsCallable", "ToPropertyKey", "DefinePropertyOrThrow"]],
  ["__defineSetter__", 2, ["ToObject", "IsCallable", "ToPropertyKey", "DefinePropertyOrThrow"]],
  ["__lookupGetter__", 1, ["ToObject", "ToPropertyKey", "GetOwnProperty", "GetPrototypeOf"]],
  ["__lookupSetter__", 1, ["ToObject", "ToPropertyKey", "GetOwnProperty", "GetPrototypeOf"]],
];
const functionMethods: readonly Method[] = [
  ["apply", 2, ["IsCallable", "CreateListFromArrayLike", "Call"]],
  [
    "bind",
    1,
    ["IsCallable", "BoundFunctionCreate", "Get", "ToIntegerOrInfinity", "SetFunctionLength", "SetFunctionName"],
  ],
  ["call", 1, ["IsCallable", "Call"]],
  ["toString", 0, ["HostHasSourceTextAvailable", "SourceText", "InitialName", "IsCallable"]],
];
const methodId = (parent: string, name: string) => `%${parent}.${name}%`;
function members(parent: string, rows: readonly Method[], legacy = false): NativeRealmIntrinsic[] {
  return rows.map(([name, length, requires]) =>
    callable(methodId(parent, name), name, length, parent + "." + name, requires, [], false, "unavailable", legacy),
  );
}
const methodProperties = (parent: string, rows: readonly Method[]) =>
  rows.map(([name]) => reference(name, methodId(parent, name)));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function catalog(): readonly NativeRealmIntrinsic[] {
  const rows: NativeRealmIntrinsic[] = [
    {
      id: objectPrototype,
      aliases: [objectPrototype, "Object.prototype"],
      prototype: null,
      extensible: true,
      immutablePrototype: true,
      constructible: false,
      normativeOptional: false,
      legacy: false,
      properties: [
        reference("constructor", "%Object%"),
        ...methodProperties("Object.prototype", objectMethods),
        {
          ...accessor("__proto__", "%get Object.prototype.__proto__%", "%set Object.prototype.__proto__%"),
          normativeOptional: true,
          legacy: true,
        },
        ...methodProperties("Object.prototype", legacyMethods).map((row) => ({
          ...row,
          normativeOptional: true as const,
          legacy: true as const,
        })),
      ],
    },
    callable(
      functionPrototype,
      "",
      0,
      "Function.prototype",
      [],
      [
        ...methodProperties("Function.prototype", functionMethods.slice(0, 3)),
        reference("constructor", "%Function%"),
        ...methodProperties("Function.prototype", functionMethods.slice(3)),
        {
          ...reference("", "%Function.prototype[@@hasInstance]%", false, false),
          key: { kind: "symbol", value: "Symbol.hasInstance" },
        },
        accessor("caller", throwTypeError, throwTypeError),
        accessor("arguments", throwTypeError, throwTypeError),
      ],
      false,
      "function-prototype",
    ),
    callable(throwTypeError, "", 0, "ThrowTypeError", ["TypeError"], [], false, "throw-type-error"),
    callable(
      "%Object%",
      "Object",
      1,
      "Object",
      ["OrdinaryCreateFromConstructor", "ToObject"],
      [
        ...methodProperties("Object", objectStatics.slice(0, 20)),
        reference("prototype", objectPrototype, false, false),
        ...methodProperties("Object", objectStatics.slice(20)),
      ],
      true,
    ),
    callable(
      "%Function%",
      "Function",
      1,
      "CreateDynamicFunction",
      ["HostEnsureCanCompileStrings", "ParseText", "OrdinaryFunctionCreate", "MakeConstructor"],
      [reference("prototype", functionPrototype, false, false)],
      true,
    ),
    ...members("Object", objectStatics),
    ...members("Object.prototype", objectMethods),
    callable(
      "%get Object.prototype.__proto__%",
      "get __proto__",
      0,
      "get Object.prototype.__proto__",
      ["ToObject", "GetPrototypeOf"],
      [],
      false,
      "unavailable",
      true,
    ),
    callable(
      "%set Object.prototype.__proto__%",
      "set __proto__",
      1,
      "set Object.prototype.__proto__",
      ["RequireObjectCoercible", "SetPrototypeOf"],
      [],
      false,
      "unavailable",
      true,
    ),
    ...members("Object.prototype", legacyMethods, true),
    ...members("Function.prototype", functionMethods),
    callable("%Function.prototype[@@hasInstance]%", "[Symbol.hasInstance]", 1, "OrdinaryHasInstance", [
      "OrdinaryHasInstance",
    ]),
  ];
  return rows.map((row) => ({
    ...row,
    aliases: [
      ...new Set([
        ...row.aliases,
        ...(row.id === "%Object%" ? ["Object"] : row.id === "%Function%" ? ["Function"] : []),
        ...rows.flatMap((parent) =>
          parent.properties.flatMap((property) => {
            const path =
              parent.id.slice(1, -1) + (property.key.kind === "string" ? "." + property.key.value : "[@@hasInstance]");
            return property.kind === "data"
              ? property.value.kind === "intrinsic" && property.value.id === row.id
                ? [path]
                : []
              : [
                  ...(property.get === row.id ? [path + ".get"] : []),
                  ...(property.set === row.id ? [path + ".set"] : []),
                ];
          }),
        ),
      ]),
    ],
  }));
}
/** Complete retained Object/Function population, including Normative Optional legacy members. */
export const NATIVE_REALM_CATALOG = freeze({
  version: "ecma262-2026:Object+Function:v1" as const,
  intrinsics: catalog(),
  bootstrap: [functionPrototype, throwTypeError],
  remaining: [
    "complete intrinsic descriptor population",
    "immutable Object.prototype",
    "heterogeneous prototype storage",
    "heterogeneous Get/Has/Set",
    "mixed source/builtin/bound invocation",
    "CreateDynamicFunction",
    "public ordinary-object providers",
    "public Number(value) provider",
    "other ECMAScript intrinsic families",
  ],
});
