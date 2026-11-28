// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4) The string-keyed properties the specification (ES2025, Annex B included) gives the built-in prototypes a
 * member read can reach without an own property: Object.prototype for every object and primitive, and each
 * primitive's wrapper prototype. A read of a key outside these, off a value whose prototypes no program code can
 * change, answers the object's own property or `undefined`. The realm's prototypes do not hold these properties yet,
 * so a read of one of them refuses by name; (#7354 P1) but for the Object.prototype methods the catalog marks native.
 *
 * (#7354 M1, C3) Object.prototype's keys, and (#7561) the wrapper prototypes', are the realm catalog's
 * (`OBJECT_PROTOTYPE_KEYS`, read here for every IR reader, `src/ir/realm-keys.ts` re-exports them).
 */
import {
  NATIVE_ERROR_CONSTRUCTORS,
  NATIVE_REALM_CATALOG,
  NATIVE_VALUE_INTRINSICS,
  NATIVE_WRAPPER_CONSTRUCTORS,
  WRAPPER_DATA,
  modelledRow,
  realmMethodId,
  type NativeErrorConstructor,
  type NativeObjectPrototypeMethod,
  type NativeObjectStatic,
  type NativeRealmProperty,
  type NativeWrapperConstructor,
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
/** (#7609) The catalog id of the global object. */
export { GLOBAL_OBJECT_ID } from "../../runtime/contracts/native-realm-catalog.js";

/** (#7350 B3a) The realm's constructor families and their names: (#7354 G1) the Error constructors, the wrappers. */
interface RealmFamilyNames {
  readonly error: NativeErrorConstructor;
  readonly wrapper: NativeWrapperConstructor;
}
export type RealmFamily = keyof RealmFamilyNames;
/**
 * A constructor the realm serves: its global name, catalog id (`%name%`), family, and selector within the family's
 * list (`NATIVE_ERROR_CONSTRUCTORS` for `js.object.create-error`, `NATIVE_WRAPPER_CONSTRUCTORS`).
 */
interface FamilyConstructor<F extends RealmFamily> {
  readonly name: RealmFamilyNames[F];
  readonly id: string;
  readonly family: F;
  readonly selector: number;
}
/** (#7350 B3b-0) {@link FamilyConstructor} as a union by family, so a test of `family` narrows `name`. */
export type RealmConstructor<F extends RealmFamily = RealmFamily> = F extends RealmFamily
  ? FamilyConstructor<F>
  : never;
const constructors = <F extends RealmFamily>(family: F, names: readonly RealmFamilyNames[F][]) =>
  names.map((name, selector): [string, FamilyConstructor<F>] => [name, { name, id: `%${name}%`, family, selector }]);
const REALM_CONSTRUCTORS: ReadonlyMap<string, RealmConstructor> = new Map<string, RealmConstructor>([
  ...constructors("error", NATIVE_ERROR_CONSTRUCTORS),
  ...constructors("wrapper", NATIVE_WRAPPER_CONSTRUCTORS),
]);

/**
 * (#7350 B3a) `X(v)` of a wrapper constructor with NewTarget undefined (§22.1.1.1, §21.1.1.1, §20.3.1.1): ToString,
 * ToNumber or ToBoolean of the first argument, and "", +0 or false without one. The one table both routes read: the
 * front end's conversion call (`realm-static-call.ts`) and the call through the realm's value
 * (`dynamic-wrapper-constructors.ts`).
 */
export const WRAPPER_CONVERSIONS = {
  String: { to: "string", absent: "" },
  Number: { to: "number", absent: 0 },
  Boolean: { to: "boolean", absent: false },
} as const satisfies Record<
  NativeWrapperConstructor,
  { readonly to: string; readonly absent: string | number | boolean }
>;

/**
 * (#7354 G1, #7350 B3a) The realm constructor the global `name` names, if it names one: the IR's one read of which
 * global names are the realm's constructors (`realmConstructorOf` derives the IR value's answer from it).
 */
export const realmConstructorId = (name: string): RealmConstructor | undefined => REALM_CONSTRUCTORS.get(name);

const REALM_CONSTRUCTORS_BY_ID: ReadonlyMap<string, RealmConstructor> = new Map(
  [...REALM_CONSTRUCTORS.values()].map((ctor) => [ctor.id, ctor]),
);
/** (#7350 B3a) The realm constructor whose catalog id is `id`, if one is. */
export const realmConstructorById = (id: string): RealmConstructor | undefined => REALM_CONSTRUCTORS_BY_ID.get(id);

/**
 * (#7350 B3a) The own string keys of each realm constructor the catalog models only as an identity
 * (`NativeRealmIntrinsic.identityOnly`), by id: any other key of it is one the realm lacks.
 */
const IDENTITY_ONLY_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  NATIVE_REALM_CATALOG.intrinsics.flatMap(({ id, identityOnly }) =>
    identityOnly ? [[id, new Set(identityOnly)] as const] : [],
  ),
);

/**
 * (#7350 B3a) The refusal of a static access to `key` of the pristine realm constructor `ctor` when its identity row
 * lacks `key`: the realm does not hold the property, and the kernel would abort the access at run time. The one test
 * a constant-key member access (`dynamic-member-access.ts`) and an `Object` static's target (`realm-static-call.ts`)
 * share.
 */
export function identityOnlyKeyRefusal(ctor: RealmConstructor, key: string): string | undefined {
  const own = IDENTITY_ONLY_KEYS.get(ctor.id);
  return own === undefined || own.has(key)
    ? undefined
    : `${ctor.name}.${key} is not reachable on this path yet (#7350 B3bc)`;
}

/**
 * (#7350 B3a) `<name>.<key>` as a constant where the realm constructor `name` holds `key` as a data property with a
 * number value that is neither writable nor configurable (Number's value properties, §21.1.2): no program can change
 * it, so a read of it off the pristine global is that number.
 */
export function nativeConstantStatic(name: string, key: string): number | undefined {
  const ctor = realmConstructorId(name);
  const row = NATIVE_REALM_CATALOG.intrinsics.find(({ id }) => id === ctor?.id);
  const property = (row && modelledRow(row))?.properties.find(
    (own) => own.key.kind === "string" && own.key.value === key,
  );
  return property?.kind === "data" && property.value.kind === "number" && !property.writable && !property.configurable
    ? property.value.value
    : undefined;
}

/**
 * (#7354 G1) The global names the realm serves a built-in for (`Object`, `Function`, the Error constructors, (#7350
 * B3a) the wrapper constructors): the catalog's plain-name aliases.
 */
export const REALM_GLOBAL_NAMES: ReadonlySet<string> = new Set(
  NATIVE_REALM_CATALOG.intrinsics.flatMap(({ aliases }) => aliases.filter((alias) => /^[A-Za-z]+$/.test(alias))),
);

/** (#7561) The selectors of `js.object.wrapper-data`, for every IR reader. */
export { WRAPPER_DATA };

/** (#7561) The wrapper constructor of each primitive kind: the prototype its member access reads through. */
export const WRAPPER_OF_PRIMITIVE = {
  string: "String",
  number: "Number",
  boolean: "Boolean",
} as const satisfies Readonly<Record<string, NativeWrapperConstructor>>;

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
 * (#7354 G1, #7489) The accessor keys `Function.prototype` adds on a function's chain, `caller` and `arguments`, whose
 * getter and setter are %ThrowTypeError% (§10.2.4, AddRestrictedFunctionProperties). The realm's Function.prototype
 * holds both, and a sloppy plain function owns a `caller` (`null`, `js.object.init-function`).
 */
const FUNCTION_PROTOTYPE_ACCESSOR_KEYS = accessorKeys("%Function.prototype%");

/**
 * (#7489) What an access of a function's `arguments` lacks: a sloppy function's own `arguments` is V8's live arguments
 * object, which no Prepared function owns, so the realm's accessor would answer a sloppy function with a TypeError.
 */
export const functionOwnKeyGap = (name: string): string | undefined =>
  name === "arguments" ? "a sloppy function's own arguments object" : undefined;

/** (#7354 P1) Object.prototype's keys the realm's Object.prototype does not hold. */
const UNPOPULATED_OBJECT_PROTOTYPE_KEYS = new Set(
  [...OBJECT_PROTOTYPE_KEYS].filter((key) => nativeObjectPrototypeMethod(key) === undefined),
);

/**
 * (#7354 F1b) The keys a read of a source function reaches on Function.prototype and Object.prototype that the realm
 * does not hold: every key the catalog gives them but `length` and `name`, which every function value owns from its
 * creation, and (#7489) Function.prototype's accessors, which the realm holds.
 */
const FUNCTION_REACHABLE_KEYS = new Set(
  [...realmStringKeys("%Function.prototype%"), ...UNPOPULATED_OBJECT_PROTOTYPE_KEYS].filter(
    (key) => key !== "length" && key !== "name" && !FUNCTION_PROTOTYPE_ACCESSOR_KEYS.has(key),
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
  number: new Set([...UNPOPULATED_OBJECT_PROTOTYPE_KEYS, ...realmStringKeys("%Number.prototype%")]),
  boolean: new Set([...UNPOPULATED_OBJECT_PROTOTYPE_KEYS, ...realmStringKeys("%Boolean.prototype%")]),
  string: new Set([...UNPOPULATED_OBJECT_PROTOTYPE_KEYS, ...realmStringKeys("%String.prototype%")]),
} as const satisfies Readonly<Record<string, ReadonlySet<string>>>;

/** A canonical array index (§6.1.7): a string's own indexed character. */
export function isArrayIndexKey(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}
