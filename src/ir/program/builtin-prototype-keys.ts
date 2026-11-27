// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4) The string-keyed properties the specification (ES2025, Annex B included) gives the built-in prototypes a
 * member read can reach without an own property: Object.prototype for every object and primitive, and each
 * primitive's wrapper prototype. A read of a key outside these, off a value whose prototypes no program code can
 * change, answers the object's own property or `undefined`. The realm's prototypes do not hold these properties yet,
 * so a read of one of them refuses by name; (#7354 P1) but for the Object.prototype methods the catalog marks native.
 *
 * (#7354 M1, C3) Object.prototype's keys are the realm catalog's (`OBJECT_PROTOTYPE_KEYS`, read here for every IR
 * reader, `src/ir/realm-keys.ts` re-exports them); (#7354 W2) so are the wrapper prototypes'.
 */
import {
  NATIVE_ERROR_CONSTRUCTORS,
  NATIVE_REALM_CATALOG,
  NATIVE_VALUE_INTRINSICS,
  NATIVE_WRAPPER_CONSTRUCTORS,
  REALM_BRAND,
  WRAPPER_DATA,
  WRAPPER_OF_PRIMITIVE,
  realmMethodId,
  type NativeObjectPrototypeMethod,
  type NativeObjectStatic,
  type NativeWrapperConstructor,
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

/** (#7354 P1) The catalog id of the native Object.prototype method `name`. */
export const objectPrototypeMethodId = (name: NativeObjectPrototypeMethod): string =>
  realmMethodId("Object.prototype", name);

/** (#7354 G1) The catalog ids of `%Error%` and of `Error.prototype.toString`. */
export const ERROR_ID = "%Error%";
export const ERROR_TO_STRING_ID = realmMethodId("Error.prototype", "toString");

/**
 * (#7354 G1) The catalog id of the Error constructor `name` names (`NATIVE_ERROR_CONSTRUCTORS`), if it names one: the
 * IR's one read of which global names are the realm's Error constructors.
 */
export const errorConstructorId = (name: string): string | undefined =>
  (NATIVE_ERROR_CONSTRUCTORS as readonly string[]).includes(name) ? `%${name}%` : undefined;

/**
 * (#7354 W2) The catalog id of the realm constructor the global `name` names, if it names one: an Error constructor,
 * a wrapper constructor (`NATIVE_WRAPPER_CONSTRUCTORS`), `Object` or (#7354 A1) `Array`. The IR's one read of which global names read
 * realm constructors (`identifier-read.ts`).
 */
export const realmConstructorId = (name: string): string | undefined =>
  errorConstructorId(name) ??
  (name === "Object" || name === "Array" || (NATIVE_WRAPPER_CONSTRUCTORS as readonly string[]).includes(name)
    ? `%${name}%`
    : undefined);

/** (#7354 A1) The catalog ids of `%Array%` and `Array.isArray`. */
export const ARRAY_ID = "%Array%";
export const IS_ARRAY_ID = realmMethodId("Array", "isArray");

/** (#7354 A1) Whether the realm holds the static `path` (`"Array.isArray"`) as a function value. */
export const realmHoldsStatic = (path: string): boolean => NATIVE_VALUE_INTRINSICS.includes(`%${path}%`);

/**
 * (#7354 W2) The catalog's wrapper tables, for every IR reader (this module is the IR's one reader of the catalog): the
 * wrapper of each primitive kind, the wrapper constructors in selector order, and `js.object.wrapper-data`'s questions.
 */
export { NATIVE_WRAPPER_CONSTRUCTORS, REALM_BRAND, WRAPPER_DATA, WRAPPER_OF_PRIMITIVE };

/** (#7354 W2) The wrapper constructors' catalog ids, in selector order. */
export const WRAPPER_IDS: readonly string[] = NATIVE_WRAPPER_CONSTRUCTORS.map((name) => `%${name}%`);

/** (#7354 W2) The wrapper constructor `id`'s selector (`js.object.create-wrapper`), or -1. */
export const wrapperConstructorSelector = (id: string): number =>
  NATIVE_WRAPPER_CONSTRUCTORS.findIndex((name) => `%${name}%` === id);

/** (#7354 G1) The Error constructor `id`'s selector (`js.object.create-error`), or -1. */
export const errorConstructorSelector = (id: string): number =>
  NATIVE_ERROR_CONSTRUCTORS.findIndex((name) => `%${name}%` === id);

/** (#7354 G1) The Error constructor's name a `js.object.create-error` selector stands for. */
export const errorConstructorName = (selector: number): string => NATIVE_ERROR_CONSTRUCTORS[selector]!;

/**
 * (#7354 G1) The global names the realm serves a built-in for (`Object`, `Function`, the Error constructors): the
 * catalog's plain-name aliases.
 */
export const REALM_GLOBAL_NAMES: ReadonlySet<string> = new Set(
  NATIVE_REALM_CATALOG.intrinsics.flatMap(({ aliases }) => aliases.filter((alias) => /^[A-Za-z]+$/.test(alias))),
);

/** (#7354 P1, G1) The realm's selector of the built-in function object `id` (`js.object.intrinsic`). */
export const realmIntrinsicSelector = (id: string): number => NATIVE_VALUE_INTRINSICS.indexOf(id);

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

/** The catalog's ordinary objects (a family's prototype objects): the realm holds each with its family. */
const CATALOG_OBJECTS: ReadonlySet<string> = new Set(
  NATIVE_REALM_CATALOG.intrinsics.flatMap(({ id, callable }) => (callable === undefined ? [id] : [])),
);

/**
 * The catalog's string keys of `id` whose value the realm can hold: data, a function value of
 * `NATIVE_VALUE_INTRINSICS`, or an ordinary object of the catalog.
 */
function holdableKeys(id: string): ReadonlySet<string> {
  return stringKeys(
    propertiesOf([id]).filter(
      (property) =>
        property.kind === "data" &&
        (property.value.kind !== "intrinsic" ||
          NATIVE_VALUE_INTRINSICS.includes(property.value.id) ||
          CATALOG_OBJECTS.has(property.value.id)),
    ),
  );
}

/** (#7354 W2, A1) The families whose objects have a prototype of the catalog's: the wrappers and Array. */
const PROTOTYPE_FAMILIES = [...NATIVE_WRAPPER_CONSTRUCTORS, "Array"] as const;
type PrototypeFamily = (typeof PROTOTYPE_FAMILIES)[number];

/**
 * (#7354 W2) Each family prototype's keys (§22.1.3, §21.1.3, §20.3.3, (A1) §23.1.3, Annex B included), from the
 * catalog, and those the realm holds where it holds the family (`constructor`, `toString`, `valueOf`, String.prototype's
 * and Array.prototype's `length`).
 */
const FAMILY_PROTOTYPE_KEYS = Object.fromEntries(
  PROTOTYPE_FAMILIES.map((name) => {
    const id = `%${name}.prototype%`;
    return [name, { all: realmStringKeys(id), held: holdableKeys(id) }];
  }),
) as Readonly<Record<PrototypeFamily, { readonly all: ReadonlySet<string>; readonly held: ReadonlySet<string> }>>;

/**
 * (#7354 W2, A1) The keys a read of a held family's object reaches on its prototype that the realm does not hold
 * (`String.prototype.charAt`, `Array.prototype.map`): an object that may belong to a family of `families` (catalog ids
 * of constructors) finds them only on its own or source-built chain.
 */
export function unheldFamilyPrototypeKeys(families: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(
    PROTOTYPE_FAMILIES.filter((name) => families.has(`%${name}%`)).flatMap((name) => {
      const { all, held } = FAMILY_PROTOTYPE_KEYS[name];
      return [...all].filter((key) => !held.has(key));
    }),
  );
}

/** (#7354 W2) Whether the realm holds `key` on the wrapper prototype `name` where it holds the family. */
export const heldWrapperPrototypeKey = (name: NativeWrapperConstructor, key: string): boolean =>
  FAMILY_PROTOTYPE_KEYS[name].held.has(key);

/**
 * (#7354 W2) The statics of the realm constructors `constructors` (catalog ids) the realm does not hold
 * (`Object.keys`, `String.fromCharCode`, `Number.isNaN`): a read or write of one on a value that may be a function
 * refuses by name, as the realm's constructor lacks the property.
 */
export function unheldStaticKeys(constructors: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(
    [...constructors].flatMap((id) => {
      const held = holdableKeys(id);
      return [...realmStringKeys(id)].filter((key) => !held.has(key));
    }),
  );
}

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
  number: new Set([...UNPOPULATED_OBJECT_PROTOTYPE_KEYS, ...FAMILY_PROTOTYPE_KEYS.Number.all]),
  boolean: new Set([...UNPOPULATED_OBJECT_PROTOTYPE_KEYS, ...FAMILY_PROTOTYPE_KEYS.Boolean.all]),
  string: new Set([...UNPOPULATED_OBJECT_PROTOTYPE_KEYS, ...FAMILY_PROTOTYPE_KEYS.String.all]),
} as const satisfies Readonly<Record<string, ReadonlySet<string>>>;

/** A canonical array index (§6.1.7): a string's own indexed character. */
export function isArrayIndexKey(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}
