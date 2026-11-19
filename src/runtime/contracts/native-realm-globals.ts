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

const property = (name: string, value: NativeRealmGlobalValue, legacy = false): Row => ({
  name,
  writable: true,
  configurable: true,
  ...(legacy ? { normativeOptional: true as const, legacy: true as const } : {}),
  value,
});
const callable =
  (fallback: NativeRealmConstruct, legacy = false) =>
  ([name, length, construct = fallback]: Callable): Row =>
    property(name, { kind: "function", id: `%${name}%`, length, construct }, legacy);
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
