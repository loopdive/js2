// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4218 Phase 1) The curated builtin-shape table — the deliberately SMALL
 * stand-in for `lib.d.ts` that the checker-free oracle backend consults.
 *
 * The issue scopes this explicitly: "needs a curated builtin-shape table, not a
 * full lib.d.ts interpreter". Everything here is knowledge the compiler already
 * hard-codes elsewhere (the builtin dispatch tables in `src/codegen/`), stated
 * once in oracle-fact terms. Anything not listed answers `unresolvable` —
 * never a guess.
 */
import type { TypeFact } from "./oracle.js";

/** Globals that are values (not just types) in every JS host we target. */
export const GLOBAL_VALUE_NAMES: ReadonlySet<string> = new Set([
  "globalThis",
  "undefined",
  "NaN",
  "Infinity",
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "Number",
  "BigInt",
  "Math",
  "Date",
  "String",
  "RegExp",
  "Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Atomics",
  "JSON",
  "Promise",
  "Reflect",
  "Proxy",
  "Intl",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
  "console",
  "process",
  "globalThis",
  "queueMicrotask",
  "structuredClone",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
]);

/**
 * `lib.d.ts` type NAME for a global VALUE reference — what
 * `checker.getTypeAtLocation(<the identifier>).symbol.name` reports. The
 * `…Constructor` spelling is load-bearing: `builtin-prototype-brand.ts` gates
 * on `declaredNameOf(base) === \`${name}Constructor\``.
 */
export const GLOBAL_VALUE_TYPE_NAMES: ReadonlyMap<string, string> = new Map([
  ["Object", "ObjectConstructor"],
  ["Function", "FunctionConstructor"],
  ["Boolean", "BooleanConstructor"],
  ["Symbol", "SymbolConstructor"],
  ["Error", "ErrorConstructor"],
  ["EvalError", "EvalErrorConstructor"],
  ["RangeError", "RangeErrorConstructor"],
  ["ReferenceError", "ReferenceErrorConstructor"],
  ["SyntaxError", "SyntaxErrorConstructor"],
  ["TypeError", "TypeErrorConstructor"],
  ["URIError", "URIErrorConstructor"],
  ["AggregateError", "AggregateErrorConstructor"],
  ["Number", "NumberConstructor"],
  ["BigInt", "BigIntConstructor"],
  ["Date", "DateConstructor"],
  ["String", "StringConstructor"],
  ["RegExp", "RegExpConstructor"],
  ["Array", "ArrayConstructor"],
  ["Int8Array", "Int8ArrayConstructor"],
  ["Uint8Array", "Uint8ArrayConstructor"],
  ["Uint8ClampedArray", "Uint8ClampedArrayConstructor"],
  ["Int16Array", "Int16ArrayConstructor"],
  ["Uint16Array", "Uint16ArrayConstructor"],
  ["Int32Array", "Int32ArrayConstructor"],
  ["Uint32Array", "Uint32ArrayConstructor"],
  ["Float32Array", "Float32ArrayConstructor"],
  ["Float64Array", "Float64ArrayConstructor"],
  ["BigInt64Array", "BigInt64ArrayConstructor"],
  ["BigUint64Array", "BigUint64ArrayConstructor"],
  ["Map", "MapConstructor"],
  ["Set", "SetConstructor"],
  ["WeakMap", "WeakMapConstructor"],
  ["WeakSet", "WeakSetConstructor"],
  ["WeakRef", "WeakRefConstructor"],
  ["ArrayBuffer", "ArrayBufferConstructor"],
  ["SharedArrayBuffer", "SharedArrayBufferConstructor"],
  ["DataView", "DataViewConstructor"],
  ["Promise", "PromiseConstructor"],
  ["Proxy", "ProxyConstructor"],
  // Namespace-shaped globals keep their own name.
  ["Math", "Math"],
  ["JSON", "JSON"],
  ["Atomics", "Atomics"],
]);

/**
 * Globals that are OBJECTS, not callables — they carry no call/construct
 * signature, which is what decides `function` vs `builtin` in the checker's
 * own classification (`factOfType` tests signatures before the nominal name).
 */
export const NAMESPACE_GLOBALS: ReadonlySet<string> = new Set([
  "Math",
  "JSON",
  "Atomics",
  "Reflect",
  "Intl",
  "console",
  "process",
  "globalThis",
]);

const NUMBER: TypeFact = { kind: "number" };
const STRING: TypeFact = { kind: "string" };
const BOOLEAN: TypeFact = { kind: "boolean" };
const SYMBOL: TypeFact = { kind: "symbol" };
const BIGINT: TypeFact = { kind: "bigint" };

/** Return fact for `<global>(…)` calls — only the unambiguous ones. */
export const GLOBAL_CALL_RETURNS: ReadonlyMap<string, TypeFact> = new Map<string, TypeFact>([
  ["String", STRING],
  ["Number", NUMBER],
  ["Boolean", BOOLEAN],
  ["Symbol", SYMBOL],
  ["BigInt", BIGINT],
  ["parseInt", NUMBER],
  ["parseFloat", NUMBER],
  ["isNaN", BOOLEAN],
  ["isFinite", BOOLEAN],
  ["encodeURI", STRING],
  ["decodeURI", STRING],
  ["encodeURIComponent", STRING],
  ["decodeURIComponent", STRING],
  ["escape", STRING],
  ["unescape", STRING],
]);

/** Return fact for `<Namespace>.<member>(…)` calls. */
export const NAMESPACE_CALL_RETURNS: ReadonlyMap<string, TypeFact> = new Map<string, TypeFact>([
  // Math — every method returns a number.
  ...(
    [
      "abs",
      "acos",
      "acosh",
      "asin",
      "asinh",
      "atan",
      "atan2",
      "atanh",
      "cbrt",
      "ceil",
      "clz32",
      "cos",
      "cosh",
      "exp",
      "expm1",
      "floor",
      "fround",
      "hypot",
      "imul",
      "log",
      "log10",
      "log1p",
      "log2",
      "max",
      "min",
      "pow",
      "random",
      "round",
      "sign",
      "sin",
      "sinh",
      "sqrt",
      "tan",
      "tanh",
      "trunc",
    ] as const
  ).map((m) => [`Math.${m}`, NUMBER] as const),
  ["JSON.stringify", STRING],
  ["Date.now", NUMBER],
  ["Number.parseInt", NUMBER],
  ["Number.parseFloat", NUMBER],
  ["Number.isNaN", BOOLEAN],
  ["Number.isFinite", BOOLEAN],
  ["Number.isInteger", BOOLEAN],
  ["Number.isSafeInteger", BOOLEAN],
  ["Array.isArray", BOOLEAN],
  ["String.fromCharCode", STRING],
  ["String.fromCodePoint", STRING],
  ["Object.keys", { kind: "array", element: STRING }],
  ["Object.is", BOOLEAN],
  ["Reflect.has", BOOLEAN],
]);

/** Namespace CONSTANTS (`Math.PI`, `Number.MAX_SAFE_INTEGER`, …). */
export const NAMESPACE_PROPERTY_FACTS: ReadonlyMap<string, TypeFact> = new Map<string, TypeFact>([
  ["Math.PI", NUMBER],
  ["Math.E", NUMBER],
  ["Math.LN2", NUMBER],
  ["Math.LN10", NUMBER],
  ["Math.LOG2E", NUMBER],
  ["Math.LOG10E", NUMBER],
  ["Math.SQRT2", NUMBER],
  ["Math.SQRT1_2", NUMBER],
  ["Number.MAX_SAFE_INTEGER", NUMBER],
  ["Number.MIN_SAFE_INTEGER", NUMBER],
  ["Number.MAX_VALUE", NUMBER],
  ["Number.MIN_VALUE", NUMBER],
  ["Number.EPSILON", NUMBER],
  ["Number.POSITIVE_INFINITY", NUMBER],
  ["Number.NEGATIVE_INFINITY", NUMBER],
  ["Number.NaN", NUMBER],
]);

/** `string.prototype` methods with an unambiguous return fact. */
export const STRING_METHOD_RETURNS: ReadonlyMap<string, TypeFact> = new Map<string, TypeFact>([
  ["at", STRING],
  ["charAt", STRING],
  ["charCodeAt", NUMBER],
  ["codePointAt", NUMBER],
  ["concat", STRING],
  ["endsWith", BOOLEAN],
  ["includes", BOOLEAN],
  ["indexOf", NUMBER],
  ["lastIndexOf", NUMBER],
  ["localeCompare", NUMBER],
  ["normalize", STRING],
  ["padEnd", STRING],
  ["padStart", STRING],
  ["repeat", STRING],
  ["replace", STRING],
  ["replaceAll", STRING],
  ["search", NUMBER],
  ["slice", STRING],
  ["split", { kind: "array", element: STRING }],
  ["startsWith", BOOLEAN],
  ["substr", STRING],
  ["substring", STRING],
  ["toLowerCase", STRING],
  ["toUpperCase", STRING],
  ["toLocaleLowerCase", STRING],
  ["toLocaleUpperCase", STRING],
  ["toString", STRING],
  ["trim", STRING],
  ["trimEnd", STRING],
  ["trimStart", STRING],
  ["valueOf", STRING],
]);

/** `Array.prototype` methods with a receiver-independent return fact. */
export const ARRAY_METHOD_RETURNS: ReadonlyMap<string, TypeFact> = new Map<string, TypeFact>([
  ["includes", BOOLEAN],
  ["indexOf", NUMBER],
  ["lastIndexOf", NUMBER],
  ["join", STRING],
  ["push", NUMBER],
  ["unshift", NUMBER],
  ["every", BOOLEAN],
  ["some", BOOLEAN],
  ["toString", STRING],
]);

/**
 * Well-known-symbol members carried by builtin nominal types (#4016's
 * tri-state query). Only entries we can state with certainty appear here.
 */
export const BUILTIN_WELL_KNOWN_SYMBOLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["RegExp", new Set(["match", "matchAll", "replace", "search", "split"])],
  ["Array", new Set(["iterator", "unscopables"])],
  ["Map", new Set(["iterator", "toStringTag"])],
  ["Set", new Set(["iterator", "toStringTag"])],
  ["Promise", new Set(["toStringTag"])],
]);

/** Well-known-symbol members on the PRIMITIVE lanes (a provable answer). */
export const PRIMITIVE_WELL_KNOWN_SYMBOLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["string", new Set(["iterator"])],
  ["number", new Set()],
  ["boolean", new Set()],
  ["bigint", new Set()],
  ["undefined", new Set()],
  ["null", new Set()],
]);
