// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7350 B2a) The own-property population of the global object: ECMA-262 2025 §19.1–19.4, plus Annex B.2.1
 * `escape` / `unescape`. Semantic data only, like the realm catalog it references by intrinsic id; it is the one
 * table that says which globals exist and what `typeof` answers for them.
 *
 * It is a sibling of `NATIVE_REALM_CATALOG` and not rows of it: the realm's literal plan interns every catalog
 * row's names into every realm binary. An intrinsic the catalog has a row for has its complete property
 * population there; any other intrinsic named here is identity only (see {@link nativeRealmGlobalSurface}).
 */
import { NATIVE_REALM_CATALOG } from "./native-realm-catalog.js";

export type NativeRealmGlobalValue =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "undefined" }
  /** `globalThis`: the global object itself. */
  | { readonly kind: "global-object" }
  | {
      readonly kind: "intrinsic";
      readonly id: string;
      readonly typeof: "function" | "object";
      /** Callables only: the `length` property and IsConstructor. */
      readonly length?: number;
      readonly constructible?: boolean;
    };

export interface NativeRealmGlobal {
  readonly name: string;
  /** Every global is non-enumerable; the value properties of §19.1 other than `globalThis` are frozen. */
  readonly writable: boolean;
  readonly configurable: boolean;
  /** Annex B (Normative Optional). */
  readonly legacy?: true;
  readonly value: NativeRealmGlobalValue;
}

type Callable = readonly [name: string, length: number];

/** §19.2 function properties, and Annex B.2.1. */
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
const LEGACY_FUNCTIONS: readonly Callable[] = [
  ["escape", 1],
  ["unescape", 1],
];

/** §19.3 constructor properties. */
const CONSTRUCTORS: readonly Callable[] = [
  ["AggregateError", 2],
  ["Array", 1],
  ["ArrayBuffer", 1],
  ["BigInt", 1],
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
  ["Iterator", 0],
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
  ["Symbol", 0],
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

/** §19.4 other properties. */
const NAMESPACES: readonly string[] = ["Atomics", "JSON", "Math", "Reflect"];

const property = (name: string, value: NativeRealmGlobalValue, legacy = false): NativeRealmGlobal => ({
  name,
  writable: true,
  configurable: true,
  ...(legacy ? { legacy: true as const } : {}),
  value,
});
const callable =
  (constructible: boolean, legacy = false) =>
  ([name, length]: Callable): NativeRealmGlobal =>
    property(name, { kind: "intrinsic", id: `%${name}%`, typeof: "function", length, constructible }, legacy);
const frozen = (name: string, value: NativeRealmGlobalValue): NativeRealmGlobal => ({
  name,
  writable: false,
  configurable: false,
  value,
});

export const NATIVE_REALM_GLOBALS: readonly NativeRealmGlobal[] = Object.freeze(
  [
    property("globalThis", { kind: "global-object" }),
    frozen("Infinity", { kind: "number", value: Infinity }),
    frozen("NaN", { kind: "number", value: NaN }),
    frozen("undefined", { kind: "undefined" }),
    ...FUNCTIONS.map(callable(false)),
    ...LEGACY_FUNCTIONS.map(callable(false, true)),
    ...CONSTRUCTORS.map(callable(true)),
    ...NAMESPACES.map((name) => property(name, { kind: "intrinsic", id: `%${name}%`, typeof: "object" })),
  ].map((row) => Object.freeze({ ...row, value: Object.freeze(row.value) })),
);

const BY_NAME: ReadonlyMap<string, NativeRealmGlobal> = new Map(NATIVE_REALM_GLOBALS.map((row) => [row.name, row]));

/** `typeof` of the global's initial value, or `undefined` when it is not a global of the realm. */
export function nativeRealmGlobalTypeof(name: string): "function" | "object" | "number" | "undefined" | undefined {
  const value = BY_NAME.get(name)?.value;
  if (value === undefined) return undefined;
  switch (value.kind) {
    case "number":
    case "undefined":
      return value.kind;
    case "global-object":
      return "object";
    case "intrinsic":
      return value.typeof;
  }
}

const CATALOG_IDS: ReadonlySet<string> = new Set(NATIVE_REALM_CATALOG.intrinsics.map((row) => row.id));

/**
 * `"complete"` when the realm catalog has the intrinsic's row, with its full property population; `"identity"`
 * when only its identity, typeof tag, `length` and constructibility are known. A member of an identity
 * intrinsic is never answered as `undefined` nor by a catchable error: a static read refuses by name at compile
 * time, a dynamic one aborts uncatchably.
 */
export function nativeRealmGlobalSurface(id: string): "complete" | "identity" {
  return CATALOG_IDS.has(id) ? "complete" : "identity";
}
