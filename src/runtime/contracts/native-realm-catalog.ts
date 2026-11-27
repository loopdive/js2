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
  /**
   * (#7354 G1) The realm value whose presence in a realm brings this row: a family's constructor (the Error family's
   * prototypes and methods come with it), or (#7561) the row itself, a wrapper family member a realm holds one by one.
   * A row without one belongs to every realm. What a realm holds, and so the literals it carries, follows this field.
   */
  readonly heldWith?: string;
  /**
   * (#7350 B3a) The realm models only this row's identity and the own properties named here (`length`, `name`,
   * Number's five constants, (#7561) `prototype`): the rest of `properties` (the statics) is catalog data no realm
   * holds yet ({@link modelledRow}). A query that misses the modelled properties is unknown, never absent: the kernel
   * aborts it (`BUILTIN_IDENTITY_ONLY_FLAG`).
   */
  readonly identityOnly?: readonly string[];
  /** (#7350 B3b-0) A wrapper prototype's [[StringData]], [[NumberData]] or [[BooleanData]] (§22.1.3, §21.1.3, §20.3.3). */
  readonly primitiveData?: string | number | boolean;
  /** (#7352) An Array exotic object: %Array.prototype% is itself an array (§23.1.3). */
  readonly array?: true;
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
 * (#7580) The `Object` statics a realm holds as function values, each where the program reads it: the native ones and
 * `getOwnPropertyNames`, whose call is the run-time abort until it is native (#7574 slice 3).
 */
export const HELD_OBJECT_STATICS: readonly string[] = Object.freeze([...NATIVE_OBJECT_STATICS, "getOwnPropertyNames"]);
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
 * (#7574) The Object.prototype methods a realm holds with `Object` (§20.1.3.5-7), each as its own row; the Prepared
 * path answers a call of one by identity (`dynamic-builtin-methods.ts`).
 */
export const NATIVE_OBJECT_PROTOTYPE_CONVERSIONS = Object.freeze(["toLocaleString", "toString", "valueOf"] as const);
export type NativeObjectPrototypeConversion = (typeof NATIVE_OBJECT_PROTOTYPE_CONVERSIONS)[number];
/** (#7574) The catalog id of the root every ordinary object's chain ends at. */
export const OBJECT_PROTOTYPE_ID = objectPrototype;
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
/** (#7350 B3a) The primitive wrapper constructors (§22.1.1, §21.1.1, §20.3.1). */
export const NATIVE_WRAPPER_CONSTRUCTORS = Object.freeze(["String", "Number", "Boolean"] as const);
export type NativeWrapperConstructor = (typeof NATIVE_WRAPPER_CONSTRUCTORS)[number];
/**
 * (#7561) What `js.object.wrapper-data(object, method, selector)` answers: an object's [[StringData]] /
 * [[NumberData]] / [[BooleanData]] (`undefined` for any other object), or thisXValue of `object` where `method` is a
 * held wrapper prototype's `valueOf` / `toString` (`null` for any other method).
 */
export const WRAPPER_DATA = { slot: 0, valueOf: 1, toString: 2 } as const;
/**
 * (#7354 G1, #7352) The brands `js.object.has-brand` tests, each its bit of an ordinary object's flags (bits no legacy
 * object flag uses: those stop at 0x400): [[ErrorData]], an Array exotic object.
 */
export const REALM_BRAND = { error: 0x800, array: 0x1000 } as const;
/** The one answer to "is `parent.name` native": the lists above. */
const NATIVE_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  Object: NATIVE_OBJECT_STATICS,
  "Object.prototype": [...NATIVE_OBJECT_PROTOTYPE_METHODS, ...NATIVE_OBJECT_PROTOTYPE_CONVERSIONS],
  "Error.prototype": ["toString"],
  // (#7561) thisXValue and its ToString (`dynamic-builtin-methods.ts`).
  ...Object.fromEntries(NATIVE_WRAPPER_CONSTRUCTORS.map((name) => [`${name}.prototype`, ["toString", "valueOf"]])),
  // (#7352) IsArray is the realm's brand test; Array's other statics and every method are `unavailable`.
  Array: ["isArray"],
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
/** An Annex B member's property: Normative Optional and legacy. */
const legacyProperty = (row: NativeRealmProperty): NativeRealmProperty => ({
  ...row,
  normativeOptional: true,
  legacy: true,
});
const errorToString: Method = ["toString", 0, ["Get", "ToString"]];

/**
 * (#7354 G1) §20.5.1-20.5.3, §20.5.6: a constructor (length 1, own `prototype` read only; a NativeError's
 * [[Prototype]] is %Error%) and its prototype object (`constructor`, `name`, `message` "", and Error.prototype's
 * `toString`; [[Prototype]] %Object.prototype% for Error.prototype, %Error.prototype% for the others).
 */
function errorRows(name: NativeErrorConstructor): NativeRealmIntrinsic[] {
  const id = `%${name}%`,
    prototype = `%${name}.prototype%`,
    base = name === "Error";
  const ctor = callable(
    id,
    name,
    1,
    name,
    ["OrdinaryCreateFromConstructor", "ToString", "CreateNonEnumerableDataPropertyOrThrow", "InstallErrorCause"],
    [reference("prototype", prototype, false, false)],
    true,
    "native",
  );
  return [
    { ...ctor, aliases: [id, name], ...(base ? {} : { prototype: "%Error%" }) },
    {
      id: prototype,
      aliases: [prototype],
      prototype: base ? objectPrototype : "%Error.prototype%",
      extensible: true,
      immutablePrototype: false,
      constructible: false,
      normativeOptional: false,
      legacy: false,
      properties: [
        reference("constructor", id),
        data("message", { kind: "string", value: "" }),
        data("name", { kind: "string", value: name }),
        ...(base ? methodProperties("Error.prototype", [errorToString]) : []),
      ],
    },
    ...(base ? members("Error.prototype", [errorToString]) : []),
  ].map((row) => ({ ...row, heldWith: id }));
}
/** (#7350 B3a) §21.1.2: the Number value properties the realm models, each {!w, !e, !c}. */
const NUMBER_CONSTANTS: readonly (readonly [name: string, value: number])[] = [
  ["MAX_VALUE", Number.MAX_VALUE],
  ["MIN_VALUE", Number.MIN_VALUE],
  ["NaN", NaN],
  ["NEGATIVE_INFINITY", -Infinity],
  ["POSITIVE_INFINITY", Infinity],
];
/** (#7350 B3b-0) §21.1.2.1, .6, .8: Number's other value properties, {!w, !e, !c}, which no realm models yet. */
const NUMBER_SAFE_CONSTANTS: readonly (readonly [name: string, value: number])[] = [
  ["EPSILON", Number.EPSILON],
  ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
  ["MIN_SAFE_INTEGER", Number.MIN_SAFE_INTEGER],
];
/**
 * (#7350 B3b-0) Each wrapper family's statics (§22.1.2, §21.1.2; Boolean has none) and prototype methods (§22.1.3,
 * §21.1.3, §20.3.3; String's Annex B.2.2 methods in `legacy`). `Number.parseFloat` / `parseInt` are the global
 * functions (§21.1.2.12-13), rows once those are.
 */
const WRAPPER_MEMBERS: Readonly<
  Record<
    NativeWrapperConstructor,
    { statics: readonly Method[]; methods: readonly Method[]; legacy: readonly Method[] }
  >
> = {
  String: {
    statics: [
      ["fromCharCode", 1, ["ToUint16"]],
      ["fromCodePoint", 1, ["ToNumber", "IsIntegralNumber", "UTF16EncodeCodePoint"]],
      ["raw", 1, ["ToObject", "LengthOfArrayLike", "ToString"]],
    ],
    methods: [
      ["at", 1, ["RequireObjectCoercible", "ToString", "ToIntegerOrInfinity"]],
      ["charAt", 1, ["RequireObjectCoercible", "ToString", "ToIntegerOrInfinity"]],
      ["charCodeAt", 1, ["RequireObjectCoercible", "ToString", "ToIntegerOrInfinity"]],
      ["codePointAt", 1, ["RequireObjectCoercible", "ToString", "ToIntegerOrInfinity", "CodePointAt"]],
      ["concat", 1, ["RequireObjectCoercible", "ToString"]],
      ["endsWith", 1, ["RequireObjectCoercible", "ToString", "IsRegExp", "ToIntegerOrInfinity"]],
      ["includes", 1, ["RequireObjectCoercible", "ToString", "IsRegExp", "ToIntegerOrInfinity", "StringIndexOf"]],
      ["indexOf", 1, ["RequireObjectCoercible", "ToString", "ToIntegerOrInfinity", "StringIndexOf"]],
      ["isWellFormed", 0, ["RequireObjectCoercible", "ToString", "IsStringWellFormedUnicode"]],
      [
        "lastIndexOf",
        1,
        ["RequireObjectCoercible", "ToString", "ToNumber", "ToIntegerOrInfinity", "StringLastIndexOf"],
      ],
      ["localeCompare", 1, ["RequireObjectCoercible", "ToString"]],
      ["match", 1, ["RequireObjectCoercible", "GetMethod", "ToString", "RegExpCreate", "Invoke"]],
      ["matchAll", 1, ["RequireObjectCoercible", "IsRegExp", "GetMethod", "ToString", "RegExpCreate", "Invoke"]],
      ["normalize", 0, ["RequireObjectCoercible", "ToString"]],
      ["padEnd", 1, ["RequireObjectCoercible", "StringPaddingBuiltinsImpl"]],
      ["padStart", 1, ["RequireObjectCoercible", "StringPaddingBuiltinsImpl"]],
      ["repeat", 1, ["RequireObjectCoercible", "ToString", "ToIntegerOrInfinity"]],
      ["replace", 2, ["RequireObjectCoercible", "GetMethod", "ToString", "StringIndexOf", "GetSubstitution"]],
      [
        "replaceAll",
        2,
        ["RequireObjectCoercible", "IsRegExp", "GetMethod", "ToString", "StringIndexOf", "GetSubstitution"],
      ],
      ["search", 1, ["RequireObjectCoercible", "GetMethod", "ToString", "RegExpCreate", "Invoke"]],
      ["slice", 2, ["RequireObjectCoercible", "ToString", "ToIntegerOrInfinity"]],
      ["split", 2, ["RequireObjectCoercible", "GetMethod", "ToString", "ToUint32", "CreateArrayFromList"]],
      ["startsWith", 1, ["RequireObjectCoercible", "ToString", "IsRegExp", "ToIntegerOrInfinity"]],
      ["substring", 2, ["RequireObjectCoercible", "ToString", "ToIntegerOrInfinity"]],
      ["toLocaleLowerCase", 0, ["RequireObjectCoercible", "ToString", "TransformCase"]],
      ["toLocaleUpperCase", 0, ["RequireObjectCoercible", "ToString", "TransformCase"]],
      ["toLowerCase", 0, ["RequireObjectCoercible", "ToString", "StringToCodePoints"]],
      ["toString", 0, ["ThisStringValue"]],
      ["toUpperCase", 0, ["RequireObjectCoercible", "ToString", "StringToCodePoints"]],
      ["toWellFormed", 0, ["RequireObjectCoercible", "ToString", "CodePointAt"]],
      ["trim", 0, ["TrimString"]],
      ["trimEnd", 0, ["TrimString"]],
      ["trimStart", 0, ["TrimString"]],
      ["valueOf", 0, ["ThisStringValue"]],
    ],
    legacy: [
      ["substr", 2, ["RequireObjectCoercible", "ToString", "ToIntegerOrInfinity"]],
      ["anchor", 1, ["CreateHTML"]],
      ["big", 0, ["CreateHTML"]],
      ["blink", 0, ["CreateHTML"]],
      ["bold", 0, ["CreateHTML"]],
      ["fixed", 0, ["CreateHTML"]],
      ["fontcolor", 1, ["CreateHTML"]],
      ["fontsize", 1, ["CreateHTML"]],
      ["italics", 0, ["CreateHTML"]],
      ["link", 1, ["CreateHTML"]],
      ["small", 0, ["CreateHTML"]],
      ["strike", 0, ["CreateHTML"]],
      ["sub", 0, ["CreateHTML"]],
      ["sup", 0, ["CreateHTML"]],
    ],
  },
  Number: {
    statics: [
      ["isFinite", 1, ["IsFinite"]],
      ["isInteger", 1, ["IsIntegralNumber"]],
      ["isNaN", 1, ["IsNaN"]],
      ["isSafeInteger", 1, ["IsIntegralNumber"]],
    ],
    methods: [
      ["toExponential", 1, ["ThisNumberValue", "ToIntegerOrInfinity", "RangeError"]],
      ["toFixed", 1, ["ThisNumberValue", "ToIntegerOrInfinity", "RangeError"]],
      ["toLocaleString", 0, ["ThisNumberValue"]],
      ["toPrecision", 1, ["ThisNumberValue", "ToIntegerOrInfinity", "RangeError"]],
      ["toString", 1, ["ThisNumberValue", "ToIntegerOrInfinity", "RangeError", "Number::toString"]],
      ["valueOf", 0, ["ThisNumberValue"]],
    ],
    legacy: [],
  },
  Boolean: {
    statics: [],
    methods: [
      ["toString", 0, ["ThisBooleanValue"]],
      ["valueOf", 0, ["ThisBooleanValue"]],
    ],
    legacy: [],
  },
};
/** (#7352) §23.1.2: Array's statics; only `isArray` (IsArray, the realm's brand test) is native. */
const arrayStatics: readonly Method[] = [
  ["from", 1, ["IteratorToList", "CreateDataPropertyOrThrow"]],
  ["isArray", 1, ["IsArray"]],
  ["of", 0, ["CreateDataPropertyOrThrow"]],
];
/** (#7352) §23.1.3: Array.prototype's methods (`@@iterator` and `@@unscopables` aside), each `unavailable`. */
const arrayMethods: readonly Method[] = (
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
).map(([name, length]): Method => [name, length, ["ToObject", "LengthOfArrayLike"]]);
/**
 * (#7354 G1) The values a Prepared realm can hold, in the order the realm's `js.object.intrinsic(selector)` numbers
 * them: the native Object.prototype methods, the Error constructors, `Error.prototype.toString`, (#7350 B3a) the
 * wrapper constructors, (#7561) their prototype objects and those prototypes' methods, (#7352) `Array`, its prototype,
 * `Array.isArray` and Array.prototype's methods, (#7574) `Object`, the realm's root and the root's methods held with
 * `Object`, (#7580) the statics it holds as values. Positional: new rows are appended.
 */
export const NATIVE_VALUE_INTRINSICS: readonly string[] = Object.freeze([
  ...NATIVE_OBJECT_PROTOTYPE_METHODS.map((name) => realmMethodId("Object.prototype", name)),
  ...NATIVE_ERROR_CONSTRUCTORS.map((name) => `%${name}%`),
  realmMethodId("Error.prototype", errorToString[0]),
  ...NATIVE_WRAPPER_CONSTRUCTORS.map((name) => `%${name}%`),
  ...NATIVE_WRAPPER_CONSTRUCTORS.map((name) => `%${name}.prototype%`),
  ...NATIVE_WRAPPER_CONSTRUCTORS.flatMap((name) =>
    [...WRAPPER_MEMBERS[name].methods, ...WRAPPER_MEMBERS[name].legacy].map(([method]) =>
      realmMethodId(`${name}.prototype`, method),
    ),
  ),
  "%Array%",
  "%Array.prototype%",
  realmMethodId("Array", "isArray"),
  ...arrayMethods.map(([method]) => realmMethodId("Array.prototype", method)),
  "%Object%",
  OBJECT_PROTOTYPE_ID,
  ...NATIVE_OBJECT_PROTOTYPE_CONVERSIONS.map((name) => realmMethodId("Object.prototype", name)),
  ...HELD_OBJECT_STATICS.map((name) => realmMethodId("Object", name)),
]);
/** (#7350 B3b-0) §22.1.3, §21.1.3, §20.3.3: a wrapper prototype's primitive value. */
const WRAPPER_PRIMITIVE_DATA: Readonly<Record<NativeWrapperConstructor, string | number | boolean>> = {
  String: "",
  Number: 0,
  Boolean: false,
};
/** (#7350 B3b-0) Annex B.2.2.15-16: `trimLeft` / `trimRight` are `trimStart` / `trimEnd` themselves. */
const STRING_TRIM_ALIASES: readonly (readonly [name: string, target: string])[] = [
  ["trimLeft", "trimStart"],
  ["trimRight", "trimEnd"],
];
const WRAPPER_REQUIRES: Readonly<Record<NativeWrapperConstructor, readonly string[]>> = {
  String: ["ToString", "SymbolDescriptiveString", "StringCreate", "GetPrototypeFromConstructor"],
  Number: ["ToNumeric", "OrdinaryCreateFromConstructor"],
  Boolean: ["ToBoolean", "OrdinaryCreateFromConstructor"],
};
/**
 * (#7350 B3a, B3b-0) §22.1.1-3, §21.1.1-3, §20.3.1-3, in `errorRows`' shape: a wrapper constructor (length 1; its
 * statics, own `prototype` {!w, !e, !c}, and Number's value properties), its prototype object (the primitive data,
 * `constructor` and the methods; [[Prototype]] %Object.prototype%) and one row per static and method. The constructor
 * stays identity-only: a realm models it, Number's five constants and (#7561) `prototype`, not its statics. (#7561)
 * Each row is held on its own (`heldWith` itself), so a realm holds the members its program reaches.
 */
function wrapperRows(name: NativeWrapperConstructor): NativeRealmIntrinsic[] {
  const id = `%${name}%`,
    prototype = `%${name}.prototype%`,
    { statics, methods, legacy } = WRAPPER_MEMBERS[name];
  const numberData = (rows: typeof NUMBER_CONSTANTS) =>
    name === "Number" ? rows.map(([key, value]) => data(key, { kind: "number", value }, false, false)) : [];
  const modelled = numberData(NUMBER_CONSTANTS);
  const ctor = callable(
    id,
    name,
    1,
    name,
    WRAPPER_REQUIRES[name],
    [
      ...modelled,
      ...numberData(NUMBER_SAFE_CONSTANTS),
      ...methodProperties(name, statics),
      reference("prototype", prototype, false, false),
    ],
    true,
    "native",
  );
  const identity = ["length", "name", ...modelled.map((property) => property.key.value), "prototype"];
  return [
    { ...ctor, aliases: [id, name], identityOnly: identity },
    familyPrototype(name, { primitiveData: WRAPPER_PRIMITIVE_DATA[name] }, [
      // (#7561) §22.1.3: String.prototype is a String exotic object, so it owns StringCreate's `length` (0).
      ...(name === "String" ? [data("length", { kind: "number", value: 0 }, false, false)] : []),
      reference("constructor", id),
      ...methodProperties(`${name}.prototype`, methods),
      ...methodProperties(`${name}.prototype`, legacy).map(legacyProperty),
      ...(name === "String"
        ? STRING_TRIM_ALIASES.map(([alias, target]) =>
            legacyProperty(reference(alias, realmMethodId("String.prototype", target))),
          )
        : []),
    ]),
    ...members(name, statics),
    ...members(`${name}.prototype`, methods),
    ...members(`${name}.prototype`, legacy, true),
  ].map((row) => ({ ...row, heldWith: row.id }));
}
/** The constructor `name`'s prototype object (`%name.prototype%`, [[Prototype]] %Object.prototype%). */
function familyPrototype(
  name: string,
  exotic: Pick<NativeRealmIntrinsic, "primitiveData" | "array">,
  properties: readonly NativeRealmProperty[],
): NativeRealmIntrinsic {
  const id = `%${name}.prototype%`;
  return {
    id,
    aliases: [id],
    prototype: objectPrototype,
    extensible: true,
    immutablePrototype: false,
    constructible: false,
    normativeOptional: false,
    legacy: false,
    ...exotic,
    properties,
  };
}
/**
 * (#7352) §23.1.1-3, in `wrapperRows`' shape: the Array constructor (length 1, identity-only: `length`, `name`,
 * `isArray` and `prototype`), %Array.prototype% (itself an array: its own `length` 0, writable and not configurable,
 * then `constructor` and the methods) and one row per static and method, each held on its own.
 */
function arrayRows(): NativeRealmIntrinsic[] {
  const id = "%Array%";
  const ctor = callable(
    id,
    "Array",
    1,
    "Array",
    ["ArrayCreate", "GetPrototypeFromConstructor", "CreateDataPropertyOrThrow"],
    [...methodProperties("Array", arrayStatics), reference("prototype", "%Array.prototype%", false, false)],
    true,
    "native",
  );
  return [
    { ...ctor, aliases: [id, "Array"], identityOnly: ["length", "name", "isArray", "prototype"] },
    familyPrototype("Array", { array: true }, [
      data("length", { kind: "number", value: 0 }, true, false),
      reference("constructor", id),
      ...methodProperties("Array.prototype", arrayMethods),
    ]),
    ...members("Array", arrayStatics),
    ...members("Array.prototype", arrayMethods),
  ].map((row) => ({ ...row, heldWith: row.id }));
}
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
        ...methodProperties("Object.prototype", legacyMethods).map(legacyProperty),
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
    // (#7574) Held with itself, identity-only: a realm holds its `prototype` and (#7580) the statics it holds as values.
    {
      ...callable(
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
      identityOnly: ["length", "name", "prototype", ...HELD_OBJECT_STATICS],
      heldWith: "%Object%",
    },
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
    ...members("Object.prototype", objectMethods).map((row) =>
      (NATIVE_OBJECT_PROTOTYPE_CONVERSIONS as readonly string[]).includes(row.callable!.initialName)
        ? { ...row, heldWith: row.id }
        : row,
    ),
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
    ...NATIVE_ERROR_CONSTRUCTORS.flatMap(errorRows),
    ...NATIVE_WRAPPER_CONSTRUCTORS.flatMap(wrapperRows),
    ...arrayRows(),
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
 * family; (#7350 B3b-0) the wrapper families and (#7352) the Array family, whose constructors stay identity-only
 * ({@link modelledRow}).
 */
export const NATIVE_REALM_CATALOG = freeze({
  version: "ecma262-2026:Object+Function+Error+Wrappers+Array:v7" as const,
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

/** An identity-only row with only the own properties its `identityOnly` names; any other row itself. */
function modelled(row: NativeRealmIntrinsic): NativeRealmIntrinsic {
  const { identityOnly } = row;
  return identityOnly
    ? freeze({
        ...row,
        properties: row.properties.filter(({ key }) => key.kind === "string" && identityOnly.includes(key.value)),
      })
    : row;
}
const MODELLED_ROWS: ReadonlyMap<string, NativeRealmIntrinsic> = new Map(
  NATIVE_REALM_CATALOG.intrinsics.map((row) => [row.id, modelled(row)]),
);
/**
 * (#7350 B3b-0) What a realm can model of the catalog row `row`: the row itself, or an identity-only constructor with
 * only the own properties its `identityOnly` names. The one gate between a constructor's complete data and what a
 * realm holds of it.
 */
export const modelledRow = (row: NativeRealmIntrinsic): NativeRealmIntrinsic => MODELLED_ROWS.get(row.id)!;
