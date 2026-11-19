// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7350 B2a) The own-property population of the global object: every global the test262 runner's classifier
 * counts as a language global. That is ECMA-262 §19.1–19.4 plus Annex B.2.1 `escape` / `unescape` in the realm's
 * edition (`NATIVE_REALM_EDITION` in the catalog), and the globals of the draft after it, which the runner
 * scores as standard although no edition has ratified them. Semantic data only, like the realm catalog it
 * references by intrinsic id; it is the one table that says which globals exist and what `typeof` answers for
 * them.
 *
 * It is a sibling of `NATIVE_REALM_CATALOG` and not rows of it: the realm's literal plan interns every catalog
 * row's names into every realm binary. An intrinsic the catalog has a row for has its complete property
 * population there; any other intrinsic named here is identity only (see {@link nativeRealmGlobalSurface}).
 */
import { NATIVE_REALM_CATALOG, NATIVE_REALM_EDITION } from "./native-realm-catalog.js";

/**
 * How a callable answers `new`. `"none"`: no [[Construct]] (the §19.2 functions). `"ordinary"`: a constructor.
 * `"throws"`: IsConstructor is true, so it may be subclassed, but `new X()` on it throws a TypeError
 * (`Symbol`, `BigInt`; `Iterator` when NewTarget is `Iterator` itself).
 */
export type NativeRealmConstruct = "none" | "ordinary" | "throws";

export type NativeRealmGlobalValue =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "undefined" }
  /** `globalThis`: the global object itself. */
  | { readonly kind: "global-object" }
  | {
      readonly kind: "function";
      readonly id: string;
      readonly length: number;
      readonly construct: NativeRealmConstruct;
      /** [[Prototype]]: %Function.prototype%, except a NativeError's (%Error%) and a TypedArray's (%TypedArray%). */
      readonly prototype: string;
      /** The function's own `prototype` property: that object and its [[Prototype]]; `null` without one (§19.2, Proxy). */
      readonly prototypeObject: { readonly id: string; readonly prototype: string | null } | null;
    }
  /** §19.4 `Atomics`, `JSON`, `Math`, `Reflect`, and `Temporal` (ES2026). */
  | { readonly kind: "namespace"; readonly id: string };

export interface NativeRealmGlobal {
  readonly name: string;
  /**
   * The ECMA-262 edition the row is read from, not the one that introduced the global: the realm's edition for
   * every global that edition defines, the draft after it for a global only the draft defines. A property of the
   * row, not a filter: a draft row answers `typeof` like any other.
   */
  readonly edition: number;
  /** Every global is non-enumerable; the value properties of §19.1 other than `globalThis` are frozen. */
  readonly writable: boolean;
  readonly configurable: boolean;
  /** Annex B, shaped as the catalog's Normative Optional rows. */
  readonly normativeOptional?: true;
  readonly legacy?: true;
  readonly value: NativeRealmGlobalValue;
}

export type NativeRealmGlobalCallable = NativeRealmGlobal & {
  readonly value: Extract<NativeRealmGlobalValue, { readonly kind: "function" }>;
};

type Row = Omit<NativeRealmGlobal, "edition">;
type Callable = readonly [name: string, length: number, construct?: NativeRealmConstruct];

/** §19.2 function properties. */
const FUNCTIONS: readonly Callable[] = [
  ["eval", 1],
  ["isFinite", 1],
  ["isNaN", 1],
  ["parseFloat", 1],
  ["parseInt", 2],
  ["decodeURI", 1],
  ["decodeURIComponent", 1],
  ["encodeURI", 1],
  ["encodeURIComponent", 1],
];
/** Annex B.2.1. */
const LEGACY_FUNCTIONS: readonly Callable[] = [
  ["escape", 1],
  ["unescape", 1],
];

/** §19.3 constructor properties. */
const CONSTRUCTORS: readonly Callable[] = [
  ["AggregateError", 2],
  ["Array", 1],
  ["ArrayBuffer", 1],
  ["BigInt", 1, "throws"],
  ["BigInt64Array", 3],
  ["BigUint64Array", 3],
  ["Boolean", 1],
  ["DataView", 1],
  ["Date", 7],
  ["Error", 1],
  ["EvalError", 1],
  ["FinalizationRegistry", 1],
  ["Float16Array", 3],
  ["Float32Array", 3],
  ["Float64Array", 3],
  ["Function", 1],
  ["Int8Array", 3],
  ["Int16Array", 3],
  ["Int32Array", 3],
  ["Iterator", 0, "throws"],
  ["Map", 0],
  ["Number", 1],
  ["Object", 1],
  ["Promise", 1],
  ["Proxy", 2],
  ["RangeError", 1],
  ["ReferenceError", 1],
  ["RegExp", 2],
  ["Set", 0],
  ["SharedArrayBuffer", 1],
  ["String", 1],
  ["Symbol", 0, "throws"],
  ["SyntaxError", 1],
  ["TypeError", 1],
  ["Uint8Array", 3],
  ["Uint8ClampedArray", 3],
  ["Uint16Array", 3],
  ["Uint32Array", 3],
  ["URIError", 1],
  ["WeakMap", 0],
  ["WeakRef", 1],
  ["WeakSet", 0],
];

/** §19.3 constructor properties only the draft defines: explicit resource management. */
const DRAFT_CONSTRUCTORS: readonly Callable[] = [
  ["AsyncDisposableStack", 0],
  ["DisposableStack", 0],
  ["SuppressedError", 3],
];

/** §19.4 other properties. */
const NAMESPACES: readonly string[] = ["Atomics", "JSON", "Math", "Reflect", "Temporal"];

/** §20.5.6 and §20.5.7: the constructors whose [[Prototype]] is %Error%. */
const ERROR_SUBCLASSES: ReadonlySet<string> = new Set([
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SuppressedError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);
/** §23.2.6: the constructors whose [[Prototype]] is %TypedArray%. */
const TYPED_ARRAYS: ReadonlySet<string> = new Set(
  CONSTRUCTORS.flatMap(([name]) => (name.endsWith("Array") && name !== "Array" ? [name] : [])),
);
/** The [[Prototype]] of `name`'s function object, and its own `prototype` object. */
function prototypes(
  name: string,
  construct: NativeRealmConstruct,
): readonly [string, { readonly id: string; readonly prototype: string | null } | null] {
  const family = ERROR_SUBCLASSES.has(name) ? "Error" : TYPED_ARRAYS.has(name) ? "TypedArray" : undefined;
  const parent = name === "Object" ? null : family ? `%${family}.prototype%` : "%Object.prototype%";
  const object = construct === "none" || name === "Proxy" ? null : { id: `%${name}.prototype%`, prototype: parent };
  return [family ? `%${family}%` : "%Function.prototype%", object];
}

const property = (name: string, value: NativeRealmGlobalValue, legacy = false): Row => ({
  name,
  writable: true,
  configurable: true,
  ...(legacy ? { normativeOptional: true as const, legacy: true as const } : {}),
  value,
});
const callable =
  (fallback: NativeRealmConstruct, legacy = false) =>
  ([name, length, construct = fallback]: Callable): Row => {
    const [prototype, prototypeObject] = prototypes(name, construct);
    return property(name, { kind: "function", id: `%${name}%`, length, construct, prototype, prototypeObject }, legacy);
  };
const frozen = (name: string, value: NativeRealmGlobalValue): Row => ({
  name,
  writable: false,
  configurable: false,
  value,
});
const inEdition =
  (edition: number) =>
  (row: Row): NativeRealmGlobal =>
    Object.freeze({ ...row, edition, value: Object.freeze(row.value) });

export const NATIVE_REALM_GLOBALS: readonly NativeRealmGlobal[] = Object.freeze([
  ...[
    property("globalThis", { kind: "global-object" }),
    frozen("Infinity", { kind: "number", value: Infinity }),
    frozen("NaN", { kind: "number", value: NaN }),
    frozen("undefined", { kind: "undefined" }),
    ...FUNCTIONS.map(callable("none")),
    ...LEGACY_FUNCTIONS.map(callable("none", true)),
    ...CONSTRUCTORS.map(callable("ordinary")),
    ...NAMESPACES.map((name) => property(name, { kind: "namespace", id: `%${name}%` })),
  ].map(inEdition(NATIVE_REALM_EDITION)),
  ...DRAFT_CONSTRUCTORS.map(callable("ordinary")).map(inEdition(NATIVE_REALM_EDITION + 1)),
]);

const BY_NAME: ReadonlyMap<string, NativeRealmGlobal> = new Map(NATIVE_REALM_GLOBALS.map((row) => [row.name, row]));

/**
 * `typeof` of the global's initial value. `"not-a-language-global"` when the table has no row: the name is
 * host-only (`console`, `print`, `document`). That is no `typeof` answer — the host may define the name — so
 * the caller refuses.
 */
export function nativeRealmGlobalTypeof(
  name: string,
): "function" | "object" | "number" | "undefined" | "not-a-language-global" {
  const value = BY_NAME.get(name)?.value;
  if (value === undefined) return "not-a-language-global";
  switch (value.kind) {
    case "number":
    case "undefined":
    case "function":
      return value.kind;
    case "global-object":
    case "namespace":
      return "object";
  }
}

const CATALOG_IDS: ReadonlySet<string> = new Set(NATIVE_REALM_CATALOG.intrinsics.map((row) => row.id));
const TABLE_IDS: ReadonlySet<string> = new Set(
  NATIVE_REALM_GLOBALS.flatMap((row) => ("id" in row.value ? [row.value.id] : [])),
);

/**
 * For an intrinsic the table names: `"complete"` when the realm catalog has its row, with its full property
 * population; `"identity"` when only its identity, typeof tag, `length` and construct behaviour are known. A
 * member of an identity intrinsic is never answered as `undefined` nor by a catchable error: a static read
 * refuses by name at compile time, a dynamic one aborts uncatchably.
 */
export function nativeRealmGlobalSurface(id: string): "complete" | "identity" {
  if (!TABLE_IDS.has(id)) throw new Error(`native realm globals: ${id} is not a global intrinsic`);
  return CATALOG_IDS.has(id) ? "complete" : "identity";
}

/** The global's row, or `undefined` for a name that is no language global. */
export function nativeRealmGlobal(name: string): NativeRealmGlobal | undefined {
  return BY_NAME.get(name);
}

/** The intrinsics an identity row's objects link to that the realm builds. */
const MODELED_LINKS: ReadonlySet<string | null> = new Set([
  null,
  "%Function.prototype%",
  "%Object.prototype%",
  "%Error%",
  "%Error.prototype%",
]);

/**
 * (#7350 B2b) Why the realm cannot answer a read of the global `name` off the global object, or `undefined` when it
 * can: a callable or a namespace with its identity surface (a callable's name, length, `prototype` and `constructor`
 * link; every other member an uncatchable abort). A complete intrinsic (%Object%, %Function%) has the same identity
 * surface until its catalog population has realm algorithms. A callable linked to an intrinsic no global names
 * (%TypedArray%) waits for that intrinsic, and a value row for a read that reaches it.
 */
export function nativeRealmGlobalReadRefusal(name: string): string | undefined {
  const value = BY_NAME.get(name)?.value;
  if (value === undefined) return `'${name}' is not a language global`;
  if (value.kind === "namespace") return undefined;
  if (value.kind !== "function") return `the global '${name}' is a ${value.kind} value`;
  const link = [value.prototype, value.prototypeObject?.prototype ?? null].find((id) => !MODELED_LINKS.has(id));
  return link === undefined ? undefined : `${value.id} links to ${link}, which the realm does not build`;
}

/**
 * (#7350 B2b) The callables a realm holding the globals `names` builds, each after the callables its [[Prototype]] and
 * its `prototype` object link to (a NativeError after %Error%), in that order.
 */
export function nativeRealmGlobalCallables(names: readonly string[]): readonly NativeRealmGlobalCallable[] {
  const ordered: NativeRealmGlobalCallable[] = [];
  const add = (name: string): void => {
    const row = BY_NAME.get(name)!;
    if (row.value.kind !== "function" || ordered.includes(row as NativeRealmGlobalCallable)) return;
    if (row.value.prototype !== "%Function.prototype%") add(row.value.prototype.slice(1, -1));
    ordered.push(row as NativeRealmGlobalCallable);
  };
  names.forEach(add);
  return ordered;
}
