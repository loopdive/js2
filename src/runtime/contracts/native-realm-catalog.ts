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
export type NativeRealmPrimitive =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean };
export interface NativeRealmIntrinsic {
  readonly id: string;
  /**
   * (#7354 G1) The constructor whose presence in a realm brings this row (its prototype, a method of that prototype):
   * a row without one belongs to every realm. What a realm holds, and so the literals it carries, follows this field.
   */
  readonly heldWith?: string;
  readonly aliases: readonly string[];
  readonly prototype: string | null;
  readonly extensible: boolean;
  readonly immutablePrototype: boolean;
  readonly constructible: boolean;
  readonly normativeOptional: boolean;
  readonly legacy: boolean;
  readonly properties: readonly NativeRealmProperty[];
  /** (#7354 W2) A non-callable row's [[StringData]] / [[NumberData]] / [[BooleanData]]: a wrapper prototype's. */
  readonly primitive?: NativeRealmPrimitive;
  /** (#7354 A1) An Array exotic object: %Array.prototype% is itself an array (§23.1.3). */
  readonly array?: true;
  readonly callable?: {
    readonly initialName: string;
    readonly length: number;
    readonly algorithm: string;
    /**
     * (#7354 O1) `native`: the Prepared path lowers the built-in's call form (`src/ir/realm-static-call.ts`); (P1, G1)
     * for a member of {@link NATIVE_VALUE_INTRINSICS}, the realm also holds it as a function object.
     */
    readonly implementation: "function-prototype" | "throw-type-error" | "native" | "unavailable";
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
/**
 * (#7354 O1) The `Object` statics whose call form the Prepared path lowers: the realm's descriptor bodies serve them
 * (`object-static-bodies.ts`). With {@link NATIVE_OBJECT_PROTOTYPE_METHODS}, the lists of what is native; every other
 * row is `unavailable`.
 */
const NATIVE_OBJECT_STATICS = Object.freeze([
  "create",
  "defineProperties",
  "defineProperty",
  "getOwnPropertyDescriptor",
] as const);
export type NativeObjectStatic = (typeof NATIVE_OBJECT_STATICS)[number];
/**
 * (#7354 P1) The Object.prototype methods the realm populates: each is a built-in function object on the realm's
 * Object.prototype, and the Prepared path writes its algorithm where a call reads it (`dynamic-prototype-methods.ts`).
 */
export const NATIVE_OBJECT_PROTOTYPE_METHODS = Object.freeze([
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
] as const);
export type NativeObjectPrototypeMethod = (typeof NATIVE_OBJECT_PROTOTYPE_METHODS)[number];
/**
 * (#7557) The Function.prototype methods the realm holds as values, for its built-in caller to answer (`call`; a call
 * of `apply` or `bind` is the caller's run-time abort until its rung exists).
 */
export const NATIVE_FUNCTION_PROTOTYPE_METHODS = Object.freeze(["call", "apply", "bind"] as const);
/** (#7354 G1) The Error constructors (§20.5.1, §20.5.6.1): `Error` first, then the six NativeErrors. */
export const NATIVE_ERROR_CONSTRUCTORS = Object.freeze([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
] as const);
export type NativeErrorConstructor = (typeof NATIVE_ERROR_CONSTRUCTORS)[number];
/**
 * (#7354 W2) The primitive wrapper constructors (§22.1.1, §21.1.1, §20.3.1), in the order of their selector
 * (`js.object.create-wrapper`): each wrapper is #3518's subtype of the ordinary object with the primitive in its slot.
 */
export const NATIVE_WRAPPER_CONSTRUCTORS = Object.freeze(["String", "Number", "Boolean"] as const);
export type NativeWrapperConstructor = (typeof NATIVE_WRAPPER_CONSTRUCTORS)[number];
/**
 * (#7354 W2) The wrapper of each primitive type (the type of its [[StringData]] / [[NumberData]] / [[BooleanData]]
 * slot): the one map between a primitive kind and its wrapper.
 */
export const WRAPPER_OF_PRIMITIVE = Object.freeze({
  string: "String",
  number: "Number",
  boolean: "Boolean",
} as const satisfies Record<string, NativeWrapperConstructor>);
/** (#7354 W2) The questions `js.object.wrapper-data` answers (its selector): a slot, or a wrapper method's thisXValue. */
export const WRAPPER_DATA = Object.freeze({ slot: 0, valueOf: 1, toString: 2 } as const);
/** (#7354 G1, A1) The brands `js.object.has-brand` tests (its selector): [[ErrorData]], an Array exotic object. */
export const REALM_BRAND = Object.freeze({ error: 0, array: 1 } as const);
/** The one answer to "is `parent.name` native": the lists above. */
const NATIVE_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  Object: NATIVE_OBJECT_STATICS,
  "Object.prototype": NATIVE_OBJECT_PROTOTYPE_METHODS,
  "Error.prototype": ["toString"],
  "Function.prototype": NATIVE_FUNCTION_PROTOTYPE_METHODS,
  // (#7354 A1) Array's methods come with A1b; IsArray is the realm's brand test.
  Array: ["isArray"],
  ...Object.fromEntries(NATIVE_WRAPPER_CONSTRUCTORS.map((name) => [name + ".prototype", ["toString", "valueOf"]])),
};
const isNativeMember = (parent: string, name: string): boolean => NATIVE_MEMBERS[parent]?.includes(name) === true;
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
/** The catalog id of the member `name` of the intrinsic `parent` (`%Object.prototype.hasOwnProperty%`). */
export const realmMethodId = (parent: string, name: string) => `%${parent}.${name}%`;
function members(parent: string, rows: readonly Method[], legacy = false): NativeRealmIntrinsic[] {
  return rows.map(([name, length, requires]) =>
    callable(
      realmMethodId(parent, name),
      name,
      length,
      parent + "." + name,
      requires,
      [],
      false,
      isNativeMember(parent, name) ? "native" : "unavailable",
      legacy,
    ),
  );
}
const methodProperties = (parent: string, rows: readonly Method[]) =>
  rows.map(([name]) => reference(name, realmMethodId(parent, name)));
const errorToString: Method = ["toString", 0, ["Get", "ToString"]];
const wrapperId = (name: NativeWrapperConstructor) => `%${name}%`;
/**
 * (#7354 G1, W2) The values a Prepared realm can hold, in the order the realm's `js.object.intrinsic(selector)` numbers
 * them: the native Object.prototype methods, the Error constructors, `Error.prototype.toString`, `Object`, the wrapper
 * constructors and their native methods (function values, which the realm holds as entries), then the prototype
 * objects a primitive's member read goes through (ordinary objects).
 */
export const NATIVE_VALUE_INTRINSICS: readonly string[] = Object.freeze([
  ...NATIVE_OBJECT_PROTOTYPE_METHODS.map((name) => realmMethodId("Object.prototype", name)),
  ...NATIVE_ERROR_CONSTRUCTORS.map((name) => `%${name}%`),
  realmMethodId("Error.prototype", errorToString[0]),
  "%Object%",
  ...NATIVE_WRAPPER_CONSTRUCTORS.map(wrapperId),
  ...NATIVE_WRAPPER_CONSTRUCTORS.flatMap((name) =>
    NATIVE_MEMBERS[name + ".prototype"]!.map((method) => realmMethodId(name + ".prototype", method)),
  ),
  objectPrototype,
  ...NATIVE_WRAPPER_CONSTRUCTORS.map((name) => `%${name}.prototype%`),
  // (#7354 A1) Appended, so every earlier selector stays.
  "%Array%",
  realmMethodId("Array", "isArray"),
  "%Array.prototype%",
  // (#7557) `Function` and the Function.prototype methods a call through a value answers.
  "%Function%",
  ...NATIVE_FUNCTION_PROTOTYPE_METHODS.map((name) => realmMethodId("Function.prototype", name)),
]);
/** An intrinsic family (#7354 G1, W2): a constructor, its prototype object, and the members both own. */
interface Family {
  readonly name: string;
  readonly requires: readonly string[];
  /** The constructor's [[Prototype]] when it is not %Function.prototype% (a NativeError's: %Error%). */
  readonly constructorParent?: string;
  readonly statics?: readonly Method[];
  readonly staticData?: readonly NativeRealmProperty[];
  readonly prototypeParent: string;
  readonly prototypeData: readonly NativeRealmProperty[];
  readonly methods: readonly Method[];
  /** The prototype object's own primitive slot (a wrapper prototype is itself a wrapper, §22.1.3 …). */
  readonly primitive?: NativeRealmPrimitive;
  /** (#7354 A1) The prototype object is itself an Array exotic object (§23.1.3). */
  readonly array?: true;
}
/**
 * A family's rows, each `heldWith` its constructor: the constructor (length 1, own `prototype` read only), its statics,
 * its prototype object (`constructor`, the family's data, its methods), and the methods.
 */
function familyRows(family: Family): NativeRealmIntrinsic[] {
  const { name } = family,
    id = `%${name}%`,
    prototype = `%${name}.prototype%`;
  const ctor = callable(
    id,
    name,
    1,
    name,
    family.requires,
    [
      reference("prototype", prototype, false, false),
      ...methodProperties(name, family.statics ?? []),
      ...(family.staticData ?? []),
    ],
    true,
    "native",
  );
  return [
    { ...ctor, aliases: [id, name], ...(family.constructorParent ? { prototype: family.constructorParent } : {}) },
    ...members(name, family.statics ?? []),
    {
      id: prototype,
      aliases: [prototype],
      prototype: family.prototypeParent,
      extensible: true,
      immutablePrototype: false,
      constructible: false,
      normativeOptional: false,
      legacy: false,
      ...(family.primitive ? { primitive: family.primitive } : {}),
      ...(family.array ? { array: true as const } : {}),
      properties: [
        reference("constructor", id),
        ...family.prototypeData,
        ...methodProperties(name + ".prototype", family.methods),
      ],
    },
    ...members(name + ".prototype", family.methods),
  ].map((row) => ({ ...row, heldWith: id }));
}
/**
 * (#7354 G1) §20.5.1-20.5.3, §20.5.6: a NativeError's [[Prototype]] is %Error% and its prototype's %Error.prototype%;
 * each prototype has `message` "" and its `name`, Error.prototype also `toString`.
 */
const errorFamily = (name: NativeErrorConstructor): Family => ({
  name,
  requires: [
    "OrdinaryCreateFromConstructor",
    "ToString",
    "CreateNonEnumerableDataPropertyOrThrow",
    "InstallErrorCause",
  ],
  ...(name === "Error" ? {} : { constructorParent: "%Error%" }),
  prototypeParent: name === "Error" ? objectPrototype : "%Error.prototype%",
  prototypeData: [data("message", { kind: "string", value: "" }), data("name", { kind: "string", value: name })],
  methods: name === "Error" ? [errorToString] : [],
});
const constant = (name: string, value: number) => data(name, { kind: "number", value }, false, false);
/** (#7354 W2) §22.1, §21.1, §20.3: the wrapper families, their statics and prototype methods (Annex B included). */
const WRAPPER_FAMILIES: Readonly<Record<NativeWrapperConstructor, Family>> = {
  String: {
    name: "String",
    requires: ["ToString", "StringCreate", "GetPrototypeFromConstructor"],
    statics: [
      ["fromCharCode", 1, ["ToUint16"]],
      ["fromCodePoint", 1, ["ToNumber"]],
      ["raw", 1, ["ToObject", "Get", "ToString"]],
    ],
    prototypeParent: objectPrototype,
    prototypeData: [data("length", { kind: "number", value: 0 }, false, false)],
    primitive: { kind: "string", value: "" },
    methods: (
      [
        ["at", 1],
        ["charAt", 1],
        ["charCodeAt", 1],
        ["codePointAt", 1],
        ["concat", 1],
        ["endsWith", 1],
        ["includes", 1],
        ["indexOf", 1],
        ["isWellFormed", 0],
        ["lastIndexOf", 1],
        ["localeCompare", 1],
        ["match", 1],
        ["matchAll", 1],
        ["normalize", 0],
        ["padEnd", 1],
        ["padStart", 1],
        ["repeat", 1],
        ["replace", 2],
        ["replaceAll", 2],
        ["search", 1],
        ["slice", 2],
        ["split", 2],
        ["startsWith", 1],
        ["substring", 2],
        ["toLocaleLowerCase", 0],
        ["toLocaleUpperCase", 0],
        ["toLowerCase", 0],
        ["toString", 0],
        ["toUpperCase", 0],
        ["toWellFormed", 0],
        ["trim", 0],
        ["trimEnd", 0],
        ["trimStart", 0],
        ["valueOf", 0],
        ["substr", 2],
        ["anchor", 1],
        ["big", 0],
        ["blink", 0],
        ["bold", 0],
        ["fixed", 0],
        ["fontcolor", 1],
        ["fontsize", 1],
        ["italics", 0],
        ["link", 1],
        ["small", 0],
        ["strike", 0],
        ["sub", 0],
        ["sup", 0],
        ["trimLeft", 0],
        ["trimRight", 0],
      ] as const
    ).map(([name, length]): Method => [name, length, ["RequireObjectCoercible", "ToString"]]),
  },
  Number: {
    name: "Number",
    requires: ["ToNumeric", "OrdinaryCreateFromConstructor"],
    statics: [
      ["isFinite", 1, ["IsFiniteNumber"]],
      ["isInteger", 1, ["IsIntegralNumber"]],
      ["isNaN", 1, ["IsNaN"]],
      ["isSafeInteger", 1, ["IsIntegralNumber"]],
      ["parseFloat", 1, ["ToString", "TrimString"]],
      ["parseInt", 2, ["ToString", "TrimString", "ToInt32"]],
    ],
    staticData: [
      constant("EPSILON", Number.EPSILON),
      constant("MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER),
      constant("MAX_VALUE", Number.MAX_VALUE),
      constant("MIN_SAFE_INTEGER", Number.MIN_SAFE_INTEGER),
      constant("MIN_VALUE", Number.MIN_VALUE),
      constant("NaN", NaN),
      constant("NEGATIVE_INFINITY", -Infinity),
      constant("POSITIVE_INFINITY", Infinity),
    ],
    prototypeParent: objectPrototype,
    prototypeData: [],
    primitive: { kind: "number", value: 0 },
    methods: [
      ["toExponential", 1, ["ThisNumberValue", "ToIntegerOrInfinity"]],
      ["toFixed", 1, ["ThisNumberValue", "ToIntegerOrInfinity"]],
      ["toLocaleString", 0, ["ThisNumberValue"]],
      ["toPrecision", 1, ["ThisNumberValue", "ToIntegerOrInfinity"]],
      ["toString", 1, ["ThisNumberValue", "Number::toString"]],
      ["valueOf", 0, ["ThisNumberValue"]],
    ],
  },
  Boolean: {
    name: "Boolean",
    requires: ["ToBoolean", "OrdinaryCreateFromConstructor"],
    prototypeParent: objectPrototype,
    prototypeData: [],
    primitive: { kind: "boolean", value: false },
    methods: [
      ["toString", 0, ["ThisBooleanValue"]],
      ["valueOf", 0, ["ThisBooleanValue"]],
    ],
  },
};
/**
 * (#7354 A1) §23.1: the Array family. %Array.prototype% is itself an array (its own `length` 0, writable, not
 * configurable); its methods (`@@iterator` and `@@unscopables` aside) and the statics but `isArray` are `unavailable`.
 */
const ARRAY_FAMILY: Family = {
  name: "Array",
  requires: ["ArrayCreate", "GetPrototypeFromConstructor", "CreateDataPropertyOrThrow"],
  statics: [
    ["from", 1, ["IteratorToList", "CreateDataPropertyOrThrow"]],
    ["isArray", 1, ["IsArray"]],
    ["of", 0, ["CreateDataPropertyOrThrow"]],
  ],
  prototypeParent: objectPrototype,
  prototypeData: [data("length", { kind: "number", value: 0 }, true, false)],
  array: true,
  methods: (
    [
      ["at", 1],
      ["concat", 1],
      ["copyWithin", 2],
      ["entries", 0],
      ["every", 1],
      ["fill", 1],
      ["filter", 1],
      ["find", 1],
      ["findIndex", 1],
      ["findLast", 1],
      ["findLastIndex", 1],
      ["flat", 0],
      ["flatMap", 1],
      ["forEach", 1],
      ["includes", 1],
      ["indexOf", 1],
      ["join", 1],
      ["keys", 0],
      ["lastIndexOf", 1],
      ["map", 1],
      ["pop", 0],
      ["push", 1],
      ["reduce", 1],
      ["reduceRight", 1],
      ["reverse", 0],
      ["shift", 0],
      ["slice", 2],
      ["some", 1],
      ["sort", 1],
      ["splice", 2],
      ["toLocaleString", 0],
      ["toReversed", 0],
      ["toSorted", 1],
      ["toSpliced", 2],
      ["toString", 0],
      ["unshift", 1],
      ["values", 0],
      ["with", 2],
    ] as const
  ).map(([name, length]): Method => [name, length, ["ToObject", "LengthOfArrayLike"]]),
};
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
      "native",
    ),
    callable(
      "%Function%",
      "Function",
      1,
      "CreateDynamicFunction",
      ["HostEnsureCanCompileStrings", "ParseText", "OrdinaryFunctionCreate", "MakeConstructor"],
      [reference("prototype", functionPrototype, false, false)],
      true,
      // (#7557) Held as a value (`Function.prototype`); a call or `new` of it is the built-in arm's run-time abort.
      "native",
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
    ...NATIVE_ERROR_CONSTRUCTORS.map(errorFamily).flatMap(familyRows),
    ...NATIVE_WRAPPER_CONSTRUCTORS.map((name) => WRAPPER_FAMILIES[name]).flatMap(familyRows),
    ...familyRows(ARRAY_FAMILY),
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
/**
 * Complete retained Object/Function population, including Normative Optional legacy members; (#7354 G1) the Error
 * family; (W2) the String, Number and Boolean families; (A1) the Array family.
 */
export const NATIVE_REALM_CATALOG = freeze({
  version: "ecma262-2026:Object+Function+Error+wrappers+Array:v4" as const,
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
