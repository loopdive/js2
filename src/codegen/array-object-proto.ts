// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2193 / #43 harvest) Native `$NativeProto` glue for `Array.prototype` and
 * `Object.prototype` so a bare `Array.prototype` / `Object.prototype` value read
 * resolves host-free in `--target standalone` instead of refusing
 * (`property-access.ts` `reportUnsupportedStandaloneBuiltinValueRead`,
 * "#1907 / #1888 S6-b").
 *
 * Scope (PR-A): the PROTO OBJECT itself. `emitLazyNativeProtoGet` builds the
 * `$NativeProto` struct purely from the glue's `memberCsv` + `name` — it never
 * calls `emitMemberBody`. So registering glue with the correct member CSV makes
 * `Array.prototype` / `Object.prototype` value reads (and their reference
 * identity, `Array.prototype === Array.prototype`) work immediately. Reflective
 * member-CLOSURE materialization (`Array.prototype.slice` as a callable value)
 * still routes through `emitMemberBody`; until the per-member native bodies are
 * filled in (PR-C), those degrade gracefully via a catchable TypeError rather
 * than a hard compile refusal — see `emitMemberBody` below.
 *
 * Dual-mode: host mode is untouched (the `__get_builtin` path stays). Pure Wasm,
 * no new host import.
 */

import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";
import {
  getBuiltinBrand,
  getNativeProtoBuiltinGlue,
  registerNativeProtoBuiltin,
  type NativeProtoBuiltinGlue,
} from "./native-proto.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { allocLocal } from "./context/locals.js";
import { emitThisReceiverGuardConvert } from "./property-access.js";
import { compileArraySliceFromVecLocal } from "./array-methods.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/**
 * `Array.prototype`'s own enumerable+non-enumerable method names (ES2024
 * §23.1.3). `@@iterator` is the well-known-symbol member (the `$NativeProto`
 * symbol-cell sentinel form is `@@<id>`; Symbol.iterator's id is threaded by the
 * caller — for the value-read object we only need the string members in the CSV,
 * the symbol member is resolved by the computed-access path).
 */
const ARRAY_PROTO_METHODS = [
  "at",
  "concat",
  "copyWithin",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "pop",
  "push",
  "reduce",
  "reduceRight",
  "reverse",
  "shift",
  "slice",
  "some",
  "sort",
  "splice",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toSpliced",
  "toString",
  "unshift",
  "values",
  "with",
] as const;

/** `Object.prototype`'s own method names (ES2024 §20.1.3). */
const OBJECT_PROTO_METHODS = [
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
] as const;

/**
 * `Date.prototype`'s own method names (ES2024 §21.4.4). All the getter/setter
 * methods are plain data methods on the proto (no accessor *getters* on
 * `Date.prototype` itself), so the whole set goes in the value-read member CSV.
 * `@@toPrimitive` is a well-known-symbol member resolved by the computed-access
 * path, so it stays out of the string CSV (same convention as the others).
 */
const DATE_PROTO_METHODS = [
  "getDate",
  "getDay",
  "getFullYear",
  "getHours",
  "getMilliseconds",
  "getMinutes",
  "getMonth",
  "getSeconds",
  "getTime",
  "getTimezoneOffset",
  "getUTCDate",
  "getUTCDay",
  "getUTCFullYear",
  "getUTCHours",
  "getUTCMilliseconds",
  "getUTCMinutes",
  "getUTCMonth",
  "getUTCSeconds",
  "setDate",
  "setFullYear",
  "setHours",
  "setMilliseconds",
  "setMinutes",
  "setMonth",
  "setSeconds",
  "setTime",
  "setUTCDate",
  "setUTCFullYear",
  "setUTCHours",
  "setUTCMilliseconds",
  "setUTCMinutes",
  "setUTCMonth",
  "setUTCSeconds",
  "toDateString",
  "toISOString",
  "toJSON",
  "toLocaleDateString",
  "toLocaleString",
  "toLocaleTimeString",
  "toString",
  "toTimeString",
  "toUTCString",
  "valueOf",
] as const;

/**
 * `String.prototype`'s own method names (ES2024 §22.1.3). `@@iterator` is a
 * well-known-symbol member resolved via the computed-access path, so only the
 * string members go in the CSV (same convention as `ARRAY_PROTO_METHODS`).
 * Annex-B (`substr`, `anchor`, `big`, …) is included so a bare
 * `String.prototype.substr` value read resolves host-free.
 */
const STRING_PROTO_METHODS = [
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
  "substr",
  "substring",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "toWellFormed",
  "trim",
  "trimEnd",
  "trimStart",
  "valueOf",
] as const;

/** `Number.prototype`'s own method names (ES2024 §21.1.3). */
const NUMBER_PROTO_METHODS = [
  "toExponential",
  "toFixed",
  "toLocaleString",
  "toPrecision",
  "toString",
  "valueOf",
] as const;

/** `Boolean.prototype`'s own method names (ES2024 §20.3.3). */
const BOOLEAN_PROTO_METHODS = ["toString", "valueOf"] as const;

/** `Error.prototype`'s own method names (ES2024 §20.5.3). `name`/`message` are
 * data properties (own on the proto), not methods. */
const ERROR_PROTO_METHODS = ["toString"] as const;

/** `Function.prototype`'s own method names (ES2024 §20.2.3). */
const FUNCTION_PROTO_METHODS = ["apply", "bind", "call", "toString"] as const;

/** `Symbol.prototype`'s own method names (ES2024 §20.4.3). `description` is an
 * accessor getter, resolved by the computed-access path. */
const SYMBOL_PROTO_METHODS = ["toString", "valueOf"] as const;

/** `BigInt.prototype`'s own method names (ES2024 §21.2.3). */
const BIGINT_PROTO_METHODS = ["toLocaleString", "toString", "valueOf"] as const;

/** `WeakMap.prototype`'s own method names (ES2024 §24.3.3). */
const WEAKMAP_PROTO_METHODS = ["delete", "get", "has", "set"] as const;

/** `WeakSet.prototype`'s own method names (ES2024 §24.4.3). */
const WEAKSET_PROTO_METHODS = ["add", "delete", "has"] as const;

/**
 * `Map.prototype`'s own method names (ES2024 §24.1.3). `size` is an accessor
 * *getter* on the proto (resolved by the computed-access path), not a data
 * method, so it stays out of the value-read CSV.
 */
const MAP_PROTO_METHODS = ["clear", "delete", "entries", "forEach", "get", "has", "keys", "set", "values"] as const;

/** `Set.prototype`'s own method names (ES2024 §24.2.3 + the new set-method
 * proposal). `size` is an accessor getter, kept out of the CSV. */
const SET_PROTO_METHODS = [
  "add",
  "clear",
  "delete",
  "difference",
  "entries",
  "forEach",
  "has",
  "intersection",
  "isDisjointFrom",
  "isSubsetOf",
  "isSupersetOf",
  "keys",
  "symmetricDifference",
  "union",
  "values",
] as const;

/** Spec arity (`fn.length`) of the proto methods that differ from the default 1. */
const PROTO_METHOD_LENGTH: Readonly<Record<string, number>> = {
  concat: 1,
  copyWithin: 2,
  every: 1,
  fill: 1,
  forEach: 1,
  push: 1,
  reduce: 1,
  slice: 2,
  splice: 2,
  unshift: 1,
  with: 2,
  hasOwnProperty: 1,
  isPrototypeOf: 1,
  propertyIsEnumerable: 1,
  // Map.prototype.set(key, value) is arity 2 (ES2024 §24.1.3); add/get/has/delete
  // default to 1.
  set: 2,
  // Function.prototype.apply(thisArg, argArray) is arity 2 (ES2024 §20.2.3);
  // bind/call default to 1.
  apply: 2,
  // String.prototype arities that differ from the default 1 (ES2024 §22.1.3).
  at: 1,
  charAt: 1,
  charCodeAt: 1,
  codePointAt: 1,
  endsWith: 1,
  includes: 1,
  indexOf: 1,
  lastIndexOf: 1,
  localeCompare: 1,
  match: 1,
  matchAll: 1,
  normalize: 0,
  padEnd: 1,
  padStart: 1,
  repeat: 1,
  replace: 2,
  replaceAll: 2,
  search: 1,
  split: 2,
  startsWith: 1,
  substr: 2,
  substring: 2,
  // Number.prototype (ES2024 §21.1.3).
  toExponential: 1,
  toFixed: 1,
  toPrecision: 1,
  // Zero-arity String/Number/Boolean/Object proto methods (ES2024) — fold
  // `<method>.length` to 0 so the meta-read path (`tryCompileStandalone-
  // BuiltinProtoMemberMeta`) reports the spec arity. (`charAt` arity 1 is set
  // in the String batch above.)
  toLowerCase: 0,
  toUpperCase: 0,
  toLocaleLowerCase: 0,
  toLocaleUpperCase: 0,
  trim: 0,
  trimEnd: 0,
  trimStart: 0,
  isWellFormed: 0,
  toWellFormed: 0,
  // Date.prototype set* arities (ES2024 §21.4.4) that differ from the default 1.
  setFullYear: 3,
  setUTCFullYear: 3,
  setMonth: 2,
  setUTCMonth: 2,
  setHours: 4,
  setUTCHours: 4,
  setMinutes: 3,
  setUTCMinutes: 3,
  setSeconds: 2,
  setUTCSeconds: 2,
  // Date getters / no-arg conversions are 0-arity (ES2024 §21.4.4); fold their
  // `.length` to 0 so the meta-read path reports the spec arity.
  getDate: 0,
  getDay: 0,
  getFullYear: 0,
  getHours: 0,
  getMilliseconds: 0,
  getMinutes: 0,
  getMonth: 0,
  getSeconds: 0,
  getTime: 0,
  getTimezoneOffset: 0,
  getUTCDate: 0,
  getUTCDay: 0,
  getUTCFullYear: 0,
  getUTCHours: 0,
  getUTCMilliseconds: 0,
  getUTCMinutes: 0,
  getUTCMonth: 0,
  getUTCSeconds: 0,
  setTime: 1,
  toDateString: 0,
  toISOString: 0,
  toTimeString: 0,
  toUTCString: 0,
  // toJSON is 1 (the `key` param). entries/keys/values/reverse/pop/shift/
  // toString/valueOf/… default to 0 or 1; the value-read OBJECT does not depend
  // on exact arities, only the member set.
  toJSON: 1,
};

/**
 * Graceful member-body refusal: the value-read object (PR-A) does not need
 * member bodies, but if a reflective member closure is materialized for a member
 * whose native body isn't wired yet, emit a catchable TypeError instead of a
 * hard compile error. Keeps `Array.prototype` reads compilable while the
 * per-member native bodies land incrementally (#2193 PR-C).
 */
function emitProtoMemberBodyRefusal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  brandName: string,
  member: string,
): ValType | null {
  emitThrowTypeError(ctx, fctx, `${brandName}.prototype.${member} is not yet implemented in --target standalone`);
  return null;
}

/**
 * (#2193 PR-B) Unbox an externref closure-arg (a boxed JS number) at `paramIdx`
 * into an i32, leaving it on the stack. `default0` is used when the arg is
 * absent/non-number (the closure ABI over-pads with externref args).
 */
function unboxArgToI32(ctx: CodegenContext, fctx: FunctionContext, paramIdx: number): number {
  const local = allocLocal(fctx, `__pm_arg_${fctx.locals.length}`, { kind: "i32" });
  const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({ op: "local.get", index: paramIdx } as Instr);
  if (unboxIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: unboxIdx } as Instr);
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "drop" } as Instr);
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: local } as Instr);
  return local;
}

/**
 * (#2193 PR-B) Emit the native body for an `Array.prototype.<member>` closure
 * value. `this` is closure-param 1 (externref boxed array), args at 2.. . Recovers
 * the array instance via the registered-vec `ref.test`/`ref.cast` guard, then
 * delegates to the AST-free `compileArray<member>FromVecLocal` core. Members
 * without a native local-driven core yet degrade to a catchable TypeError (not a
 * compile refusal). Returns externref (the uniform closure-call result type).
 */
function emitArrayProtoMemberBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | null {
  if (member !== "slice") {
    // Other Array.prototype members: their *FromVecLocal cores land in PR-C; until
    // then, a reflective call degrades to a catchable TypeError, not a compile error.
    emitThrowTypeError(ctx, fctx, `Array.prototype.${member} is not yet callable as a value in --target standalone`);
    return { kind: "externref" };
  }

  // slice: args begin@2, end@3 (closure ABI pads with externref). Unbox to i32.
  const startLocal = unboxArgToI32(ctx, fctx, 2);
  const endLocal = unboxArgToI32(ctx, fctx, 3);
  const resultType: ValType = { kind: "externref" };

  // Recover the array instance from the externref `this` (param 1) over the
  // registered vec types; run the slice core in each compiled-array arm, box the
  // result vec to externref. Non-array `this` → host path → TypeError-ish null.
  const targets = [...ctx.vecTypeMap.values()];
  fctx.body.push({ op: "local.get", index: 1 } as Instr); // this
  emitThisReceiverGuardConvert(
    ctx,
    fctx,
    targets,
    resultType,
    (concreteType) => {
      // `concreteType` = (ref vecTypeIdx); stash into a vec local.
      const vecTypeIdx = (concreteType as { typeIdx: number }).typeIdx;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const vecLocal = allocLocal(fctx, `__pm_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
      fctx.body.push({ op: "local.set", index: vecLocal } as Instr);
      compileArraySliceFromVecLocal(ctx, fctx, vecLocal, vecTypeIdx, arrTypeIdx, startLocal, endLocal);
      fctx.body.push({ op: "extern.convert_any" } as Instr); // vec → externref
    },
    () => {
      // Non-array (genuine host) `this`: no compiled backing → return undefined.
      fctx.body.push({ op: "ref.null.extern" } as Instr);
    },
  );
  return resultType;
}

function makeGlue(
  ctx: CodegenContext,
  brand: number,
  name: string,
  members: readonly string[],
): NativeProtoBuiltinGlue {
  return {
    brand,
    name,
    memberCsv: members.join(","),
    // Array/Object.prototype members are all data methods (no accessor getters
    // on the prototype itself; `length` is an own data property of an instance,
    // not the proto).
    memberKind: () => "method",
    memberLength: (member) => PROTO_METHOD_LENGTH[member] ?? 1,
    // (#2193 PR-B) Array.prototype.slice is now a real native closure body; other
    // Array members + all Object members still degrade to a catchable TypeError.
    emitMemberBody: (c, fctx, member) =>
      name === "Array" ? emitArrayProtoMemberBody(c, fctx, member) : emitProtoMemberBodyRefusal(c, fctx, name, member),
  };
}

/**
 * Register `Array.prototype` glue (idempotent) and return its brand, or
 * `undefined` if the Array brand isn't reserved (should not happen).
 */
export function ensureArrayNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Array");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Array", ARRAY_PROTO_METHODS));
  }
  return brand;
}

/** Register `Object.prototype` glue (idempotent) and return its brand. */
export function ensureObjectNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Object");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Object", OBJECT_PROTO_METHODS));
  }
  return brand;
}

/**
 * Register `String.prototype` glue (idempotent) and return its brand. (#1907 /
 * #1888 S6-b — S4 wrapper protos.) The String brand is pre-reserved in
 * `BUILTIN_BRAND_TABLE`; this only fills in the member CSV so a bare
 * `String.prototype` / `String.prototype.<method>` value read resolves host-free
 * instead of refusing. Reflective member-CLOSURE bodies still degrade to a
 * catchable TypeError (`emitProtoMemberBodyRefusal`) until per-member native
 * bodies land — the value-read object itself needs only the member set.
 */
export function ensureStringNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "String");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "String", STRING_PROTO_METHODS));
  }
  return brand;
}

/** Register `Number.prototype` glue (idempotent) and return its brand. */
export function ensureNumberNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Number");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Number", NUMBER_PROTO_METHODS));
  }
  return brand;
}

/** Register `Boolean.prototype` glue (idempotent) and return its brand. */
export function ensureBooleanNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Boolean");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Boolean", BOOLEAN_PROTO_METHODS));
  }
  return brand;
}

/**
 * Register `Date.prototype` glue (idempotent) and return its brand. (#1907 /
 * #1888 S6-b — S5.) The Date brand is pre-reserved in `BUILTIN_BRAND_TABLE`;
 * this only fills in the member CSV so a bare `Date.prototype` /
 * `Date.prototype.<method>` value read resolves host-free instead of refusing.
 * Reflective member-CLOSURE bodies still degrade to a catchable TypeError until
 * per-member native bodies land — the value-read OBJECT + `.length`/`.name`
 * meta folds need only the member set.
 */
export function ensureDateNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Date");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Date", DATE_PROTO_METHODS));
  }
  return brand;
}

/** Register `Error.prototype` glue (idempotent) and return its brand. (S6) */
export function ensureErrorNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Error");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Error", ERROR_PROTO_METHODS));
  }
  return brand;
}

/** Register `Map.prototype` glue (idempotent) and return its brand. (S6) */
export function ensureMapNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Map");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Map", MAP_PROTO_METHODS));
  }
  return brand;
}

/** Register `Set.prototype` glue (idempotent) and return its brand. (S6) */
export function ensureSetNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Set");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Set", SET_PROTO_METHODS));
  }
  return brand;
}

/** Register `Function.prototype` glue (idempotent) and return its brand. (S7) */
export function ensureFunctionNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Function");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Function", FUNCTION_PROTO_METHODS));
  }
  return brand;
}

/** Register `Symbol.prototype` glue (idempotent) and return its brand. (S7) */
export function ensureSymbolNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Symbol");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Symbol", SYMBOL_PROTO_METHODS));
  }
  return brand;
}

/** Register `BigInt.prototype` glue (idempotent) and return its brand. (S7) */
export function ensureBigIntNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "BigInt");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "BigInt", BIGINT_PROTO_METHODS));
  }
  return brand;
}

/** Register `WeakMap.prototype` glue (idempotent) and return its brand. (S7) */
export function ensureWeakMapNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "WeakMap");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "WeakMap", WEAKMAP_PROTO_METHODS));
  }
  return brand;
}

/** Register `WeakSet.prototype` glue (idempotent) and return its brand. (S7) */
export function ensureWeakSetNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "WeakSet");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "WeakSet", WEAKSET_PROTO_METHODS));
  }
  return brand;
}
