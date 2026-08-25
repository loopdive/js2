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
  emitBrandCheckTypeError,
  emitLazyNativeProtoGet,
  ensureStandaloneNativeMethodClosure,
  type NativeProtoBuiltinGlue,
} from "./native-proto.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { ensureNativeArrayHof, NATIVE_HOF_METHODS, NATIVE_HOF_REDUCE } from "./hof-native.js"; // (#4394)
import { emitArrayBufferProtoMemberBody, emitDataViewProtoMemberBody } from "./dataview-native.js";
import { emitDateProtoMemberBody } from "./expressions/builtins.js"; // (#3219) reflective Date getter bodies
import { emitDateReflectiveSetterBody } from "./date-reflective-setters.js"; // (#3174) reflective Date setter/toISOString bodies
import { allocLocal } from "./context/locals.js";
import { emitBoxedProtoValueOfBody } from "./boxed-proto-valueof.js"; // (#4582)
import { emitThisReceiverGuardConvert } from "./property-access.js";
import { compileArraySliceFromVecLocal } from "./array-methods.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { undefinedExternInstrs, undefinedSingletonActive } from "./any-helpers.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import {
  ensureAnyToStringHelper,
  ensureNativeStringHelpers,
  flatStringType,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { COLLECTION_KIND, MAP_LAYOUT, ensureMapHelpers } from "./map-runtime.js"; // (#3171) size getter
import { emitReceiverBrandCheck } from "./receiver-brand.js"; // (#3171) shared brand preamble
import { pushMarkBuiltinCarrierCallable } from "./builtin-callable-brand.js"; // %TypedArray% carrier is a function
import { emitTransferredCharAtProtoMemberBody, unboxProtoArgToI32 as unboxArgToI32 } from "./char-at-transfer.js";
// (#4119) The shared member-body tail: `Object.prototype.toString`'s real
// §20.1.3.6 runtime classifier, and the graceful catchable-TypeError refusal for
// every `(brand, member)` whose native body is not wired yet. Aliased to the
// name the 14 existing call sites already use — it subsumes the local helper
// that previously lived here, whose body it reproduces exactly for non-Object
// brands (a reflective member closure must degrade to a catchable TypeError, not
// a hard compile error — #2193 PR-C).
import { emitObjectProtoOrRefusal as emitProtoMemberBodyRefusal } from "./object-proto-tostring.js";
// (#4491) `Object.prototype.isPrototypeOf` — the §20.1.3.3 chain walk, routed
// to the same `__isPrototypeOf` native the typed call path uses.
import { emitObjectProtoIsPrototypeOfBody } from "./object-proto-is-prototype-of.js";
// (#4479 slice 2) Annex B §B.2.2's four legacy accessor methods — the reflective
// member bodies for `Object.prototype.__{define,lookup}{Getter,Setter}__`.
import { ANNEX_B_ACCESSOR_ARITY, emitObjectProtoAnnexBAccessorBody } from "./object-proto-annex-b-accessors.js";
import { emitWrapperProtoValueOfBody, isWrapperBrandName } from "./wrapper-proto-value-of.js";
import { emitWrapperProtoToStringBody } from "./wrapper-proto-to-string.js"; // (#4619)
import { emitFunctionProtoToStringBody } from "./function-proto-to-string.js"; // (#4492 wave-5)
import { emitObjectProtoValueOfBody } from "./object-proto-value-of.js"; // (#4492 wave-5)
import { emitStringConcatMemberBody } from "./string-proto-concat.js";
import { emitStringSubstringMemberBody } from "./string-proto-substring.js";
import { emitStringSplitMemberBody } from "./string-proto-split.js"; // (#4220) reflective String.prototype.split
import { htmlWrapperFor } from "./html-wrapper-native.js"; // (#4445) Annex B §B.2.3 tag table
import { emitStringHtmlWrapperMemberBody } from "./string-proto-html.js"; // (#4445) reflective HTML wrappers
import { emitStringMatchSearchMemberBody } from "./string-proto-match-search.js"; // (#4439) reflective match/search
import { emitStringReplaceMemberBody } from "./string-proto-replace-transfer.js"; // (#4232) reflective String.prototype.replace
import {
  NO_ARG_STRING_MEMBER_HELPER,
  SUPERSEDED_BY_BORROWED_PATH,
  emitStringProtoToStringFlat,
} from "./string-proto-tostring.js"; // (#3992)
import { standaloneGlobalFunctionSeedInstrs } from "./standalone-global-functions.js";
import { emitBuiltinNamespaceObject } from "./builtin-static-globals.js";
import { emitFunctionProtoHasInstanceBody, FUNCTION_PROTO_HAS_INSTANCE_MEMBER } from "./function-proto-has-instance.js";

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

/**
 * `Object.prototype`'s own method names (ES2024 §20.1.3), plus Annex B §B.2.2's
 * four legacy accessor methods (#4479 slice 2), which are own properties of
 * `Object.prototype` in every web-reality engine and are asserted as such by
 * `built-ins/Object/prototype/__{define,lookup}{Getter,Setter}__/prop-desc.js`.
 * Their bodies live in `object-proto-annex-b-accessors.ts`; listing them here is
 * what makes `Object.prototype.__defineGetter__` resolve as a value at all.
 */
const OBJECT_PROTO_METHODS = [
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
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
  "getYear", // (#2671) Annex B §B.2.4 legacy getter
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
  "setYear", // (#4485) Annex B §B.2.4.2 legacy setter
  "toDateString",
  "toGMTString", // (#4485) Annex B §B.2.4.3 — same function object as toUTCString
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
 * Annex-B (`substr`, and since #4445 the 13 §B.2.3 HTML wrappers) is included so
 * a bare `String.prototype.substr` / `String.prototype.anchor` value read
 * resolves host-free.
 */
const STRING_PROTO_METHODS = [
  "anchor",
  "at",
  "big",
  "blink",
  "bold",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "concat",
  "endsWith",
  "fixed",
  "fontcolor",
  "fontsize",
  "includes",
  "indexOf",
  "isWellFormed",
  "italics",
  "lastIndexOf",
  "link",
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
  "small",
  "split",
  "startsWith",
  "strike",
  "sub",
  "substr",
  "substring",
  "sup",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "toWellFormed",
  "trim",
  "trimEnd",
  "trimLeft",
  "trimRight",
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

/** (#2861) `NativeError.prototype`'s own method names — a `<NativeError>.prototype`
 * (TypeError/RangeError/ReferenceError/SyntaxError/EvalError/URIError) inherits
 * `toString` from `Error.prototype`; its own data props (`constructor`/`name`/
 * `message`) are not methods. The shared method member set mirrors Error's so
 * the proto value object + `.length`/`.name` meta-fold resolve host-free. */
const NATIVE_ERROR_PROTO_METHODS = ["toString"] as const;

/** (#2861) `Promise.prototype`'s own method names (ES2024 §27.2.5). Only the
 * static `.prototype` VALUE read + these method-closure value reads are wired
 * here; instance-state reads were deliberately excluded in #1907 (async
 * capability null-deref), so this glue NEVER touches runtime promise state. */
const PROMISE_PROTO_METHODS = ["catch", "finally", "then"] as const;

/** (#2861) `Iterator.prototype`'s own helper method names (ES2025 iterator
 * helpers, §27.1.4). `[Symbol.iterator]` is a computed key handled elsewhere. */
const ITERATOR_PROTO_METHODS = [
  "drop",
  "every",
  "filter",
  "find",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "some",
  "take",
  "toArray",
] as const;

/** `Function.prototype`'s own method names (ES2024 §20.2.3). */
const FUNCTION_PROTO_METHODS = ["apply", "bind", "call", "toString", FUNCTION_PROTO_HAS_INSTANCE_MEMBER] as const;

/** `Symbol.prototype`'s own method names (ES2024 §20.4.3). `description` is an
 * accessor getter, resolved by the computed-access path. */
const SYMBOL_PROTO_METHODS = ["toString", "valueOf"] as const;

/** `BigInt.prototype`'s own method names (ES2024 §21.2.3). */
const BIGINT_PROTO_METHODS = ["toLocaleString", "toString", "valueOf"] as const;

/** `WeakMap.prototype`'s own method names (ES2024 §24.3.3 + ES2025 emplace). */
const WEAKMAP_PROTO_METHODS = ["delete", "get", "getOrInsert", "getOrInsertComputed", "has", "set"] as const;

/** `WeakSet.prototype`'s own method names (ES2024 §24.4.3). */
const WEAKSET_PROTO_METHODS = ["add", "delete", "has"] as const;

/**
 * `Map.prototype`'s own method names (ES2024 §24.1.3). `size` is an accessor
 * *getter* on the proto (resolved by the computed-access path), not a data
 * method, so it stays out of the value-read CSV.
 */
const MAP_PROTO_METHODS = [
  "clear",
  "delete",
  "entries",
  "forEach",
  "get",
  "getOrInsert",
  "getOrInsertComputed",
  "has",
  "keys",
  "set",
  "values",
] as const;

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

/**
 * (#2651 M1 / D2) The abstract `%TypedArray%.prototype` member names (ES2024
 * §23.2.3). ALL concrete TypedArray view prototypes (`Int8Array.prototype`, …)
 * inherit these from `%TypedArray%.prototype` — the concrete-view protos carry
 * essentially no own members of their own (only `BYTES_PER_ELEMENT`/`constructor`
 * which are data, not on the value-read CSV), so each concrete view shares this
 * single member set. The four accessor getters (`buffer`, `byteLength`,
 * `byteOffset`, `length`) are spelled as getters (`memberKind` → "getter") so the
 * `.length`/`.name` meta-fold reports the getter's 0 arity. `@@iterator` /
 * `@@toStringTag` are well-known-symbol members resolved by the computed-access
 * path, so only the string members go in the CSV (same convention as
 * `ARRAY_PROTO_METHODS`).
 *
 * Per the #2375 caution (TypedArray views carry vec/runtime-state entanglement),
 * this is a PURE value-read object: `emitLazyNativeProtoGet` materializes the
 * member CSV only and never calls `emitMemberBody`; a reflective member-closure
 * read degrades to a catchable TypeError (`emitProtoMemberBodyRefusal`). The
 * method *bodies* live on the existing native instance-method vec dispatch and
 * are reached through the instance, NOT re-emitted on this proto value.
 */
const TYPED_ARRAY_PROTO_METHODS = [
  "at",
  "copyWithin",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "reverse",
  "set",
  "slice",
  "some",
  "sort",
  "subarray",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toString",
  "values",
  "with",
  // Accessor getters (ES2024 §23.2.3.{1,2,3,18}). Marked as getters below so the
  // meta-fold reports 0 arity; kept in the CSV so a `TA.prototype.buffer` value
  // read resolves (the descriptor exists) rather than fabricating undefined.
  "buffer",
  "byteLength",
  "byteOffset",
  "length",
] as const;

/** The `%TypedArray%.prototype` accessor-getter member names (ES2024 §23.2.3). */
const TYPED_ARRAY_PROTO_GETTERS: ReadonlySet<string> = new Set(["buffer", "byteLength", "byteOffset", "length"]);

/**
 * (#2651 M1) `%TypedArray%.prototype` method spec arities that differ from the
 * default 1 (ES2024 §23.2.3). Kept SEPARATE from the global `PROTO_METHOD_LENGTH`
 * because some names collide with other builtins at a DIFFERENT arity — notably
 * `set`: `%TypedArray%.prototype.set` is arity 1 (§23.2.3.26) but
 * `Map.prototype.set` is arity 2. A per-family override avoids cross-contaminating
 * the shared table.
 */
const TYPED_ARRAY_PROTO_METHOD_LENGTH: Readonly<Record<string, number>> = {
  copyWithin: 2,
  set: 1,
  subarray: 2,
  with: 2,
  // Zero-arity (no-arg) members.
  entries: 0,
  keys: 0,
  reverse: 0,
  toLocaleString: 0,
  toReversed: 0,
  toString: 0,
  values: 0,
  // The remaining iteration/search/accessor methods (at, every, fill, filter,
  // find*, forEach, includes, indexOf, join, lastIndexOf, map, reduce*, slice,
  // some, sort, toSorted) are arity 1 — the default.
};

/**
 * Spec arity (`fn.length`) of the proto methods that differ from the default 1.
 *
 * (#3181) NULL-PROTOTYPED. A plain object literal inherits `Object.prototype`,
 * so a lookup of an inherited method name (`toString`/`valueOf`/`toLocaleString`/
 * `constructor`/`hasOwnProperty`…) returned the INHERITED FUNCTION, not
 * `undefined` — which slipped past the `?? 1` guard and folded `.length` to a
 * `Function` value → NaN (e.g. `Number.prototype.toString.length`,
 * `Array.prototype.toString.length`). With a null prototype, unlisted names
 * resolve to `undefined` and the `?? 1` fallback fires as intended. The three
 * `Object.prototype`-shadowed names below are given EXPLICIT arities (all 0 for
 * every family; Number.prototype.toString(radix) is arity 1 — overridden in the
 * Number glue's `memberLength`, since this table is shared cross-family).
 */
const PROTO_METHOD_LENGTH: Readonly<Record<string, number>> = Object.assign(
  Object.create(null) as Record<string, number>,
  {
    // Object.prototype-shadowed method names (see the null-proto note above).
    toString: 0,
    valueOf: 0,
    toLocaleString: 0,
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
    // (#4479 slice 2) Annex B §B.2.2, declared beside the bodies that read the
    // arg slots this arity sizes.
    ...ANNEX_B_ACCESSOR_ARITY,
    // Map.prototype.set(key, value) is arity 2 (ES2024 §24.1.3); add/get/has/delete
    // default to 1.
    set: 2,
    // (#3172) ES2025 Map/WeakMap emplace additions — both arity 2.
    getOrInsert: 2,
    getOrInsertComputed: 2,
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
    trimLeft: 0,
    trimRight: 0,
    trimStart: 0,
    isWellFormed: 0,
    toWellFormed: 0,
    // (#4445) Annex B §B.2.3 HTML wrappers. `fn.length` is 1 for the four that
    // take an attribute value (anchor/link/fontcolor/fontsize — the shared
    // default already), 0 for the nine tag-only ones; the 0s are load-bearing,
    // since the arity also sizes the closure's param slots and a spurious slot
    // would make the body read an arg that was never declared.
    big: 0,
    blink: 0,
    bold: 0,
    fixed: 0,
    italics: 0,
    small: 0,
    strike: 0,
    sub: 0,
    sup: 0,
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
    getYear: 0, // (#2671) Annex B §B.2.4 legacy getter (0-arity)
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
    // (#4485) Annex B §B.2.4.3 `toGMTString` IS `toUTCString` (same function
    // object), so it must report the same 0 arity.
    toGMTString: 0,
    // (#3174) Date.prototype.toLocale{Date,Time}String take only OPTIONAL
    // (reserved locales/options) params — spec `.length` is 0 (§21.4.4.39/40).
    // `toLocaleString` (also 0) is already in the shared table above.
    toLocaleDateString: 0,
    toLocaleTimeString: 0,
    // toJSON is 1 (the `key` param). entries/keys/values/reverse/pop/shift/
    // toString/valueOf/… default to 0 or 1; the value-read OBJECT does not depend
    // on exact arities, only the member set.
    toJSON: 1,
    // WeakRef.prototype.deref (ES2024 §26.1.3.2) is 0-arity; FinalizationRegistry.
    // prototype.register (§26.2.3.1) is arity 2, unregister (§26.2.3.2) arity 1.
    // These names don't collide with other builtins, so they live in the shared
    // table safely.
    deref: 0,
    register: 2,
    unregister: 1,
  },
);

/**
 * (#2875 slice 3) ABI param-slot counts for `String.prototype` members whose
 * trailing OPTIONAL arg is NOT counted by `fn.length` — `indexOf(searchString,
 * position)` etc. are spec length 1 but take a second arg. The reflective
 * closure's lifted func type sizes to this slot count (so the optional arg has
 * a real param index — reading a nonexistent param index lands on the first
 * DECLARED LOCAL and emits invalid Wasm), while `.length` keeps reporting the
 * spec arity via `nativeClosureMeta`. Call surfaces pad missing args with
 * `ref.null.extern` (undefined). Scoped to String so every other family's
 * closure types stay byte-identical.
 */
const STRING_PROTO_METHOD_PARAM_SLOTS: Readonly<Record<string, number>> = {
  indexOf: 2, // (searchString, position) §22.1.3.8
  lastIndexOf: 2, // (searchString, position) §22.1.3.9
  includes: 2, // (searchString, position) §22.1.3.7
  startsWith: 2, // (searchString, position) §22.1.3.23
  endsWith: 2, // (searchString, endPosition) §22.1.3.6
  // (#4426 session) `concat(...args)` is variadic (spec `.length` 1). Four real
  // slots cover every ES5-shaped borrow (test262 uses ≤3); the call path pads
  // absent slots with null (skipped per §22.1.3.5 step 3) and truncates a
  // longer tail — the 128-arg S15.5.4.6_A2 is a documented residual.
  concat: 4,
};

// ── ArrayBuffer.prototype (ES2024 §25.1.5) ────────────────────────────────────
// Method names + accessor getters. Getters (`byteLength`/`maxByteLength`/
// `detached`/`resizable`) are marked below so their `.length` meta folds to 0.
// The value-read OBJECT only needs the member set; reflective member closures
// degrade to a catchable TypeError until per-member native bodies land.
const ARRAYBUFFER_PROTO_METHODS = [
  "slice",
  "resize",
  "transfer",
  "transferToFixedLength",
  // Accessor getters (§25.1.5.{1,2,3,4}).
  "byteLength",
  "maxByteLength",
  "detached",
  "resizable",
] as const;
const ARRAYBUFFER_PROTO_GETTERS: ReadonlySet<string> = new Set([
  "byteLength",
  "maxByteLength",
  "detached",
  "resizable",
]);
const ARRAYBUFFER_PROTO_METHOD_LENGTH: Readonly<Record<string, number>> = {
  slice: 2,
  resize: 1,
  transfer: 0,
  transferToFixedLength: 0,
};

// ── DataView.prototype (ES2024 §25.3.4) ───────────────────────────────────────
// All `get<Type>` methods are arity 1, all `set<Type>` arity 2. The accessor
// getters `buffer`/`byteLength`/`byteOffset` (§25.3.4.{1,2,3}) fold to 0.
const DATAVIEW_GET_TYPES = [
  "getInt8",
  "getUint8",
  "getInt16",
  "getUint16",
  "getInt32",
  "getUint32",
  "getFloat16",
  "getFloat32",
  "getFloat64",
  "getBigInt64",
  "getBigUint64",
] as const;
const DATAVIEW_SET_TYPES = [
  "setInt8",
  "setUint8",
  "setInt16",
  "setUint16",
  "setInt32",
  "setUint32",
  "setFloat16",
  "setFloat32",
  "setFloat64",
  "setBigInt64",
  "setBigUint64",
] as const;
const DATAVIEW_PROTO_METHODS = [
  ...DATAVIEW_GET_TYPES,
  ...DATAVIEW_SET_TYPES,
  // Accessor getters (§25.3.4.{1,2,3}).
  "buffer",
  "byteLength",
  "byteOffset",
] as const;
const DATAVIEW_PROTO_GETTERS: ReadonlySet<string> = new Set(["buffer", "byteLength", "byteOffset"]);
const DATAVIEW_PROTO_METHOD_LENGTH: Readonly<Record<string, number>> = {
  ...Object.fromEntries(DATAVIEW_GET_TYPES.map((m) => [m, 1])),
  ...Object.fromEntries(DATAVIEW_SET_TYPES.map((m) => [m, 2])),
};

// ── SharedArrayBuffer.prototype (ES2024 §25.2.5) ──────────────────────────────
// Mirrors ArrayBuffer's shape: `slice`/`grow` methods + `byteLength`/
// `maxByteLength`/`growable` accessor getters (getters fold `.length` to 0).
const SHAREDARRAYBUFFER_PROTO_METHODS = ["slice", "grow", "byteLength", "maxByteLength", "growable"] as const;
const SHAREDARRAYBUFFER_PROTO_GETTERS: ReadonlySet<string> = new Set(["byteLength", "maxByteLength", "growable"]);
const SHAREDARRAYBUFFER_PROTO_METHOD_LENGTH: Readonly<Record<string, number>> = {
  slice: 2,
  grow: 1,
};

// ── WeakRef.prototype (ES2024 §26.1.3) ── single `deref` method (0-arity). ────
const WEAKREF_PROTO_METHODS = ["deref"] as const;

// ── FinalizationRegistry.prototype (ES2024 §26.2.3) ───────────────────────────
// `register` (arity 2) + `unregister` (arity 1). Arities live in the shared
// PROTO_METHOD_LENGTH table (no cross-builtin collision).
const FINALIZATIONREGISTRY_PROTO_METHODS = ["register", "unregister"] as const;

// ── DisposableStack.prototype (TC39 Explicit Resource Management §12.3) ───────
// `use`(1) / `adopt`(2) / `defer`(1) / `move`(0) / `dispose`(0) data methods +
// the `disposed` accessor getter (folds `.length` to 0). The `[Symbol.dispose]`
// / `[Symbol.toStringTag]` symbol members are keyed by symbol, not string, so
// they are outside the string member CSV (same as every other glue). The
// resource list lives on the INSTANCE, so the proto value object is pure.
const DISPOSABLESTACK_PROTO_METHODS = ["dispose", "use", "adopt", "defer", "move", "disposed"] as const;
const DISPOSABLESTACK_PROTO_GETTERS: ReadonlySet<string> = new Set(["disposed"]);
const DISPOSABLESTACK_PROTO_METHOD_LENGTH: Readonly<Record<string, number>> = {
  dispose: 0,
  use: 1,
  adopt: 2,
  defer: 1,
  move: 0,
};

// ── AsyncDisposableStack.prototype (TC39 Explicit Resource Management §12.4) ──
// Mirror of DisposableStack with `disposeAsync`(0) in place of `dispose`; the
// `[Symbol.asyncDispose]` / `[Symbol.toStringTag]` symbol members stay outside
// the string CSV.
const ASYNCDISPOSABLESTACK_PROTO_METHODS = ["disposeAsync", "use", "adopt", "defer", "move", "disposed"] as const;
const ASYNCDISPOSABLESTACK_PROTO_GETTERS: ReadonlySet<string> = new Set(["disposed"]);
const ASYNCDISPOSABLESTACK_PROTO_METHOD_LENGTH: Readonly<Record<string, number>> = {
  disposeAsync: 0,
  use: 1,
  adopt: 2,
  defer: 1,
  move: 0,
};

/**
 * (#2193 PR-B) Emit the native body for an `Array.prototype.<member>` closure
 * value. `this` is closure-param 1 (externref boxed array), args at 2.. . Recovers
 * the array instance via the registered-vec `ref.test`/`ref.cast` guard, then
 * delegates to the AST-free `compileArray<member>FromVecLocal` core. Members
 * without a native local-driven core yet degrade to a catchable TypeError (not a
 * compile refusal). Returns externref (the uniform closure-call result type).
 */
function emitArrayProtoMemberBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | null {
  // (#4394) The higher-order members already have a native standalone loop —
  // `__hof_<name>`, emitted by `ensureNativeArrayHof` for the DYNAMIC receiver
  // arm. It reads its receiver through `__extern_length` / `__extern_get_idx`,
  // so it serves an arbitrary array-LIKE, which is exactly what the reflective
  // `Array.prototype.map.call(arguments, String)` form needs. Route to it
  // instead of throwing; `compareArray.format` in the test262 harness is that
  // exact call, and its TypeError was surfacing as a bogus `error.constructor`
  // on nine standalone harness tests.
  //
  // The reduce family takes `(recv, cb, init, hasInit)` rather than
  // `(recv, cb, thisArg)`, so it stays on the refusal until its own arg
  // marshalling is written.
  if (member !== "slice" && NATIVE_HOF_METHODS.has(member) && !NATIVE_HOF_REDUCE.has(member)) {
    const hofIdx = ensureNativeArrayHof(ctx, member);
    if (hofIdx !== undefined) {
      // §23.1.3 step 1: ToObject(this) — a null/undefined receiver is a
      // TypeError BEFORE any iteration. The old refusal threw for every
      // receiver, so `Array.prototype.map.call(undefined)` passed by accident;
      // routing to the loop without this guard silently returns an empty
      // result instead (measured: 3 regressions in the map/filter suites).
      // Mirrors the `String.prototype.<member>` receiver guard below: under the
      // undefined-singleton regime `undefined` is a NON-null sentinel externref,
      // so `ref.is_null` alone misses `.call(undefined)`.
      const thisThrow: Instr[] = [];
      emitBrandCheckTypeError(ctx, thisThrow, `Array.prototype.${member} called on null or undefined`);
      fctx.body.push({ op: "local.get", index: 1 }, { op: "ref.is_null" });
      const isUndefinedIdx = undefinedSingletonActive(ctx) ? ctx.funcMap.get("__extern_is_undefined") : undefined;
      if (isUndefinedIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: isUndefinedIdx }, { op: "i32.or" });
      }
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thisThrow });
      // The closure ABI declares only as many params as the member's own
      // `.length`, so `thisArg` (param 3) exists for `map`/`forEach`/… but not
      // for the 1-arity members. Substitute a null externref when absent
      // rather than reading a slot that was never declared.
      const paramCount = fctx.params.length;
      fctx.body.push({ op: "local.get", index: 1 }); // receiver (`this`)
      fctx.body.push(paramCount > 2 ? { op: "local.get", index: 2 } : { op: "ref.null.extern" }); // callback
      fctx.body.push(paramCount > 3 ? { op: "local.get", index: 3 } : { op: "ref.null.extern" }); // thisArg
      fctx.body.push({ op: "call", funcIdx: hofIdx });
      return { kind: "externref" };
    }
  }
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
  fctx.body.push({ op: "local.get", index: 1 }); // this
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
      fctx.body.push({ op: "local.set", index: vecLocal });
      compileArraySliceFromVecLocal(ctx, fctx, vecLocal, vecTypeIdx, arrTypeIdx, startLocal, endLocal);
      fctx.body.push({ op: "extern.convert_any" }); // vec → externref
    },
    () => {
      // Non-array (genuine host) `this`: no compiled backing → return undefined.
      fctx.body.push({ op: "ref.null.extern" });
    },
  );
  return resultType;
}

/**
 * (#2875) Register the native `__extern_is_undefined` predicate early — BEFORE a
 * reflective String proto body's other late-import-adding ops — so the
 * RequireObjectCoercible guard can fetch its post-shift funcIdx by name. Gated on
 * the #2106 undefinedSingleton regime (standalone/native-strings): only there is
 * `undefined` a DISTINCT non-null sentinel externref that a bare `ref.is_null`
 * misses. Idempotent; `flushLateImportShifts` keeps `fctx.body` consistent if the
 * ensure added an import batch (matters for the trim body, which has no other
 * late-import op of its own).
 */
function ensureStringRocUndefinedNative(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!undefinedSingletonActive(ctx)) return;
  ensureObjectRuntime(ctx);
  flushLateImportShifts(ctx, fctx);
}

/**
 * (#2875) Emit RequireObjectCoercible(this) (§22.1.3.1 step 1) for a reflective
 * `String.prototype.<member>` closure body: throw a catchable TypeError when
 * `this` (closure param 1, externref) is null OR undefined.
 *
 * In standalone under the #2106 undefinedSingleton regime, `undefined` is a
 * DISTINCT non-null sentinel externref, so a bare `ref.is_null` catches `null`
 * but MISSES `undefined` — `String.prototype.<m>.call(undefined)` wrongly
 * ToString'd it to "undefined" and returned a value instead of throwing. OR-in
 * the canonical native `__extern_is_undefined` (host-free; registered up front by
 * `ensureStringRocUndefinedNative` so its funcIdx is post-shift-correct here).
 * When the regime is inactive, `undefined` ≡ `ref.null.extern` and the bare
 * `ref.is_null` already covers both.
 */
function emitStringRequireObjectCoercible(ctx: CodegenContext, fctx: FunctionContext, member: string): void {
  const rocThrow: Instr[] = [];
  emitBrandCheckTypeError(ctx, rocThrow, `String.prototype.${member} called on null or undefined`);
  fctx.body.push({ op: "local.get", index: 1 });
  fctx.body.push({ op: "ref.is_null" });
  const isUndefIdx = undefinedSingletonActive(ctx) ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  if (isUndefIdx !== undefined) {
    // `undefined` is a non-null sentinel externref here → also test it explicitly.
    fctx.body.push({ op: "local.get", index: 1 });
    fctx.body.push({ op: "call", funcIdx: isUndefIdx });
    fctx.body.push({ op: "i32.or" });
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rocThrow });
}

/**
 * (#2875 slice 1) Native body for a reflective `String.prototype.<member>`
 * closure. `this` is closure-param 1 (externref); user args at 2.. (externref-
 * boxed). Implements §22.1.3.x steps: `? RequireObjectCoercible(this)` →
 * `? ToString(this)` → the member core → box the result to the uniform closure
 * result (externref). This is what makes `String.prototype.X.call(thisArg, …)`
 * (`emitReflectiveNativeProtoClosureCall`, calls.ts) work instead of falling
 * through to the legacy `.call` that drops `thisArg` and returns 0.
 *
 * Slice 1 wires the index-accessor family; unwired members keep their existing catchable-TypeError fallback.
 *
 * Funcidx/type-index discipline: the ONLY late-import adder here is
 * `unboxArgToI32` (its `__unbox_number`); it runs FIRST (mirroring
 * `emitArrayProtoMemberBody`) and flushes, so every helper funcIdx fetched by
 * NAME afterwards is post-shift-correct. The native-string helpers and
 * `$__any_to_string` are functions (append-only, no index shift).
 */
function emitStringProtoMemberBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | null {
  // (#4582) `thisStringValue`, not a string OPERATION — boxed-proto-valueof.ts.
  if (member === "valueOf")
    return emitBoxedProtoValueOfBody(ctx, fctx, "String") ?? emitProtoMemberBodyRefusal(ctx, fctx, "String", member);
  // (#2742) The superseded-wiring carve-out — see string-proto-tostring.ts.
  if (SUPERSEDED_BY_BORROWED_PATH.has(member)) return emitProtoMemberBodyRefusal(ctx, fctx, "String", member);

  const IN_SCOPE = new Set(["at", "charCodeAt", "codePointAt"]);
  if (member === "substring") return emitStringSubstringMemberBody(ctx, fctx);
  // (#2875 slice C) `slice` (§22.1.3.22) shares `substring`'s closure ABI —
  // `this`/start/end, same `0x7fffffff` absent-end sentinel — and `__str_slice`
  // has the identical helper signature, differing only in resolving negative
  // indices rather than swapping reversed bounds. Without this it fell through
  // to `emitProtoMemberBodyRefusal`, so a borrowed `slice` threw
  // "not yet implemented in --target standalone".
  if (member === "slice") return emitStringSubstringMemberBody(ctx, fctx, "slice");
  // (#4220) `split` (§22.1.3.23) returns an ARRAY, not a string/index/boolean,
  // so it owns a body rather than joining a family above; a null refusal keeps
  // the pre-#4220 behaviour via the shared refusal.
  if (member === "split")
    return emitStringSplitMemberBody(ctx, fctx) ?? emitProtoMemberBodyRefusal(ctx, fctx, "String", member);
  // (#4426 session) `concat` (§22.1.3.5) — variadic string-returning append
  // over the padded arg slots; see string-proto-concat.ts for the pad-vs-
  // undefined discipline. Same refusal fallback as its siblings.
  if (member === "concat")
    return emitStringConcatMemberBody(ctx, fctx) ?? emitProtoMemberBodyRefusal(ctx, fctx, "String", member);
  // (#4439) `match` / `search` (§22.1.3.14 / §22.1.3.17) — the two members that
  // build a RegExp from their argument. Unlike `split`'s ToString-only arm they
  // reach the standalone regex engine, via a RUNTIME two-lane argument dispatch
  // (`ref.test $NativeRegExp` vs `__regex_compile_dynamic_simple`); see
  // string-proto-match-search.ts. Same refusal fallback as the siblings, which
  // is also what keeps the host lane byte-identical (the body declines there).
  if (member === "match" || member === "search")
    return (
      emitStringMatchSearchMemberBody(ctx, fctx, member) ?? emitProtoMemberBodyRefusal(ctx, fctx, "String", member)
    );
  // (#4232) `replace` (§22.1.3.19) is `split`'s sibling in every structural
  // respect — reflective closure ABI, string-returning, ToString-everything —
  // and was the arm #4224 named as its leftover. Same refusal fallback.
  if (member === "replace")
    return (
      emitStringReplaceMemberBody(ctx, fctx, () => emitStringRequireObjectCoercible(ctx, fctx, member)) ??
      emitProtoMemberBodyRefusal(ctx, fctx, "String", member)
    );
  // (#2875 slice 3a) The number-returning search family — `indexOf` /
  // `lastIndexOf` — has a DIFFERENT closure ABI from the index accessors
  // (param 2 is the search STRING, not an integer position; the optional
  // position is param 3), so it gets a dedicated body rather than the
  // integer-position path below. Routed FIRST so it bypasses the index-accessor
  // code entirely — keeping that path byte-identical to slices 1–2.
  const SEARCH_NUMERIC = new Set(["indexOf", "lastIndexOf"]);
  if (SEARCH_NUMERIC.has(member)) return emitStringSearchNumericMemberBody(ctx, fctx, member);
  // (#2875 slice 3b) The BOOLEAN-returning search family shares the two-string
  // ABI of 3a but boxes an i32 boolean result via __box_boolean.
  const SEARCH_BOOLEAN = new Set(["includes", "startsWith", "endsWith"]);
  if (SEARCH_BOOLEAN.has(member)) return emitStringSearchBooleanMemberBody(ctx, fctx, member);
  // (#3217) The whitespace-trim family — `trim` / `trimStart` / `trimEnd` —
  // returns a STRING (not an index/boolean) and takes NO args, so it has a
  // dedicated body: `? RequireObjectCoercible(this)` → `? ToString(this)` →
  // the native `__str_trim*` helper. Routed here so it never reads the absent
  // arg-2 slot the char/search bodies unbox (these closures have arity 0).
  // (#3992) The case-conversion family (§22.1.3.{26,27,28,29}) shares that
  // shape, so it shares this body rather than getting a fourth per-member
  // clone — see NO_ARG_STRING_MEMBER_HELPER in string-proto-tostring.ts.
  if (NO_ARG_STRING_MEMBER_HELPER[member] !== undefined) return emitStringTrimMemberBody(ctx, fctx, member);
  // (#4445) The 13 Annex B §B.2.3 HTML wrappers. Their DIRECT call sites were
  // already native since #3069; this is the value-erased shape
  // (`String.prototype.anchor.call(x, v)`) that reached the refusal instead.
  // Routed after the trim family because the nine tag-only members share its
  // arity-0 closure shape but not its single-helper body.
  if (htmlWrapperFor(member) !== undefined) {
    ensureStringRocUndefinedNative(ctx, fctx); // register the undefined-sentinel predicate first
    return (
      emitStringHtmlWrapperMemberBody(ctx, fctx, member, () => emitStringRequireObjectCoercible(ctx, fctx, member)) ??
      emitProtoMemberBodyRefusal(ctx, fctx, "String", member)
    );
  }
  if (member === "charAt") {
    return emitTransferredCharAtProtoMemberBody(
      ctx,
      fctx,
      () => ensureStringRocUndefinedNative(ctx, fctx),
      () => emitStringRequireObjectCoercible(ctx, fctx, member),
    );
  }
  if (!IN_SCOPE.has(member)) return emitProtoMemberBodyRefusal(ctx, fctx, "String", member);

  ensureNativeStringHelpers(ctx);
  ensureStringRocUndefinedNative(ctx, fctx); // (#2875) register the undefined-sentinel predicate first
  const needsNumBox = member === "charCodeAt" || member === "codePointAt";
  // Do ALL late-import-adding ops FIRST (mirrors emitArrayProtoMemberBody), so
  // every helper funcIdx fetched by NAME afterwards is post-shift-correct.
  // (#4465) `unboxArgToI32` now runs ToPrimitive(number) first, so it can execute
  // a user `valueOf`/`toString`. §22.1.3.{2,3,4} put that AFTER
  // `RequireObjectCoercible(this)` + `ToString(this)`, so the sequence is
  // registered here (where the late import must be added for funcidx stability)
  // and REPLAYED after step (2) — the `emitTransferredCharAtProtoMemberBody`
  // splice/defer discipline.
  const posStart = fctx.body.length;
  const posLocal = unboxArgToI32(ctx, fctx, 2); // → __unbox_number import + flush
  const deferredPos = fctx.body.splice(posStart, fctx.body.length - posStart);
  let boxIdx: number | undefined;
  if (needsNumBox) {
    boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (boxIdx === undefined) return emitProtoMemberBodyRefusal(ctx, fctx, "String", member);
  }
  // Fetch helper funcIdxs AFTER the import shifts, by name.
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
  if (flattenIdx === undefined || charAtIdx === undefined) {
    return emitProtoMemberBodyRefusal(ctx, fctx, "String", member);
  }

  // (1) RequireObjectCoercible(this) [param 1]: throw a catchable TypeError when
  // `this` is null OR undefined. Under the #2106 undefinedSingleton regime
  // `undefined` is a DISTINCT non-null sentinel, so a bare `ref.is_null` would
  // miss it — see emitStringRequireObjectCoercible.
  emitStringRequireObjectCoercible(ctx, fctx, member);

  // (2) S = ? ToString(this) (ToPrimitive-first — see the helper), flattened.
  // Store the flat string in a local.
  emitStringProtoToStringFlat(ctx, fctx, 1, anyToStrIdx, flattenIdx);
  const flatLocal = allocLocal(fctx, `__str_pm_flat_${fctx.locals.length}`, flatStringType(ctx));
  fctx.body.push({ op: "local.set", index: flatLocal });

  // (3) NOW coerce the position argument — after ToString(this) (see (1) above).
  for (const instr of deferredPos) fctx.body.push(instr);

  const strTy = ctx.nativeStrTypeIdx; // flat string struct: 0=len, 1=off, 2=data
  const dataTy = ctx.nativeStrDataTypeIdx;

  if (member === "charCodeAt") {
    // §22.1.3.3: out-of-range → NaN; else the UTF-16 code unit as a number.
    fctx.body.push({ op: "local.get", index: posLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({ op: "local.get", index: posLocal });
    fctx.body.push({ op: "local.get", index: flatLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTy, fieldIdx: 0 }); // len
    fctx.body.push({ op: "i32.ge_s" });
    fctx.body.push({ op: "i32.or" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN }],
      else: [
        { op: "local.get", index: flatLocal },
        { op: "struct.get", typeIdx: strTy, fieldIdx: 2 }, // data
        { op: "local.get", index: flatLocal },
        { op: "struct.get", typeIdx: strTy, fieldIdx: 1 }, // off
        { op: "local.get", index: posLocal },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: dataTy },
        { op: "f64.convert_i32_u" },
      ],
    });
    fctx.body.push({ op: "call", funcIdx: boxIdx! }); // f64 → externref
    return { kind: "externref" };
  }

  if (member === "codePointAt") {
    // §22.1.3.4: position out of range → undefined; else the code point at
    // `pos`, combining a leading+trailing surrogate pair when present.
    const lenL = allocLocal(fctx, `__str_pm_len_${fctx.locals.length}`, { kind: "i32" });
    const firstL = allocLocal(fctx, `__str_pm_first_${fctx.locals.length}`, { kind: "i32" });
    const secondL = allocLocal(fctx, `__str_pm_second_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: flatLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTy, fieldIdx: 0 });
    fctx.body.push({ op: "local.set", index: lenL });
    // out of range (pos<0 || pos>=len) → undefined
    fctx.body.push({ op: "local.get", index: posLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({ op: "local.get", index: posLocal });
    fctx.body.push({ op: "local.get", index: lenL });
    fctx.body.push({ op: "i32.ge_s" });
    fctx.body.push({ op: "i32.or" });
    // read unit at pos → firstL (guarded read builder)
    const readUnit = (posInstrs: Instr[]): Instr[] => [
      { op: "local.get", index: flatLocal },
      { op: "struct.get", typeIdx: strTy, fieldIdx: 2 }, // data
      { op: "local.get", index: flatLocal },
      { op: "struct.get", typeIdx: strTy, fieldIdx: 1 }, // off
      ...posInstrs,
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: dataTy },
    ];
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } as ValType },
      then: [{ op: "ref.null.extern" }],
      else: [
        // first = data[off+pos]
        ...readUnit([{ op: "local.get", index: posLocal }]),
        { op: "local.set", index: firstL },
        // isLead = first in [0xD800,0xDBFF] && pos+1 < len
        { op: "local.get", index: firstL },
        { op: "i32.const", value: 0xd800 },
        { op: "i32.ge_u" },
        { op: "local.get", index: firstL },
        { op: "i32.const", value: 0xdbff },
        { op: "i32.le_u" },
        { op: "i32.and" },
        { op: "local.get", index: posLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.get", index: lenL },
        { op: "i32.lt_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [
            // second = data[off+pos+1]
            ...readUnit([{ op: "local.get", index: posLocal }, { op: "i32.const", value: 1 }, { op: "i32.add" }]),
            { op: "local.set", index: secondL },
            // isTrail = second in [0xDC00,0xDFFF]
            { op: "local.get", index: secondL },
            { op: "i32.const", value: 0xdc00 },
            { op: "i32.ge_u" },
            { op: "local.get", index: secondL },
            { op: "i32.const", value: 0xdfff },
            { op: "i32.le_u" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } },
              then: [
                // cp = (first-0xD800)*0x400 + (second-0xDC00) + 0x10000
                { op: "local.get", index: firstL },
                { op: "i32.const", value: 0xd800 },
                { op: "i32.sub" },
                { op: "i32.const", value: 0x400 },
                { op: "i32.mul" },
                { op: "local.get", index: secondL },
                { op: "i32.const", value: 0xdc00 },
                { op: "i32.sub" },
                { op: "i32.add" },
                { op: "i32.const", value: 0x10000 },
                { op: "i32.add" },
                { op: "f64.convert_i32_u" },
              ],
              else: [{ op: "local.get", index: firstL }, { op: "f64.convert_i32_u" }],
            },
          ],
          else: [{ op: "local.get", index: firstL }, { op: "f64.convert_i32_u" }],
        },
        { op: "call", funcIdx: boxIdx! }, // f64 → externref
      ],
    });
    return { kind: "externref" };
  }

  // member === "at": §22.1.3.2 — resolve a relative index, out-of-range → undefined.
  const lenLocal = allocLocal(fctx, `__str_pm_len_${fctx.locals.length}`, { kind: "i32" });
  const idxLocal = allocLocal(fctx, `__str_pm_idx_${fctx.locals.length}`, { kind: "i32" });
  const strTypeIdx = ctx.nativeStrTypeIdx;
  // len = flat.length (field 0)
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });
  // idx = pos < 0 ? pos + len : pos
  fctx.body.push({ op: "local.get", index: posLocal });
  fctx.body.push({ op: "local.set", index: idxLocal });
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: idxLocal },
      { op: "local.get", index: lenLocal },
      { op: "i32.add" },
      { op: "local.set", index: idxLocal },
    ],
  });
  // out-of-range (idx<0 || idx>=len) → undefined (ref.null.extern); else charAt.
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "i32.or" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } as ValType },
    then: [{ op: "ref.null.extern" }],
    else: [
      { op: "local.get", index: flatLocal },
      { op: "local.get", index: idxLocal },
      { op: "call", funcIdx: charAtIdx },
      { op: "extern.convert_any" },
    ],
  });
  return { kind: "externref" };
}

/**
 * (#2875 slice 3a) Native body for a reflective `String.prototype.<member>`
 * closure of the NUMBER-returning search family — `indexOf` / `lastIndexOf`.
 * Closure ABI: `this` = param 1 (externref), searchString = param 2 (externref-
 * boxed), fromIndex/position = param 3 (externref-boxed). Param 3 exists ONLY
 * because `STRING_PROTO_METHOD_PARAM_SLOTS` sizes these closures to 2 arg
 * slots (spec `fn.length` is 1 — the optional `position` is uncounted, and
 * sizing by arity alone made `local.get 3` read the first DECLARED LOCAL,
 * emitting invalid Wasm — the original slice-3 blocker). Implements
 * §22.1.3.{8,9}: `? RequireObjectCoercible(this)` → `? ToString(this)` →
 * `? ToString(searchString)` → the native index scan → box the i32 index as a
 * Number (externref). This is the search-family counterpart of `charCodeAt`'s
 * number-box arm; it differs from the index-accessor path only in that param 2
 * is a STRING (flattened) rather than an integer position.
 *
 * Funcidx/type-index discipline: the ONLY late-import adders here (`unboxArgToI32`'s
 * `__unbox_number` and `__box_number`) run FIRST and flush, so every helper funcIdx
 * fetched by NAME afterwards is post-shift-correct. Receiver + needle are flattened
 * to `flatStringType` (`ref $FlatString`, a subtype of the helpers' `ref $AnyString`
 * param — a valid implicit up-cast), mirroring `charAt`.
 */
function emitStringSearchNumericMemberBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | null {
  ensureNativeStringHelpers(ctx);
  ensureStringRocUndefinedNative(ctx, fctx); // (#2875) register the undefined-sentinel predicate first
  const isLast = member === "lastIndexOf";
  const helperName = isLast ? "__str_lastIndexOf" : "__str_indexOf";

  // (1) Do ALL late-import-adding ops FIRST (mirrors charCodeAt), so every helper
  // funcIdx fetched by NAME afterwards is post-shift-correct.
  //   fromIndex: unbox param 3 → i32 (null/undefined → 0 via NaN→trunc_sat).
  // (#4465) The unbox now runs `ToPrimitive(number)` first, so it can execute a
  // USER `valueOf`/`toString` and throw. §22.1.3.{8,9} order that AFTER
  // `ToString(this)` and `ToString(searchString)` (S15.5.4.{7,8}_A4_T4/T5 assert
  // exactly which of two throwing coercions wins), so the sequence is emitted
  // here — where the late-import registration must happen for funcidx stability
  // — and REPLAYED at step (5a). Same splice/defer discipline as
  // `emitTransferredCharAtProtoMemberBody`.
  const fromStart = fctx.body.length;
  const fromLocal = unboxArgToI32(ctx, fctx, 3);
  const deferredFrom = fctx.body.splice(fromStart, fctx.body.length - fromStart);
  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (boxIdx === undefined) return emitProtoMemberBodyRefusal(ctx, fctx, "String", member);

  // (2) Fetch helper funcIdxs AFTER the import shifts, by name.
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const searchIdx = ctx.nativeStrHelpers.get(helperName);
  if (flattenIdx === undefined || searchIdx === undefined) {
    return emitProtoMemberBodyRefusal(ctx, fctx, "String", member);
  }

  // (3) RequireObjectCoercible(this) [param 1]: throw a catchable TypeError when
  // `this` is null OR undefined. Under the #2106 undefinedSingleton regime
  // `undefined` is a DISTINCT non-null sentinel, so a bare `ref.is_null` would
  // miss it — see emitStringRequireObjectCoercible.
  emitStringRequireObjectCoercible(ctx, fctx, member);

  // (5) recv = flatten(? ToString(this)); needle = flatten(? ToString(searchString)).
  // §22.1.3.{6,7,8,9,23} apply ToString to BOTH, so both go through the shared
  // ToPrimitive-first sequence (#3992).
  const flattenExtern = (paramIdx: number, label: string): number => {
    emitStringProtoToStringFlat(ctx, fctx, paramIdx, anyToStrIdx, flattenIdx);
    const local = allocLocal(fctx, `${label}_${fctx.locals.length}`, flatStringType(ctx));
    fctx.body.push({ op: "local.set", index: local });
    return local;
  };
  const recvLocal = flattenExtern(1, "__str_srch_recv");
  const needleLocal = flattenExtern(2, "__str_srch_needle");

  // (5a) NOW coerce the position (§22.1.3.{8,9} step 4) — after both ToStrings.
  for (const instr of deferredFrom) fctx.body.push(instr);

  // (5b) lastIndexOf default position: §22.1.3.9 — an absent / `undefined` position
  // is ToIntegerOrInfinity → +∞ ⇒ search from the end. In standalone both map to a
  // null externref, so ref.is_null selects the from-end sentinel (0x7fffffff). An
  // explicit numeric position (incl. saturating large values) keeps its unboxed i32.
  // `indexOf`'s default of 0 is exactly what unboxArgToI32 already yields for null.
  if (isLast) {
    fctx.body.push({ op: "local.get", index: 3 });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0x7fffffff }],
      else: [{ op: "local.get", index: fromLocal }],
    });
    fctx.body.push({ op: "local.set", index: fromLocal });
  }

  // (6) call __str_indexOf/__str_lastIndexOf(recv, needle, fromIndex) → i32 index.
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: needleLocal });
  fctx.body.push({ op: "local.get", index: fromLocal });
  fctx.body.push({ op: "call", funcIdx: searchIdx });
  // (7) box the i32 index as a Number (externref).
  fctx.body.push({ op: "f64.convert_i32_s" });
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  return { kind: "externref" };
}

/**
 * (#2875 slice 3b) Native body for a reflective `String.prototype.<member>`
 * closure of the BOOLEAN-returning search family — `includes` / `startsWith` /
 * `endsWith`. Same two-string ABI as the 3a numeric family (`this` = param 1,
 * searchString = param 2, position/endPosition = param 3 — the second slot
 * exists via STRING_PROTO_METHOD_PARAM_SLOTS), but the i32 core result is
 * boxed via the standalone-native `__box_boolean` so the externref carries a
 * real JS boolean (NOT `__box_number` — `1 === true` is false; see the
 * array-methods.ts SameValueZero note). Implements §22.1.3.{7,23,6} steps:
 * `? RequireObjectCoercible(this)` → `? ToString(this)` →
 * `? ToString(searchString)` → clamp position → the native core.
 *
 * Known spec gap (documented, matches the DIRECT path's static-only fold):
 * step 3's IsRegExp(searchString) throw is folded STATICALLY at direct call
 * sites (`argIsStaticRegExp`, string-ops.ts); this reflective body does not
 * re-check at runtime, so a RegExp arg reaching a reflective call falls
 * through to ToString instead of throwing. No test262 case exercises that
 * combination today; a runtime `ref.test $RegExp` arm can be added when one
 * does.
 */
function emitStringSearchBooleanMemberBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | null {
  ensureNativeStringHelpers(ctx);
  ensureStringRocUndefinedNative(ctx, fctx); // (#2875) register the undefined-sentinel predicate first
  const helperName =
    member === "includes" ? "__str_includes" : member === "startsWith" ? "__str_startsWith" : "__str_endsWith";

  // (1) Do ALL late-import-adding ops FIRST (mirrors the 3a body), so every
  // helper funcIdx fetched by NAME afterwards is post-shift-correct.
  //   position/endPosition: unbox param 3 → i32 (null/undefined → 0).
  // (#4465) The unbox now runs `ToPrimitive(number)` first and can therefore
  // execute user code; §22.1.3.{6,7,23} order that after both ToStrings, so the
  // sequence is registered here (funcidx stability) and replayed at (5a).
  const posStart = fctx.body.length;
  const posLocal = unboxArgToI32(ctx, fctx, 3);
  const deferredPos = fctx.body.splice(posStart, fctx.body.length - posStart);
  const boxBoolIdx = ensureLateImport(ctx, "__box_boolean", [{ kind: "i32" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (boxBoolIdx === undefined) return emitProtoMemberBodyRefusal(ctx, fctx, "String", member);

  // (2) Fetch helper funcIdxs AFTER the import shifts, by name.
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const coreIdx = ctx.nativeStrHelpers.get(helperName);
  if (flattenIdx === undefined || coreIdx === undefined) {
    return emitProtoMemberBodyRefusal(ctx, fctx, "String", member);
  }

  // (3) RequireObjectCoercible(this) [param 1]: throw a catchable TypeError when
  // `this` is null OR undefined. Under the #2106 undefinedSingleton regime
  // `undefined` is a DISTINCT non-null sentinel, so a bare `ref.is_null` would
  // miss it — see emitStringRequireObjectCoercible.
  emitStringRequireObjectCoercible(ctx, fctx, member);

  // (5) recv = flatten(? ToString(this)); needle = flatten(? ToString(searchString)).
  // §22.1.3.{6,7,8,9,23} apply ToString to BOTH, so both go through the shared
  // ToPrimitive-first sequence (#3992).
  const flattenExtern = (paramIdx: number, label: string): number => {
    emitStringProtoToStringFlat(ctx, fctx, paramIdx, anyToStrIdx, flattenIdx);
    const local = allocLocal(fctx, `${label}_${fctx.locals.length}`, flatStringType(ctx));
    fctx.body.push({ op: "local.set", index: local });
    return local;
  };
  const recvLocal = flattenExtern(1, "__str_srchb_recv");
  const needleLocal = flattenExtern(2, "__str_srchb_needle");

  // (5a) NOW coerce the position — after both ToStrings (see the note at (1)).
  for (const instr of deferredPos) fctx.body.push(instr);

  // (5b) endsWith default endPosition: §22.1.3.6 step 6 — absent/`undefined`
  // endPosition ⇒ end = len. Mirror the DIRECT path's 0x7fffffff sentinel
  // (string-ops.ts), which the core clamps to sLen. `includes`/`startsWith`
  // default position 0 is exactly what unboxArgToI32 already yields for null.
  if (member === "endsWith") {
    fctx.body.push({ op: "local.get", index: 3 });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0x7fffffff }],
      else: [{ op: "local.get", index: posLocal }],
    });
    fctx.body.push({ op: "local.set", index: posLocal });
  }

  // (6) call the core (recv, needle, pos) → i32 boolean → box as JS boolean.
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: needleLocal });
  fctx.body.push({ op: "local.get", index: posLocal });
  fctx.body.push({ op: "call", funcIdx: coreIdx });
  fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
  return { kind: "externref" };
}

/**
 * (#3217) Native body for a reflective no-argument string-returning
 * `String.prototype` member (`trim`/`trimStart`/`trimEnd`, and since #3992 the
 * case-conversion family). These methods take NO arguments and return a
 * STRING, so unlike the char/search bodies this one never touches an arg slot
 * beyond `this` (the closure has arity 0 — reading a param-2 slot that doesn't
 * exist emits invalid Wasm). Implements the spec preamble
 * `? RequireObjectCoercible(this)` → `S = ? ToString(this)`, then delegates to
 * the standalone-native `__str_trim` / `__str_trimStart` / `__str_trimEnd`
 * helper (native-strings.ts — the SAME whitespace kernel the direct `"x".trim()`
 * path uses; it flattens its `ref $AnyString` arg internally), and up-converts
 * the resulting native string to externref (the uniform closure result type).
 *
 * Funcidx discipline: this body adds NO late imports of its own (no numeric
 * box/unbox — the result is a string), so there is nothing to over-shift; the
 * helper funcIdxs are fetched by NAME after `ensureNativeStringHelpers` (which
 * flushes any pending import batch on entry) and `ensureAnyToStringHelper`.
 */
function emitStringTrimMemberBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | null {
  ensureNativeStringHelpers(ctx);
  ensureStringRocUndefinedNative(ctx, fctx); // (#2875) register the undefined-sentinel predicate first
  const helperName = NO_ARG_STRING_MEMBER_HELPER[member];
  if (helperName === undefined) return emitProtoMemberBodyRefusal(ctx, fctx, "String", member);

  // Fetch helper funcIdxs. `ensureAnyToStringHelper` is the last ensure that
  // could register a defined func, so fetch the trim helper's idx AFTER it
  // (mirrors the search body's post-ensure fetch order).
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const trimIdx = ctx.nativeStrHelpers.get(helperName);
  // (#2875) `__str_trim*` operates on a FLATTENED receiver (`ref $NativeString`)
  // — the DIRECT path (`string-ops.ts`) calls `emitFlatten()` before it. The
  // reflective glue must do the same: `$__any_to_string` on a non-string
  // primitive (`false`, `123`, …) returns an unflattened `$AnyString`
  // (cons/wrapper), and feeding that straight into `__str_trim*` mis-reads it
  // (`trim.call(false)` returned "[object Boolean]"-ish instead of "false").
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (trimIdx === undefined || flattenIdx === undefined) {
    return emitProtoMemberBodyRefusal(ctx, fctx, "String", member);
  }

  // (1) RequireObjectCoercible(this) [param 1]: throw a catchable TypeError when
  // `this` is null OR undefined. Under the #2106 undefinedSingleton regime
  // `undefined` is a DISTINCT non-null sentinel, so a bare `ref.is_null` would
  // miss it — see emitStringRequireObjectCoercible.
  emitStringRequireObjectCoercible(ctx, fctx, member);

  // (2) S = ? ToString(this) (ToPrimitive-first, #3992); FLATTEN;
  // __str_trim*(S) → native string; → externref.
  emitStringProtoToStringFlat(ctx, fctx, 1, anyToStrIdx, flattenIdx);
  fctx.body.push({ op: "call", funcIdx: trimIdx });
  fctx.body.push({ op: "extern.convert_any" });
  return { kind: "externref" };
}

/**
 * (#2893 PR-1) The integer-view standalone vec storage keys and their
 * compile-time element widths (BYTES_PER_ELEMENT). Post-#2593/#2835 each is a
 * DISJOINT `$Vec` struct on current main (see `TYPED_ARRAY_PACKED_STORAGE`,
 * index.ts) — so `ref.test` against one already proves "an integer view, not a
 * `number[]` and not an ArrayBuffer". The float views (`Float32Array`/
 * `Float64Array`) still key to `f64` (colliding with `number[]`) and are
 * therefore DELIBERATELY EXCLUDED here until the PR-2 brand split — including
 * them would mis-classify a plain `number[]` as a view.
 */
const TYPED_ARRAY_INT_VIEW_STORAGE: ReadonlyArray<{ key: string; width: number }> = [
  { key: "i8_byte", width: 1 }, // Int8Array / Uint8Array / Uint8ClampedArray
  { key: "i16_byte", width: 2 }, // Int16Array / Uint16Array
  { key: "i32_elem", width: 4 }, // Int32Array / Uint32Array (element storage, #2835)
];

/**
 * (#2893 PR-1) Build the runtime brand-recovery candidate set for a
 * `%TypedArray%` view receiver: every integer-view vec struct plus its
 * `$__subview_<k>` struct (a `subarray` window), each tagged with its
 * compile-time element width and whether it is a subview (the byteOffset arm
 * differs).
 *
 * **Type-index discipline (#2901 fix — `project_type_index_shift_and_deadelim`):**
 * the integer-view vec structs are registered **here, LATE and ONCE** (idempotent,
 * `suppressVecUsageFlag`), at the moment a reflective accessor getter body is
 * emitted — NOT up-front at the deterministic type-init point. An up-front,
 * unconditional reservation prepended these structs to EVERY standalone module's
 * type table, **renumbering the #2835 i8-packed array type** so unrelated
 * `array.get` sites (which captured a pre-shift index in the hoist pass) landed on
 * a now-packed array → `array.get: ... packed type i8` validation failures across
 * ~2.6k tests in the merge_group. Registering on-read here is **append-only** (the
 * new structs take high indices, shifting nothing already registered) and **gated**
 * (only TypedArray-reflective modules ever register them, so non-TA modules stay
 * byte-identical). `getOrRegisterVecType` is idempotent, so a later
 * `new Uint8Array()` resolves to the same struct index. The subview structs are
 * still reserved up-front by `reserveTypedArraySubviewTypes` (existing main
 * behaviour, unchanged) and read here.
 */
function typedArrayViewBrandCandidates(ctx: CodegenContext): { typeIdx: number; width: number; isSubview: boolean }[] {
  // Register the integer-view vec structs LATE + ONCE (append-only, suppressed
  // usage flag) so the candidate set is populated even when the getter closure is
  // emitted before any `new <View>()` construction — without renumbering the
  // i8-packed array type that up-front reservation perturbed.
  const wasSuppressed = ctx.suppressVecUsageFlag;
  ctx.suppressVecUsageFlag = true;
  getOrRegisterVecType(ctx, "i8_byte", { kind: "i8" });
  getOrRegisterVecType(ctx, "i16_byte", { kind: "i16" });
  getOrRegisterVecType(ctx, "i32_elem", { kind: "i32" });
  ctx.suppressVecUsageFlag = wasSuppressed;

  const out: { typeIdx: number; width: number; isSubview: boolean }[] = [];
  for (const { key, width } of TYPED_ARRAY_INT_VIEW_STORAGE) {
    const vecIdx = ctx.vecTypeMap.get(key);
    if (vecIdx !== undefined) out.push({ typeIdx: vecIdx, width, isSubview: false });
    const subIdx = ctx.subviewTypeMap.get(key);
    if (subIdx !== undefined) out.push({ typeIdx: subIdx, width, isSubview: true });
  }
  return out;
}

/**
 * (#2893 PR-1) Push the f64 numeric result of a `%TypedArray%` accessor getter
 * off a recovered view local, then box it to externref via the pre-resolved
 * `__box_number` funcidx (the closure-call ABI + descriptor `.get` unify on
 * externref). `boxIdx` is resolved by the CALLER before the brand-recovery
 * cascade so no late import is added inside a detached cascade arm (funcIdx-shift
 * discipline, `reference_1461`/`reference_2193`).
 *
 *  - `length`     → element count = `$__vec_base` length prefix (field 0).
 *  - `byteLength` → count × width (compile-time BYTES_PER_ELEMENT).
 *  - `byteOffset` → 0 for a plain view; for a `$__subview` it is the element
 *                   window offset (field 2) × width.
 */
function emitTypedArrayAccessorResult(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
  viewLocal: number,
  typeIdx: number,
  width: number,
  isSubview: boolean,
  boxIdx: number | undefined,
): void {
  if (member === "length") {
    fctx.body.push({ op: "local.get", index: viewLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // i32 element count
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (member === "byteLength") {
    fctx.body.push({ op: "local.get", index: viewLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // i32 element count
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "f64.const", value: width });
    fctx.body.push({ op: "f64.mul" });
  } else {
    // byteOffset
    if (isSubview) {
      fctx.body.push({ op: "local.get", index: viewLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 2 }); // i32 element offset
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "f64.const", value: width });
      fctx.body.push({ op: "f64.mul" });
    } else {
      // A plain (non-subview) view starts at byte 0 of its own backing array.
      fctx.body.push({ op: "f64.const", value: 0 });
    }
  }
  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
}

/**
 * (#2893 PR-1) Native body for a `%TypedArray%.prototype` accessor-getter closure
 * (`length`/`byteLength`/`byteOffset`). The closure params are: index 0 the
 * `__fn_wrap` self struct, index 1 the externref `this`. Recovers the view from
 * the opaque externref `this` over the registered integer-view vec/subview type
 * set (a runtime `ref.test`/`ref.cast` cascade), reads/computes the §23.2.3 field
 * off the recovered local, and boxes the result to externref. A non-view `this`
 * (plain `number[]`, ArrayBuffer, host object, or EITHER prototype) throws a
 * catchable TypeError — the §23.2.3 RequireInternalSlot [[TypedArrayName]] step.
 *
 * **Key divergence from the RegExp template (verified 2026-06-30, Node):** unlike
 * §22.2.6 RegExp getters, the §23.2.3 TypedArray getters have NO
 * "`this === %TypedArray%.prototype` → undefined" carve-out — they throw for
 * EVERY non-view receiver, including both prototype objects
 * (`get.call(%TypedArray%.prototype)` and `get.call(Uint8Array.prototype)` both
 * throw TypeError in V8). So we deliberately OMIT the proto-identity arm
 * (`emitNativeProtoIdentityReturnUndefined`) that RegExp uses; the brand-check
 * else-arm correctly throws for the prototype receivers too.
 *
 * Methods (`fill`/`set`/`map`/…) and `buffer` (needs an ArrayBuffer materialized
 * off the view — PR-3) stay a catchable refusal. Float views are unbranded until
 * PR-2. Returns externref (the uniform closure result), or `null` on refusal.
 */
function emitTypedArrayProtoMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
  name: string,
): ValType | null {
  // Only the three width-derivable accessor getters get a native body here.
  // `buffer` needs an ArrayBuffer window off the view (PR-3); methods belong to
  // the #2872 per-member slices — both stay a catchable refusal.
  if (member === "buffer" || !TYPED_ARRAY_PROTO_GETTERS.has(member)) {
    return emitProtoMemberBodyRefusal(ctx, fctx, name, member);
  }

  const resultType: ValType = { kind: "externref" };
  const refuseMsg = `Method ${name}.prototype.${member} called on incompatible receiver`;

  // Resolve the box import BEFORE building the cascade so its funcidx is final
  // and no late import is added inside a detached cascade arm (the funcidx-shift
  // hazard the established `emitArrayProtoMemberBody`/`unboxArgToI32` pattern
  // avoids). `emitBrandCheckTypeError` appends a FUNCTION (`__new_TypeError`),
  // not an import, so it is shift-safe inside the cascade arms.
  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);

  const candidates = typedArrayViewBrandCandidates(ctx);
  if (candidates.length === 0) {
    // No integer-view vec type registered in this module → no receiver can be a
    // view → the §23.2.3 RequireInternalSlot throw applies unconditionally.
    emitBrandCheckTypeError(ctx, fctx.body, refuseMsg);
    return resultType;
  }

  const byIdx = new Map(candidates.map((c) => [c.typeIdx, c]));
  const typeIdxs = candidates.map((c) => c.typeIdx);

  fctx.body.push({ op: "local.get", index: 1 }); // externref `this`
  emitThisReceiverGuardConvert(
    ctx,
    fctx,
    typeIdxs,
    resultType,
    (concreteType) => {
      // The recovered concrete view ref is on the stack (the helper ran ref.cast).
      const tIdx = (concreteType as { typeIdx: number }).typeIdx;
      const cand = byIdx.get(tIdx)!;
      const viewLocal = allocLocal(fctx, `__ta_view_${fctx.locals.length}`, { kind: "ref", typeIdx: tIdx });
      fctx.body.push({ op: "local.set", index: viewLocal });
      emitTypedArrayAccessorResult(ctx, fctx, member, viewLocal, tIdx, cand.width, cand.isSubview, boxIdx);
    },
    () => {
      // Genuine non-view `this` (plain array / ArrayBuffer / host object / either
      // prototype): §23.2.3 RequireInternalSlot → catchable TypeError.
      emitBrandCheckTypeError(ctx, fctx.body, refuseMsg);
    },
  );
  return resultType;
}

/**
 * (#3171) Native reflective body for the `Map.prototype.size` / `Set.prototype.size`
 * accessor GETTER — `gOPD(Map.prototype, "size").get.call(recv)`. Spec
 * §24.1.3.10 / §24.2.4.14: "If M does not have a [[MapData]]/[[SetData]]
 * internal slot, throw a TypeError". Routes the receiver through the shared
 * brand preamble (receiver-brand.ts: non-trapping `ref.test $Map` + the
 * COLLECTION_KIND tag → catchable TypeError on a miss — a Set receiver must
 * throw for Map's getter and vice versa), then `__map_size` → boxed number.
 *
 * Late-funcidx discipline (mirrors `emitTypedArrayProtoMemberBody`): the
 * `__box_number` import is resolved + flushed BEFORE the cascade; everything
 * the brand preamble appends in standalone mode (error ctor funcs, string
 * globals, exn tag) is append-only — no baked-index shifts.
 */
function emitCollectionSizeGetterBody(ctx: CodegenContext, fctx: FunctionContext, name: "Map" | "Set"): ValType | null {
  const resultType: ValType = { kind: "externref" };
  const refuseMsg = `TypeError: Method get ${name}.prototype.size called on incompatible receiver`;

  // Register the native Map runtime (append-only defined funcs; idempotent).
  ensureMapHelpers(ctx);
  const sizeIdx = ctx.mapHelpers.get("__map_size");
  if (sizeIdx === undefined || ctx.mapTypeIdx < 0) {
    // No native collection runtime in this module → no receiver can carry the
    // internal slot → the RequireInternalSlot throw applies unconditionally.
    emitBrandCheckTypeError(ctx, fctx.body, refuseMsg);
    return resultType;
  }

  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);

  // Closure ABI: local 0 = self wrapper, local 1 = externref `this`.
  fctx.body.push({ op: "local.get", index: 1 });
  emitReceiverBrandCheck(
    ctx,
    fctx,
    { kind: "externref" },
    {
      message: refuseMsg,
      structTypeIdx: ctx.mapTypeIdx,
      kindField: {
        fieldIdx: MAP_LAYOUT.M_KIND,
        accept: [name === "Map" ? COLLECTION_KIND.MAP : COLLECTION_KIND.SET],
      },
    },
  );
  // (ref $Map) on the stack → size (i32) → boxed number externref.
  fctx.body.push({ op: "call", funcIdx: sizeIdx });
  fctx.body.push({ op: "f64.convert_i32_s" });
  fctx.body.push({ op: "call", funcIdx: boxIdx! });
  return resultType;
}

/**
 * (#3171) Glue factory for Map/Set — `makeGlue` plus the `size` accessor
 * getter (real reflective body via {@link emitCollectionSizeGetterBody}).
 */
function makeCollectionGlue(brand: number, name: "Map" | "Set", members: readonly string[]): NativeProtoBuiltinGlue {
  return {
    brand,
    name,
    memberCsv: [...members, "size"].join(","),
    memberKind: (member) => (member === "size" ? "getter" : "method"),
    memberLength: (member) => (member === "size" ? 0 : (PROTO_METHOD_LENGTH[member] ?? 1)),
    emitMemberBody: (c, fctx, member) =>
      member === "size"
        ? emitCollectionSizeGetterBody(c, fctx, name)
        : emitProtoMemberBodyRefusal(c, fctx, name, member),
  };
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
    // (#3181) `Number.prototype.toString(radix)` is arity 1 (§21.1.3.7) — the
    // only family where `toString` differs from the shared default of 0. Every
    // other family (Array/String/Object/Boolean/Date/…) keeps 0 from the table.
    memberLength: (member) => (name === "Number" && member === "toString" ? 1 : (PROTO_METHOD_LENGTH[member] ?? 1)),
    // (#2875 slice 3) String search-family members carry an uncounted optional
    // `position` arg — give their closures a real param slot for it. Non-String
    // families return 0 (= "no override": the slot count falls back to the spec
    // arity), keeping their closure types byte-identical.
    memberParamSlots: (member) => (name === "String" ? (STRING_PROTO_METHOD_PARAM_SLOTS[member] ?? 0) : 0),
    // (#4485) §B.2.4.3 — `Date.prototype.toGMTString` IS `Date.prototype.
    // toUTCString` (one function object, asserted by test262 annexB
    // .../toGMTString/value.js). The Annex B String aliases have the same
    // identity rule: trimLeft→trimStart and trimRight→trimEnd. Alias the
    // closure identity, not the member set: each spelling stays in its own
    // proto CSV entry for hasOwnProperty/gOPD.
    memberAliasOf: (member) =>
      name === "Date" && member === "toGMTString"
        ? "toUTCString"
        : name === "String" && member === "trimLeft"
          ? "trimStart"
          : name === "String" && member === "trimRight"
            ? "trimEnd"
            : undefined,
    // (#2193 PR-B) Array.prototype.slice is now a real native closure body;
    // (#2875 slice 1) String.prototype.{charAt,at} likewise. Other Array/String
    // members + all Object members still degrade to a catchable TypeError.
    emitMemberBody: (c, fctx, member) =>
      // (#4491 wave-5 T2) `this<X>Value(this)` for the three primitive-wrapper
      // families (§21.1.3.7 / §22.1.3.28 / §20.3.3.3). Routed FIRST so it
      // serves String too — `emitStringProtoMemberBody` would otherwise claim
      // the member and answer the refusal. Declines (returns null, emits
      // nothing) for every other family/member, so the ladder below is reached
      // byte-identically.
      (member === "valueOf" && isWrapperBrandName(name) ? emitWrapperProtoValueOfBody(c, fctx, name) : null) ??
      // (#4619 family D) The `toString` twin of the arm above, in the same
      // position and for the same reason — routed FIRST so it serves String too.
      (member === "toString" && isWrapperBrandName(name) ? emitWrapperProtoToStringBody(c, fctx, name) : null) ??
      // (#4492 wave-5) §20.2.3.5 `Function.prototype.toString` — the reflective
      // VALUE. Same "ask first, emit second" contract as the two arms above, so a
      // decline leaves the ladder byte-identical.
      (name === "Function" && member === "toString" ? emitFunctionProtoToStringBody(c, fctx) : null) ??
      // ES2015 §19.2.3.6 — the inherited `@@hasInstance` method. Its body is
      // shared with the standalone dynamic-instanceof substrate so ordinary
      // function receivers and direct `Function.prototype` reads use the same
      // prototype walk and TypeError sentinel.
      (name === "Function" && member === FUNCTION_PROTO_HAS_INSTANCE_MEMBER
        ? emitFunctionProtoHasInstanceBody(c, fctx)
        : null) ??
      (name === "Array"
        ? emitArrayProtoMemberBody(c, fctx, member)
        : name === "String"
          ? emitStringProtoMemberBody(c, fctx, member)
          : // (#3219) Date reflective getter bodies; (#3174) setter/toISOString
            // bodies (brand check + native set arithmetic). Remaining formatters
            // return null → fall through to the legacy path.
            name === "Date"
            ? (emitDateProtoMemberBody(c, fctx, member) ?? emitDateReflectiveSetterBody(c, fctx, member))
            : // (#4582) `thisNumberValue` / `thisBooleanValue`; see the String twin above.
              member === "valueOf" && (name === "Number" || name === "Boolean")
              ? (emitBoxedProtoValueOfBody(c, fctx, name === "Number" ? "Number" : "Boolean") ??
                emitProtoMemberBodyRefusal(c, fctx, name, member))
              : // (#4491) `Object.prototype.isPrototypeOf` has a real answer — the
                // §20.1.3.3 chain walk. (#4479 slice 2) So do Annex B §B.2.2's
                // four legacy accessor methods. Every other Object member still
                // degrades to the catchable refusal (`toString`'s classifier
                // lives inside it).
                ((name === "Object" ? emitObjectProtoIsPrototypeOfBody(c, fctx, member) : null) ??
                (name === "Object" ? emitObjectProtoAnnexBAccessorBody(c, fctx, member) : null) ??
                // (#4492 wave-5) §20.1.3.7 — the inherited `valueOf` every
                // OrdinaryToPrimitive walk reaches; refusing it made ToPrimitive
                // throw where the spec just falls through to `toString`.
                (name === "Object" ? emitObjectProtoValueOfBody(c, fctx, member) : null) ??
                emitProtoMemberBodyRefusal(c, fctx, name, member))),
  };
}

/**
 * (#2651 M1 / D2) Glue factory for a TypedArray-family proto (`%TypedArray%` and
 * each concrete view). Differs from `makeGlue` only in marking the four accessor
 * members (`buffer`/`byteLength`/`byteOffset`/`length`) as getters so the
 * `.length`/`.name` meta-fold reports 0 arity. All concrete views share
 * `TYPED_ARRAY_PROTO_METHODS` (they inherit from `%TypedArray%.prototype`). The
 * proto OBJECT is a pure value object (member CSV + name; `emitLazyNativeProtoGet`
 * never calls `emitMemberBody`). A reflective member-CLOSURE read degrades to a
 * catchable TypeError — the method bodies live on the native instance-method vec
 * dispatch, reached via the instance (#2375 caution: never re-emit a body that
 * touches the view's vec/runtime state on the proto value).
 */
function makeTypedArrayGlue(brand: number, name: string): NativeProtoBuiltinGlue {
  return {
    brand,
    name,
    memberCsv: TYPED_ARRAY_PROTO_METHODS.join(","),
    memberKind: (member) => (TYPED_ARRAY_PROTO_GETTERS.has(member) ? "getter" : "method"),
    memberLength: (member) => TYPED_ARRAY_PROTO_METHOD_LENGTH[member] ?? 1,
    // (#2893 PR-1) The `length`/`byteLength`/`byteOffset` accessor getters now
    // emit real reflective bodies (brand-recover the view → read/compute the
    // field → throw on non-view); `buffer` + all methods stay a catchable refusal.
    emitMemberBody: (c, fctx, member) => emitTypedArrayProtoMemberBody(c, fctx, member, name),
  };
}

/**
 * (#2861) Generic glue factory for a ctor-prototype value object whose member
 * set mixes data methods and accessor getters (ArrayBuffer / DataView / …).
 * Differs from `makeGlue` only in marking the `getters` members as getters so
 * the `.length` meta-fold reports 0 arity, and consulting a per-builtin length
 * table. The proto OBJECT is a pure value object (member CSV + name;
 * `emitLazyNativeProtoGet` never calls `emitMemberBody`); a reflective member
 * CLOSURE read degrades to a catchable TypeError until a native body lands (the
 * established #2193 / #2651 pattern).
 */
function makeGlueWithGetters(
  brand: number,
  name: string,
  members: readonly string[],
  getters: ReadonlySet<string>,
  lengthTable: Readonly<Record<string, number>>,
): NativeProtoBuiltinGlue {
  return {
    brand,
    name,
    memberCsv: members.join(","),
    memberKind: (member) => (getters.has(member) ? "getter" : "method"),
    memberLength: (member) => lengthTable[member] ?? 1,
    emitMemberBody: (c, fctx, member) => emitProtoMemberBodyRefusal(c, fctx, name, member),
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

/**
 * (#2861) Register `<NativeError>.prototype` glue (idempotent) and return its
 * brand. Each NativeError ctor (TypeError/RangeError/ReferenceError/SyntaxError/
 * EvalError/URIError) has its own reserved brand; the proto value object only
 * needs the (Error-shared) member CSV so a `<NativeError>.prototype` /
 * `<NativeError>.prototype.<member>` value read resolves host-free instead of
 * refusing. Clean flip — Error.prototype glue (S6) carried no runtime-state
 * entanglement and these subclass protos share its shape. */
export function ensureNativeErrorNativeProtoGlue(ctx: CodegenContext, builtinName: string): number | undefined {
  const brand = getBuiltinBrand(ctx, builtinName);
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, builtinName, NATIVE_ERROR_PROTO_METHODS));
  }
  return brand;
}

/**
 * (#2861) Register `Promise.prototype` glue (idempotent) and return its brand.
 * Scoped to the static `.prototype` VALUE read + method-closure value reads
 * (`then`/`catch`/`finally`) — the proto OBJECT is a pure value object
 * (member CSV only; `emitLazyNativeProtoGet` never re-emits a body that touches
 * the async-capability runtime state, which is what #1907 found to null-deref). */
export function ensurePromiseNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Promise");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Promise", PROMISE_PROTO_METHODS));
  }
  return brand;
}

/** (#2861) Register `Iterator.prototype` glue (idempotent) and return its brand. */
export function ensureIteratorNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Iterator");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Iterator", ITERATOR_PROTO_METHODS));
  }
  return brand;
}

/** Register `Map.prototype` glue (idempotent) and return its brand. (S6) */
export function ensureMapNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Map");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    // (#3171) Collection glue = makeGlue + the `size` accessor getter with a
    // real brand-checked reflective body.
    registerNativeProtoBuiltin(ctx, makeCollectionGlue(brand, "Map", MAP_PROTO_METHODS));
  }
  return brand;
}

/** Register `Set.prototype` glue (idempotent) and return its brand. (S6) */
export function ensureSetNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Set");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    // (#3171) Collection glue = makeGlue + the `size` accessor getter with a
    // real brand-checked reflective body.
    registerNativeProtoBuiltin(ctx, makeCollectionGlue(brand, "Set", SET_PROTO_METHODS));
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

/**
 * (#3236 S1) Register `%GeneratorPrototype%` glue (idempotent) and return its
 * brand. Members `next`/`return`/`throw` resolve as descriptor-carrying (§17
 * {w:T,e:F,c:T}) brand-checked callable closure values through the shared
 * native-proto reflective machinery; invoking one on a non-Generator `this`
 * degrades to the shared catchable TypeError (`emitProtoMemberBodyRefusal`),
 * which is exactly what every GeneratorPrototype value-call test expects.
 */
export function ensureGeneratorPrototypeNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "GeneratorPrototype");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    // `name: "Generator"` drives the refusal message ("Generator.prototype.<m>
    // …"); the member CSV is the three §27.5.1 methods. next/return/throw are
    // each arity 1 (spec length 1) via makeGlue's default.
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Generator", ["next", "return", "throw"]));
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

/**
 * (#2861) Register `ArrayBuffer.prototype` glue (idempotent) and return its
 * brand. The ArrayBuffer brand is pre-reserved in `BUILTIN_BRAND_TABLE`; this
 * fills in the member CSV (with the accessor getters marked) so a bare
 * `ArrayBuffer.prototype` / `ArrayBuffer.prototype.<member>` value read resolves
 * host-free instead of refusing. ArrayBuffer's proto value object carries no
 * vec/runtime-state entanglement (the byte vec lives on the INSTANCE, never the
 * proto), so the materialization is clean. Reflective member-CLOSURE bodies
 * degrade to a catchable TypeError until native bodies land.
 */
export function ensureArrayBufferNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "ArrayBuffer");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    const glue = makeGlueWithGetters(
      brand,
      "ArrayBuffer",
      ARRAYBUFFER_PROTO_METHODS,
      ARRAYBUFFER_PROTO_GETTERS,
      ARRAYBUFFER_PROTO_METHOD_LENGTH,
    );
    // (#1595) `transfer` and `transferToFixedLength` have an optional
    // newLength parameter even though their spec `.length` is 0. Give the
    // reflective closure a real argument slot, then delegate its body to the
    // same native ArrayBufferCopyAndDetach helper used by direct calls.
    glue.memberParamSlots = (member) =>
      member === "transfer" || member === "transferToFixedLength" ? 1 : member === "slice" ? 2 : 0;
    glue.emitMemberBody = (c, fctx, member) => emitArrayBufferProtoMemberBody(c, fctx, member);
    registerNativeProtoBuiltin(ctx, glue);
  }
  return brand;
}

/**
 * (#2861) Register `DataView.prototype` glue (idempotent) and return its brand.
 * Same shape as ArrayBuffer — the get/set accessors operate on the INSTANCE's
 * viewed buffer, so the proto value object is pure (member CSV only). The three
 * `buffer`/`byteLength`/`byteOffset` accessor getters fold their `.length` to 0.
 */
export function ensureDataViewNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "DataView");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    const glue = makeGlueWithGetters(
      brand,
      "DataView",
      DATAVIEW_PROTO_METHODS,
      DATAVIEW_PROTO_GETTERS,
      DATAVIEW_PROTO_METHOD_LENGTH,
    );
    // (#3173) Real reflective member bodies: get*/set* delegate to the shared
    // `__dv_m_<member>` native core (brand → ToIndex → [ToNumber] → detached →
    // bounds → op); `buffer`/`byteLength`/`byteOffset` getters brand-check and
    // read the `$__dv_window` inline. This is what makes
    // `DataView.prototype.getUint8.call({})` throw the §24.3.1.1 TypeError
    // (this-has-no-dataview-internal.js) instead of refusing.
    glue.emitMemberBody = (c, fctx, member) => emitDataViewProtoMemberBody(c, fctx, member);
    // The uncounted littleEndian arg needs a real param slot: get*(offset[, le])
    // → 2 slots (spec length 1), set*(offset, value[, le]) → 3 slots (length 2).
    // Getter members return 0 (no slots).
    glue.memberParamSlots = (member) => (member.startsWith("get") ? 2 : member.startsWith("set") ? 3 : 0);
    registerNativeProtoBuiltin(ctx, glue);
  }
  return brand;
}

/**
 * (#2861) Register `SharedArrayBuffer.prototype` glue (idempotent). Same clean
 * value-object shape as ArrayBuffer (the shared byte vec lives on the instance).
 */
export function ensureSharedArrayBufferNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "SharedArrayBuffer");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(
      ctx,
      makeGlueWithGetters(
        brand,
        "SharedArrayBuffer",
        SHAREDARRAYBUFFER_PROTO_METHODS,
        SHAREDARRAYBUFFER_PROTO_GETTERS,
        SHAREDARRAYBUFFER_PROTO_METHOD_LENGTH,
      ),
    );
  }
  return brand;
}

/**
 * (#2861) Register `WeakRef.prototype` glue (idempotent). Single `deref` method;
 * no accessor getters — plain `makeGlue`. The held value lives on the instance,
 * so the proto value object is pure.
 */
export function ensureWeakRefNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "WeakRef");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "WeakRef", WEAKREF_PROTO_METHODS));
  }
  return brand;
}

/**
 * (#2861) Register `FinalizationRegistry.prototype` glue (idempotent). The
 * FinalizationRegistry brand is newly appended to `BUILTIN_BRAND_TABLE` (slot 40).
 * `register`/`unregister` methods; no getters — plain `makeGlue`.
 */
export function ensureFinalizationRegistryNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "FinalizationRegistry");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "FinalizationRegistry", FINALIZATIONREGISTRY_PROTO_METHODS));
  }
  return brand;
}

/**
 * (#2861) Register `DisposableStack.prototype` glue (idempotent). The
 * DisposableStack brand is newly appended to `BUILTIN_BRAND_TABLE` (slot 41).
 * `use`/`adopt`/`defer`/`move`/`dispose` methods + the `disposed` accessor
 * getter (folds `.length` to 0) → `makeGlueWithGetters`. The resource list
 * lives on the instance, so the proto value object is pure (member CSV only).
 */
export function ensureDisposableStackNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "DisposableStack");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(
      ctx,
      makeGlueWithGetters(
        brand,
        "DisposableStack",
        DISPOSABLESTACK_PROTO_METHODS,
        DISPOSABLESTACK_PROTO_GETTERS,
        DISPOSABLESTACK_PROTO_METHOD_LENGTH,
      ),
    );
  }
  return brand;
}

/**
 * (#2861) Register `AsyncDisposableStack.prototype` glue (idempotent). The
 * AsyncDisposableStack brand is newly appended to `BUILTIN_BRAND_TABLE` (slot
 * 42). Same shape as DisposableStack with `disposeAsync` in place of `dispose`.
 */
export function ensureAsyncDisposableStackNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "AsyncDisposableStack");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(
      ctx,
      makeGlueWithGetters(
        brand,
        "AsyncDisposableStack",
        ASYNCDISPOSABLESTACK_PROTO_METHODS,
        ASYNCDISPOSABLESTACK_PROTO_GETTERS,
        ASYNCDISPOSABLESTACK_PROTO_METHOD_LENGTH,
      ),
    );
  }
  return brand;
}

/**
 * (#2651 M1 / D2) The 9 non-bigint TypedArray view ctor names. Drives
 * `isWiredTypedArrayViewName` — the `%TypedArray%` intrinsic-ctor identity,
 * `Object.getPrototypeOf(<view>)` recognition, and dynamic-`new` brand dispatch.
 * The bigint views stay OUT of this list (their reflective i64 getter bodies +
 * those consumers are a separate slice); their `.prototype` value read is wired
 * via `TYPED_ARRAY_VIEW_PROTO_NAMES` below (#1907).
 */
const WIRED_TYPED_ARRAY_VIEWS = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
] as const;

/**
 * (#1907) Every TypedArray view whose `<View>.prototype` VALUE read resolves
 * host-free — the 9 non-bigint views plus the 2 bigint views, which inherit the
 * same `%TypedArray%.prototype` member set (§23.2; the proto is a pure value
 * object, so no i64-specific body is emitted). Closes the reopened `#1907 /
 * #1888 S6-b` `BigInt64Array.prototype` / `BigUint64Array.prototype` refusal
 * left after #838 landed the views.
 */
const TYPED_ARRAY_VIEW_PROTO_NAMES: ReadonlySet<string> = new Set<string>([
  ...WIRED_TYPED_ARRAY_VIEWS,
  "BigInt64Array",
  "BigUint64Array",
]);

/**
 * (#2651 M1 / D2) Register the abstract `%TypedArray%.prototype` glue (idempotent)
 * and return its brand. This is the single shared member set; every concrete view
 * proto reuses `TYPED_ARRAY_PROTO_METHODS` (they inherit from this intrinsic), so
 * binary size stays proportional. The `%TypedArray%` brand is pre-reserved in
 * `BUILTIN_BRAND_TABLE`.
 */
export function ensureTypedArrayIntrinsicNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "%TypedArray%");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeTypedArrayGlue(brand, "%TypedArray%"));
  }
  return brand;
}

/**
 * (#2651 M1 / D2) Register a concrete TypedArray view's `<View>.prototype` glue
 * (idempotent) and return its brand, or `undefined` if `viewName` is not a
 * TypedArray view (caller falls through to the existing refusal). All 11 views
 * (incl. the two bigint views, #1907) share the `%TypedArray%.prototype` member
 * set (`TYPED_ARRAY_PROTO_METHODS`); the proto value object is pure (member CSV
 * only). The brand is the per-view brand pre-reserved in `BUILTIN_BRAND_TABLE`.
 */
export function ensureTypedArrayViewNativeProtoGlue(ctx: CodegenContext, viewName: string): number | undefined {
  if (!TYPED_ARRAY_VIEW_PROTO_NAMES.has(viewName)) return undefined;
  const brand = getBuiltinBrand(ctx, viewName);
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeTypedArrayGlue(brand, viewName));
  }
  // Also materialize the shared intrinsic glue so the parent member set exists
  // (D4 links concrete-view protos to it in a later slice; harmless here).
  ensureTypedArrayIntrinsicNativeProtoGlue(ctx);
  return brand;
}

/** (#2901) True iff `name` is a wired (non-bigint) `%TypedArray%` view constructor. */
export function isWiredTypedArrayViewName(name: string): boolean {
  return (WIRED_TYPED_ARRAY_VIEWS as readonly string[]).includes(name);
}

/**
 * (#2901) Materialize the standalone `%TypedArray%` INTRINSIC CONSTRUCTOR object
 * as a runtime value: a lazily-cached `$Object` singleton carrying a single
 * `prototype` own-property pointing at the existing `%TypedArray%.prototype`
 * `$NativeProto` glue. This is the object the test262 `testTypedArray.js` harness
 * obtains via `Object.getPrototypeOf(<view ctor>)` and then reads `.prototype` off
 * to reach `%TypedArray%.prototype` (and thence the §23.2.3 accessor descriptors
 * the #2893 getter bodies serve).
 *
 * Modelled on `emitBuiltinNamespaceObject` (builtin-static-globals.ts): one
 * mutable null-init externref global, lazily populated via `__new_plain_object` +
 * `__extern_set("prototype", <proto>)`, cached so the intrinsic ctor identity is
 * stable (`getProtoOf(Int8Array) === getProtoOf(Uint8Array)`, per the harness's
 * single `%TypedArray%`). Standalone only (the `$NativeProto` glue + `$Object`
 * runtime are standalone constructs). Leaves the ctor externref on the stack;
 * returns its ValType, or `null` if the `%TypedArray%` glue/runtime is unavailable
 * (caller falls through to the existing getProtoOf behaviour).
 */
export function emitTypedArrayIntrinsicCtorObject(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  const brand = ensureTypedArrayIntrinsicNativeProtoGlue(ctx);
  if (brand === undefined) return null;

  ensureObjectRuntime(ctx);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object");
  const setIdx = ctx.funcMap.get("__extern_set");
  if (newObjectIdx === undefined || setIdx === undefined) return null;

  const globalName = "__builtin_%TypedArray%_ctor";
  let globalIdx = ctx.builtinObjectGlobals.get(globalName);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: globalName,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(globalName, globalIdx);
  }

  const objLocal = allocLocal(fctx, `__ta_ctor_obj_${fctx.locals.length}`, { kind: "externref" });
  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: objLocal },
  ];

  // (#2182 pattern) `savedBody` is detached during the swap; register it in
  // `liveBodies` so any late-import funcidx shift still walks it.
  const savedBody = fctx.body;
  fctx.body = initBody;
  ctx.liveBodies.add(savedBody);
  let ok = true;
  try {
    // obj.prototype = %TypedArray%.prototype glue object
    fctx.body.push({ op: "local.get", index: objLocal });
    addStringConstantGlobal(ctx, "prototype");
    for (const instr of stringConstantExternrefInstrs(ctx, "prototype")) fctx.body.push(instr);
    if (emitLazyNativeProtoGet(ctx, fctx, brand)) {
      fctx.body.push({ op: "call", funcIdx: setIdx });
      // `%TypedArray%` is the abstract base CONSTRUCTOR (§23.2.1) — a function,
      // not a plain object. Brand the carrier callable/constructible so
      // `typeof TypedArray === "function"` (the literal testTypedArray.js
      // harness self-check, L17) answers through the #4120 branded-carrier
      // typeof arm. Actually CALLING it still goes through the generic
      // dispatch (a real `%TypedArray%()` invocation must throw TypeError —
      // out of scope here; the brand only fixes classification).
      pushMarkBuiltinCarrierCallable(ctx, fctx, objLocal);
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "global.set", index: globalIdx });
    } else {
      ok = false;
    }
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }
  if (!ok) return null;

  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}

/**
 * (#3236 S1) Native standalone `%Function.prototype%` as a plain `$Object`
 * singleton (distinct from the `Function` `$NativeProto` glue used for
 * `Function.prototype.<method>` VALUE reads). This is the proto-CHAIN target:
 * the object `Object.getPrototypeOf` must return for an ordinary function AND
 * the `[[Prototype]]` of `%Generator%` (§20.2.3 / §27.3.3.2). It must be a
 * `$Object` so the native `__getPrototypeOf` `$proto`-walk returns it and its
 * identity is stable across every reader (`getProtoOf(f) === getProtoOf(
 * getProtoOf(g))`). Built with `__object_create(null)` — its own `[[Prototype]]`
 * (%Object.prototype%) is not exercised by any Slice-1 test. Standalone/WASI
 * only; returns the externref ValType or `null` if the `$Object` runtime is
 * unavailable.
 */
export function emitFunctionPrototypeObjectSingleton(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  ensureObjectRuntime(ctx);
  const createIdx = ctx.funcMap.get("__object_create");
  if (createIdx === undefined) return null;

  const globalName = "__native_function_prototype_obj";
  let globalIdx = ctx.builtinObjectGlobals.get(globalName);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: globalName,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(globalName, globalIdx);
  }

  // Lazy init: `if (g == null) g = __object_create(null);` then read it. The
  // init body nests directly inside the `if` (part of `fctx.body`), so any late-
  // import funcIdx shift walks it naturally.
  const initBody: Instr[] = [
    { op: "ref.null.extern" }, // proto = null → OrdinaryObjectCreate
    { op: "call", funcIdx: createIdx },
    { op: "global.set", index: globalIdx },
  ];
  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}

/**
 * (#3236 S1) Native standalone `%GeneratorPrototype%` value — the object reached
 * by `genFn.prototype` and `getPrototypeOf(genFn).prototype` (§27.5.1).
 *
 * A lazily-cached `$Object` singleton (NOT a `$NativeProto`): the test binds it
 * to an `any`-typed variable (`var GP = Object.getPrototypeOf(g).prototype`) and
 * then does the RUNTIME dynamic reads `GP.next`, `Object.getOwnPropertyDescriptor
 * (GP,"next")`, `GP.next.call(x)`. Those reflective `$Object` reads only resolve
 * REAL own data properties — the `$NativeProto` member CSV is only consulted by
 * the compile-time `<Builtin>.prototype.<member>` syntactic path — so each of
 * `next`/`return`/`throw` is installed as a genuine own data property (§17
 * {w:T,e:F,c:T}) whose VALUE is the identity-stable brand-checked native-method
 * closure from the shared factory. Invoking one on a non-Generator `this` throws
 * the factory's catchable TypeError (`refusalBodyFallback`) — exactly what every
 * GeneratorPrototype value-call test (`this-val-not-{object,generator}`) expects.
 * Leaves the GP externref on the stack; returns its ValType or `null` on
 * unavailable runtime.
 */
export function emitGeneratorPrototypeSingleton(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  const brand = ensureGeneratorPrototypeNativeProtoGlue(ctx);
  if (brand === undefined) return null;

  ensureObjectRuntime(ctx);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object");
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (newObjectIdx === undefined || defineIdx === undefined) return null;

  const globalName = "__native_generator_prototype_obj";
  let globalIdx = ctx.builtinObjectGlobals.get(globalName);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: globalName,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(globalName, globalIdx);
  }

  const objLocal = allocLocal(fctx, `__gen_proto_obj_${fctx.locals.length}`, { kind: "externref" });
  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: objLocal },
  ];

  // (#2182 pattern) `savedBody` is detached during the swap; register it in
  // `liveBodies` so a late-import funcidx shift walks the baked `ref.func`s.
  const savedBody = fctx.body;
  fctx.body = initBody;
  ctx.liveBodies.add(savedBody);
  let ok = true;
  try {
    // §17 method descriptor attributes: writable:true, enumerable:false,
    // configurable:true → `__defineProperty_value` flags bit0|bit2 = 5.
    const METHOD_FLAGS = 0x01 | 0x04;
    for (const member of ["next", "return", "throw"] as const) {
      const closure = ensureStandaloneNativeMethodClosure(ctx, brand, member, "method", {
        refusalBodyFallback: true,
      });
      if (!closure) {
        ok = false;
        break;
      }
      // GP.<member> = <identity-stable brand-checked method closure value>
      fctx.body.push({ op: "local.get", index: objLocal });
      addStringConstantGlobal(ctx, member);
      for (const instr of stringConstantExternrefInstrs(ctx, member)) fctx.body.push(instr);
      for (const instr of pushBuiltinFnSingletonValueInstrs(ctx, closure)) fctx.body.push(instr);
      fctx.body.push({ op: "extern.convert_any" }); // closure ref → externref value
      fctx.body.push({ op: "f64.const", value: METHOD_FLAGS });
      fctx.body.push({ op: "call", funcIdx: defineIdx });
      fctx.body.push({ op: "drop" }); // helper returns the target; discard
    }
    if (ok) {
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "global.set", index: globalIdx });
    }
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }
  if (!ok) return null;

  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}

/**
 * (#3236 S1) Native standalone `%Generator%` (= `%GeneratorFunction.prototype%`,
 * §27.3.3) value — the object `getPrototypeOf(genFn)` must return. A lazily-cached
 * `$Object` singleton whose:
 *   - `[[Prototype]]` (`$proto`) is `%Function.prototype%` (so
 *     `getPrototypeOf(getPrototypeOf(genFn)) === getPrototypeOf(ordinaryFn)`,
 *     §27.3.3.2 — the `prototype-relation-to-function.js` identity), built via
 *     `__object_create(%Function.prototype%)`, and
 *   - own `prototype` data property is `%GeneratorPrototype%` (§27.3.3.3), so
 *     `getPrototypeOf(genFn).prototype` reaches GP for the GeneratorPrototype
 *     descriptor / this-val tests.
 * Modelled on `emitTypedArrayIntrinsicCtorObject` (the `$Object`-with-a-native-
 * proto-`prototype` shape). Standalone/WASI only. Leaves the `%Generator%`
 * externref on the stack; returns its ValType or `null` on unavailable runtime.
 */
export function emitGeneratorFunctionPrototypeSingleton(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  const brand = ensureGeneratorPrototypeNativeProtoGlue(ctx);
  if (brand === undefined) return null;

  ensureObjectRuntime(ctx);
  const createIdx = ctx.funcMap.get("__object_create");
  const setIdx = ctx.funcMap.get("__extern_set");
  if (createIdx === undefined || setIdx === undefined) return null;

  const globalName = "__native_generator_function_prototype";
  let globalIdx = ctx.builtinObjectGlobals.get(globalName);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: globalName,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(globalName, globalIdx);
  }

  const objLocal = allocLocal(fctx, `__genfn_proto_obj_${fctx.locals.length}`, { kind: "externref" });
  const initBody: Instr[] = [];

  // (#2182 pattern) `savedBody` is detached during the swap; register it in
  // `liveBodies` so any late-import funcidx shift still walks it.
  const savedBody = fctx.body;
  fctx.body = initBody;
  ctx.liveBodies.add(savedBody);
  let ok = true;
  try {
    // G = __object_create(%Function.prototype%)  — sets $proto for the relation
    // identity. FP materialization (its own lazy-global guard) nests here.
    if (emitFunctionPrototypeObjectSingleton(ctx, fctx) === null) {
      ok = false;
    } else {
      fctx.body.push({ op: "call", funcIdx: createIdx });
      fctx.body.push({ op: "local.set", index: objLocal });
      // G.prototype = %GeneratorPrototype%
      fctx.body.push({ op: "local.get", index: objLocal });
      addStringConstantGlobal(ctx, "prototype");
      for (const instr of stringConstantExternrefInstrs(ctx, "prototype")) fctx.body.push(instr);
      if (emitGeneratorPrototypeSingleton(ctx, fctx) !== null) {
        fctx.body.push({ op: "call", funcIdx: setIdx });
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "global.set", index: globalIdx });
      } else {
        ok = false;
      }
    }
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }
  if (!ok) return null;

  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}

/**
 * Native standalone `%AsyncGenerator%` (= `%AsyncGeneratorFunction.prototype%`)
 * identity used by primordial capture. The outer object owns a stable
 * `prototype` value representing `%AsyncGeneratorPrototype%`.
 *
 * Async-generator frame dispatch already lives in the async iterator runtime;
 * exposing `next`/`return`/`throw` as first-class method closures is a separate
 * semantic layer. Keeping the nested object distinct (rather than aliasing the
 * synchronous generator prototype) preserves the intrinsic identities while
 * allowing reflection/bootstrap to proceed without a JavaScript host.
 */
export function emitAsyncGeneratorFunctionPrototypeSingleton(
  ctx: CodegenContext,
  fctx: FunctionContext,
): ValType | null {
  ensureObjectRuntime(ctx);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object");
  const setIdx = ctx.funcMap.get("__extern_set");
  if (newObjectIdx === undefined || setIdx === undefined) return null;

  const globalName = "__native_async_generator_function_prototype";
  let globalIdx = ctx.builtinObjectGlobals.get(globalName);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: globalName,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(globalName, globalIdx);
  }

  const outerLocal = allocLocal(fctx, `__async_genfn_proto_${fctx.locals.length}`, { kind: "externref" });
  const innerLocal = allocLocal(fctx, `__async_gen_proto_${fctx.locals.length}`, { kind: "externref" });
  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: innerLocal },
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: outerLocal },
    { op: "local.get", index: outerLocal },
  ];
  addStringConstantGlobal(ctx, "prototype");
  initBody.push(...stringConstantExternrefInstrs(ctx, "prototype"));
  initBody.push(
    { op: "local.get", index: innerLocal },
    { op: "call", funcIdx: setIdx },
    { op: "local.get", index: outerLocal },
    { op: "global.set", index: globalIdx },
  );

  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}

/**
 * (#2996) Native standalone `globalThis` value. In host/gc mode a bare
 * `globalThis` identifier read leaks the `env::__get_globalThis` host import
 * (see `compileIdentifier`), which a no-JS-host binary can't satisfy — yet the
 * value still leaks into the standalone import section. The 47 sole-import
 * `__get_globalThis` leaky-passes (annexB `emulates-undefined`, `global-code`,
 * Array/Proxy cross-realm) never actually *read* a property off the resulting
 * object; they only need `globalThis` to be a valid object value (it lands in
 * the test262 `$262 = { global: globalThis, … }` harness stub, or an unread
 * slot). This resolves bare `globalThis` to a native, lazily-created, cached
 * `$Object` singleton (stable identity: `globalThis === globalThis`) built with
 * the same `__new_plain_object` runtime an empty `{}` uses — zero host imports.
 *
 * Scope note: this reifies the READ-value substrate. As of #2988,
 * `compilePropertyAccess`'s dedicated `globalThis.prop` reflective-read path also
 * routes to THIS singleton in standalone/WASI (host/gc still uses
 * `__extern_get(__get_globalThis(), key)`), so reflective reads round-trip with
 * `Object.defineProperty(globalThis, …)` / `globalThis.x = v` writes host-free
 * (all three resolve to the one native singleton). Standalone/WASI only; returns
 * the externref ValType, or `null` if the `$Object` runtime is unavailable
 * (caller falls through to the host-import path).
 */
export function emitNativeGlobalThisObject(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  ensureObjectRuntime(ctx);
  const globalName = "__native_globalThis";
  let globalIdx = ctx.builtinObjectGlobals.get(globalName);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: globalName,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(globalName, globalIdx);
  }

  // Lazy init: allocate the one realm object and install the three immutable
  // ES5 global value properties plus the ES5 global function properties on
  // that real carrier. The old gOPD special case assumed top-level script
  // `this` still lowered to undefined; #3365 now
  // correctly lowers it to this object, so the runtime object itself must own
  // the descriptors.  Seeding here also makes dynamic/IR-driven reflection see
  // the same state instead of depending on an AST-only gOPD fold.
  //
  // Settle every late helper before capturing function indices in the detached
  // seed arrays. `standaloneGlobalFunctionSeedInstrs` follows the same rule for
  // its callable seeds; live indices are read only after both families settle.
  ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  const objLocal = allocLocal(fctx, `__native_globalThis_obj_${fctx.locals.length}`, { kind: "externref" });

  // Deno's primordials bootstrap deliberately discovers namespace objects via
  // a computed realm-global read (`globalThis[name]`) before copying their own
  // descriptors. The namespace carrier and the realm property must therefore
  // be the same object; an empty or second carrier loses function identity.
  // Build these demand-driven seeds through the canonical namespace emitter.
  // Keep the detached body live while later seed construction can still add
  // imports and shift defined-function indices.
  const savedBody = fctx.body;
  fctx.body = [];
  ctx.liveBodies.add(savedBody);
  for (const name of ["Array", "Object", "JSON", "Math", "Proxy", "Reflect"] as const) {
    fctx.body.push({ op: "local.get", index: objLocal });
    addStringConstantGlobal(ctx, name);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, name));
    if (emitBuiltinNamespaceObject(ctx, fctx, name) === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const defineIdx = ctx.funcMap.get("__defineProperty_value");
    if (defineIdx === undefined) {
      fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "drop" });
      continue;
    }
    // Global builtin bindings: writable, non-enumerable, configurable.
    fctx.body.push({ op: "f64.const", value: 0x05 }, { op: "call", funcIdx: defineIdx }, { op: "drop" });
  }
  const namespaceSeeds = fctx.body;
  fctx.body = savedBody;
  ctx.liveBodies.delete(savedBody);
  ctx.liveBodies.add(namespaceSeeds);
  const functionSeeds = standaloneGlobalFunctionSeedInstrs(ctx, objLocal);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object");
  const defineValueIdx = ctx.funcMap.get("__defineProperty_value");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  if (!functionSeeds || newObjectIdx === undefined || defineValueIdx === undefined || boxNumberIdx === undefined) {
    ctx.liveBodies.delete(namespaceSeeds);
    return null;
  }

  for (const key of ["NaN", "Infinity", "undefined"]) addStringConstantGlobal(ctx, key);
  const valueSeeds: Instr[] = [];
  const seedValue = (key: string, value: Instr[]): void => {
    valueSeeds.push(
      { op: "local.get", index: objLocal },
      ...stringConstantExternrefInstrs(ctx, key),
      ...value,
      { op: "f64.const", value: 0 }, // writable/enumerable/configurable: false
      { op: "call", funcIdx: defineValueIdx },
      { op: "drop" },
    );
  };
  seedValue("NaN", [
    { op: "f64.const", value: Number.NaN },
    { op: "call", funcIdx: boxNumberIdx },
  ]);
  seedValue("Infinity", [
    { op: "f64.const", value: Number.POSITIVE_INFINITY },
    { op: "call", funcIdx: boxNumberIdx },
  ]);
  seedValue("undefined", undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }]);
  seedValue("globalThis", [{ op: "local.get", index: objLocal }]);

  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: objLocal },
    ...functionSeeds,
    ...valueSeeds,
    ...namespaceSeeds,
    { op: "local.get", index: objLocal },
    { op: "global.set", index: globalIdx },
  ];
  ctx.liveBodies.delete(namespaceSeeds);
  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });

  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}

/**
 * (#3013) Native standalone `%ArrayIteratorPrototype%` value — the ONE shared
 * prototype object every array iterator (`[].values()` / `.keys()` / `.entries()`
 * / `[][Symbol.iterator]()`) reports from `Object.getPrototypeOf`. ECMA-262
 * §23.1.5.2: all array iterators are `ObjectCreate(%ArrayIteratorPrototype%, …)`,
 * so `Object.getPrototypeOf([].values()) === Object.getPrototypeOf(
 * [][Symbol.iterator]())` MUST hold by object identity.
 *
 * Standalone array iterators are native `$__IterRec` structs (array-methods.ts /
 * iterator-native.ts); their [[Prototype]] is not modeled, so the pre-#3013
 * `Object.getPrototypeOf(<iterator>)` standalone fallback returned
 * `ref.null.extern` — which made the identity assertion pass only COINCIDENTALLY
 * (null === null) and, worse, made `getPrototypeOf([].values()) ===
 * getPrototypeOf([1, 2])` ALSO pass (both null). This reifies a genuine,
 * identity-stable `$Object` singleton (same `__new_plain_object` runtime as
 * `{}`), lazily materialized once, cached in a module-level mutable global. Every
 * array-iterator `getPrototypeOf` routes to the SAME global, so identity is
 * genuine: same singleton across all array iterators (true), distinct from array
 * / plain-object / other-kind-iterator prototypes (false under the swap-guard).
 *
 * The routing is keyed on the STATIC type being `ArrayIterator<T>` (the TS
 * checker's precise symbol name for all four array-iterator producers, distinct
 * from `Generator`/`MapIterator`/`SetIterator`/`StringIterator`), so no
 * cross-kind iterator is mis-routed to this prototype. Standalone/WASI only;
 * returns the externref ValType, or `null` if the `$Object` runtime is
 * unavailable (caller falls through to the host-import path).
 */
export type NativeIteratorPrototypeKind = "Array" | "Map" | "Set" | "String";

/**
 * Materialize one identity-stable intrinsic iterator prototype object.
 *
 * The iterator record carriers do not model [[Prototype]] yet. Keeping one
 * singleton per iterator family nevertheless gives reflective bootstrap code
 * a genuine object identity (rather than null) and prevents Map/Set/String
 * iterator prototypes from collapsing onto %ArrayIteratorPrototype%.
 */
export function emitIteratorPrototypeSingleton(
  ctx: CodegenContext,
  fctx: FunctionContext,
  kind: NativeIteratorPrototypeKind,
): ValType | null {
  ensureObjectRuntime(ctx);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object");
  if (newObjectIdx === undefined) return null;

  const globalName = `__native_${kind.toLowerCase()}_iterator_prototype`;
  let globalIdx = ctx.builtinObjectGlobals.get(globalName);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: globalName,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(globalName, globalIdx);
  }

  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "global.set", index: globalIdx },
  ];
  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}

export function emitArrayIteratorPrototypeSingleton(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  return emitIteratorPrototypeSingleton(ctx, fctx, "Array");
}
