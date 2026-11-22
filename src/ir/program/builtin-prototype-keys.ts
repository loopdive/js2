// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4) The string-keyed properties the specification (ES2025, Annex B included) gives the built-in prototypes a
 * member read can reach without an own property: Object.prototype for every object and primitive, and each
 * primitive's wrapper prototype. A read of a key outside these, off a value whose prototypes no program code can
 * change, answers the object's own property or `undefined`. The realm's prototypes do not hold these properties yet,
 * so a read of one of them refuses by name; (#7354 P1) but for the Object.prototype methods the catalog marks native.
 *
 * (#7354 M1, C3) Object.prototype's keys are the realm catalog's (`OBJECT_PROTOTYPE_KEYS`, read here for every IR
 * reader, `src/ir/realm-keys.ts` re-exports them); the wrapper prototypes are not in the catalog yet, so their keys
 * are listed here from the specification.
 */
import {
  NATIVE_OBJECT_PROTOTYPE_METHODS,
  NATIVE_REALM_CATALOG,
  realmMethodId,
  type NativeObjectPrototypeMethod,
  type NativeObjectStatic,
  type NativeRealmProperty,
} from "../../runtime/contracts/native-realm-catalog.js";

const propertiesOf = (intrinsicIds: readonly string[]): readonly NativeRealmProperty[] =>
  NATIVE_REALM_CATALOG.intrinsics.filter(({ id }) => intrinsicIds.includes(id)).flatMap(({ properties }) => properties);
const stringKeys = (properties: readonly NativeRealmProperty[]): ReadonlySet<string> =>
  new Set(properties.flatMap(({ key }) => (key.kind === "string" ? [key.value] : [])));

/** The catalog `length` of every callable the catalog marks native, by id: built once, read per member access. */
const NATIVE_LENGTHS: ReadonlyMap<string, number> = new Map(
  NATIVE_REALM_CATALOG.intrinsics.flatMap(({ id, callable }) =>
    callable?.implementation === "native" ? [[id, callable.length] as const] : [],
  ),
);
/** The catalog `length` of `parent.name` when the catalog marks it native. */
const nativeLength = (parent: string, name: string): number | undefined =>
  NATIVE_LENGTHS.get(realmMethodId(parent, name));

/**
 * (#7354 O1) `Object.<name>` with its catalog `length` when the catalog marks it native (`NATIVE_OBJECT_STATICS`): the
 * IR's one read of which statics the Prepared path lowers.
 */
export function nativeObjectStatic(
  name: string,
): { readonly name: NativeObjectStatic; readonly length: number } | undefined {
  const length = nativeLength("Object", name);
  return length === undefined ? undefined : { name: name as NativeObjectStatic, length };
}

/**
 * (#7354 P1) `name` when the catalog marks `%Object.prototype.<name>%` native: the realm's Object.prototype holds it as
 * a built-in function object (`NATIVE_OBJECT_PROTOTYPE_METHODS`).
 */
export const nativeObjectPrototypeMethod = (name: string): NativeObjectPrototypeMethod | undefined =>
  nativeLength("Object.prototype", name) === undefined ? undefined : (name as NativeObjectPrototypeMethod);

/** (#7354 P1) The realm's selector of a native Object.prototype method (`js.object.prototype-method`). */
export const prototypeMethodSelector = (name: NativeObjectPrototypeMethod): number =>
  NATIVE_OBJECT_PROTOTYPE_METHODS.indexOf(name);

/** The string keys the catalog gives the named intrinsics (Annex B members included). */
export function realmStringKeys(...intrinsicIds: readonly string[]): ReadonlySet<string> {
  return stringKeys(propertiesOf(intrinsicIds));
}

/** The string keys `Object.prototype` owns (§20.1.3, Annex B.2.2 included). */
export const OBJECT_PROTOTYPE_KEYS = realmStringKeys("%Object.prototype%");

const accessorKeys = (...intrinsicIds: readonly string[]): ReadonlySet<string> =>
  stringKeys(propertiesOf(intrinsicIds).filter((property) => property.kind === "accessor"));

/** (#7354 M1, C6) The string keys `Object.prototype` holds as accessor properties (Annex B.2.2.1 `__proto__`). */
export const OBJECT_PROTOTYPE_ACCESSOR_KEYS = accessorKeys("%Object.prototype%");

/**
 * (#7354 G1) The accessor keys `Function.prototype` adds on a function's chain: `caller` and `arguments`, whose
 * setter is %ThrowTypeError% (§10.2.4, AddRestrictedFunctionProperties).
 */
export const FUNCTION_PROTOTYPE_ACCESSOR_KEYS = accessorKeys("%Function.prototype%");

const NUMBER_PROTOTYPE = ["toExponential", "toFixed", "toPrecision"];
const STRING_PROTOTYPE = [
  "at",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "concat",
  "endsWith",
  "includes",
  "indexOf",
  "isWellFormed",
  "lastIndexOf",
  "localeCompare",
  "match",
  "matchAll",
  "normalize",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "search",
  "slice",
  "split",
  "startsWith",
  "substring",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toUpperCase",
  "toWellFormed",
  "trim",
  "trimEnd",
  "trimStart",
  "substr",
  "anchor",
  "big",
  "blink",
  "bold",
  "fixed",
  "fontcolor",
  "fontsize",
  "italics",
  "link",
  "small",
  "strike",
  "sub",
  "sup",
  "trimLeft",
  "trimRight",
];

/** (#7354 P1) Object.prototype's keys the realm's Object.prototype does not hold. */
const UNPOPULATED_OBJECT_PROTOTYPE_KEYS = new Set(
  [...OBJECT_PROTOTYPE_KEYS].filter((key) => nativeObjectPrototypeMethod(key) === undefined),
);

/**
 * (#7354 F1b) The keys a read of a source function reaches on Function.prototype and Object.prototype: every key the
 * catalog gives them but `length` and `name`, which every function value owns from its creation.
 */
const FUNCTION_REACHABLE_KEYS = new Set(
  [...realmStringKeys("%Function.prototype%"), ...UNPOPULATED_OBJECT_PROTOTYPE_KEYS].filter(
    (key) => key !== "length" && key !== "name",
  ),
);

/**
 * The keys a read of each value reaches through built-in prototypes (or, for a string, its own exotic keys) that the
 * realm does not hold. (#7354 P1) The methods it holds on Object.prototype are not among them: the realm's [[Get]]
 * finds them on an object's chain, and every other kind's prototypes lack them.
 */
export const BUILTIN_REACHABLE_KEYS = {
  object: UNPOPULATED_OBJECT_PROTOTYPE_KEYS,
  function: FUNCTION_REACHABLE_KEYS,
  number: new Set([...UNPOPULATED_OBJECT_PROTOTYPE_KEYS, ...NUMBER_PROTOTYPE]),
  boolean: UNPOPULATED_OBJECT_PROTOTYPE_KEYS,
  string: new Set([...UNPOPULATED_OBJECT_PROTOTYPE_KEYS, ...STRING_PROTOTYPE, "length"]),
} as const satisfies Readonly<Record<string, ReadonlySet<string>>>;

/** A canonical array index (§6.1.7): a string's own indexed character. */
export function isArrayIndexKey(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}
