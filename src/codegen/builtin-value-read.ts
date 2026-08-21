// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Built-in static / prototype VALUE-read codegen.
 *
 * Extracted from property-access.ts (#3267, subtask of #3182). Pure move — no
 * logic changes. Groups the metadata tables (Math/Number constant props + values,
 * TypedArray BYTES_PER_ELEMENT, ctor arity, well-known-symbol ids) and the
 * standalone (#1907 / #1888 S6-b) built-in value-read machinery that folds
 * `<Ctor>.length`/`.name`, `<Builtin>.prototype.<member>`, and
 * `<Builtin>.<staticMethod>` reads into native-proto glue / metadata closures.
 *
 * The group has zero real code back-edges into property-access.ts: it imports
 * only leaf helpers, and property-access.ts imports/re-exports back from here.
 */

import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { numberIsPredicateOps } from "./number-is-predicate-ops.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addUnionImports, TYPED_ARRAY_NAMES, typedArrayPackedSignedness } from "./index.js";
import {
  coerceType,
  compileStringLiteral,
  ensureLateImport,
  flushLateImportShifts,
  skipTransparentExpressions,
  valTypesMatch,
} from "./shared.js";
import { emitThrowTypeError, noJsHost } from "./expressions/helpers.js";
import { allocLocal } from "./context/locals.js";
import { reportErrorNoNode } from "./context/errors.js";
import { ensureRegExpNativeProtoGlue } from "./regexp-standalone.js";
import {
  ensureArrayNativeProtoGlue,
  ensureObjectNativeProtoGlue,
  ensureStringNativeProtoGlue,
  ensureNumberNativeProtoGlue,
  ensureBooleanNativeProtoGlue,
  ensureDateNativeProtoGlue,
  ensureErrorNativeProtoGlue,
  ensureNativeErrorNativeProtoGlue,
  ensurePromiseNativeProtoGlue,
  ensureIteratorNativeProtoGlue,
  ensureMapNativeProtoGlue,
  ensureSetNativeProtoGlue,
  ensureFunctionNativeProtoGlue,
  ensureSymbolNativeProtoGlue,
  ensureBigIntNativeProtoGlue,
  ensureWeakMapNativeProtoGlue,
  ensureWeakSetNativeProtoGlue,
  ensureArrayBufferNativeProtoGlue,
  ensureDataViewNativeProtoGlue,
  ensureSharedArrayBufferNativeProtoGlue,
  ensureWeakRefNativeProtoGlue,
  ensureFinalizationRegistryNativeProtoGlue,
  ensureDisposableStackNativeProtoGlue,
  ensureAsyncDisposableStackNativeProtoGlue,
  ensureTypedArrayViewNativeProtoGlue,
  ensureTypedArrayIntrinsicNativeProtoGlue,
} from "./array-object-proto.js";
import { emitLazyNativeProtoGet, getBuiltinBrand, getNativeProtoBuiltinGlue } from "./native-proto.js";
import { resolveStandaloneProtoMemberValueClosure } from "./native-proto-value-read.js";
import { emitBuiltinProtoConstructorValue } from "./builtin-proto-constructor.js";
import {
  BUILTIN_STATIC_METHOD_ARITY,
  ensureBuiltinFnMetaType,
  pushBuiltinFnSingletonValueInstrs,
  STANDALONE_STATIC_METHOD_META,
} from "./builtin-fn-meta.js";
import { getOrCreateFuncRefWrapperTypes } from "./closures.js";
import { emitJsonStringifyValue } from "./json-codec-native.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureExtrasArgvGlobal } from "./statements/nested-declarations.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { emitMathValueReadBody } from "./math-value-read.js"; // (#4565)
import { ensureAnyFromExternHelper, ensureAnyHelpers, ensureExternStrictEqHelper } from "./any-helpers.js";
import { sameValueNumberOps } from "./same-value-number-ops.js";
import { ensureObjectRuntime, ensureObjVecBuilders } from "./object-runtime.js";

export const BUILTIN_CTOR_NAMES = new Set([
  "Object",
  "Array",
  "Function",
  "Symbol",
  "Proxy",
  "Reflect",
  "Math",
  "BigInt",
  "JSON",
  "Date",
  "RegExp",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Promise",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Atomics",
  "Iterator",
  "Map",
  "Set",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "String",
  "Number",
  "Boolean",
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
  // (#2029) Explicit-resource-management constructors. Without these, a
  // `DisposableStack.prototype` / `AsyncDisposableStack.prototype` value read
  // fell through BOTH the standalone built-in path (refuse-loud / native proto)
  // AND the host `__get_builtin` fallback, landing in a generic member path that
  // emitted `global.get -1` (the -1 string-global sentinel) → `global index out
  // of range — -1` encoder crash standalone (whole file lost). Listing them
  // routes the read to the dual-mode handler: a loud, located refusal standalone
  // (no poisoned index), `__get_builtin` under gc/host — identical to every
  // other builtin ctor (`Map.prototype`/`Map.length` already refuse-loud
  // standalone).
  "DisposableStack",
  "AsyncDisposableStack",
  // (#2029) `SuppressedError` (ES2025 error aggregation) — same class as the
  // DisposableStack pair above: not listed here, a `SuppressedError.prototype.*`
  // read fell through both the standalone native-proto path and the host
  // `__get_builtin` fallback into a generic member path that emitted
  // `global.get -1` (the -1 string-global sentinel) → `global index out of
  // range — -1` encoder crash standalone (whole file lost; 9 test262 rows under
  // built-ins/SuppressedError/*). Listing it routes the read to the dual-mode
  // handler (loud located refusal standalone, `__get_builtin` under gc/host).
  "SuppressedError",
]);

// Well-known Symbol IDs (inlined from literals.ts to avoid circular deps)
const WELL_KNOWN_SYMBOLS: Record<string, number> = {
  iterator: 1,
  hasInstance: 2,
  toPrimitive: 3,
  toStringTag: 4,
  species: 5,
  isConcatSpreadable: 6,
  match: 7,
  replace: 8,
  search: 9,
  split: 10,
  unscopables: 11,
  asyncIterator: 12,
  dispose: 13,
  asyncDispose: 14,
  // (#3573) `matchAll` drifted out of this mirror of the literals.ts table
  // (id 15 there) — its absence made `hasNativeBuiltinConstantHandler` refuse
  // `Symbol.matchAll` value reads under --target standalone even though the
  // downstream constant emitter supports it. Keep in sync with literals.ts.
  matchAll: 15,
};

function getWellKnownSymbolId(name: string): number | undefined {
  return WELL_KNOWN_SYMBOLS[name];
}

/**
 * (#1888 S6-c) Math/Number constant property names that have a Wasm-native
 * fall-through emitter further down in `compileMemberRead` (the `f64.const`
 * handlers for `Math.PI` / `Number.MAX_SAFE_INTEGER` & co.). These MUST be
 * reachable: under `--target standalone` the generic `Builtin.prop` →
 * `__get_builtin` branch above them refuses-loud (the open-object runtime does
 * not expose `__get_builtin`), so without an exclusion `Math.PI` etc. fail to
 * compile even though a pure-Wasm `f64.const` lowering exists. Keep this set in
 * sync with the `mathConstants` / `numberConstants` tables below (the single
 * source of truth is those tables; this mirror only decides whether the
 * `__get_builtin` shortcut must yield to them). Symbol well-knowns
 * (`Symbol.iterator` etc.) are covered separately via `getWellKnownSymbolId`.
 */
const MATH_CONSTANT_PROPS = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);
const NUMBER_CONSTANT_PROPS = new Set([
  "EPSILON",
  "MAX_SAFE_INTEGER",
  "MIN_SAFE_INTEGER",
  "MAX_VALUE",
  "MIN_VALUE",
  "POSITIVE_INFINITY",
  "NEGATIVE_INFINITY",
  "NaN",
]);

/**
 * (#2933) Numeric VALUES of the `Math` / `Number` namespace static constants —
 * the single source of truth shared by the dot-access `f64.const` emitter (in
 * `compilePropertyAccess`) and the reflective element-access fold
 * (`tryEmitBuiltinNamespaceConstantValue`, used by `compileElementAccess` for
 * `Math["PI"]` / `const k = "PI"; Math[k]`). Keeping these here means the
 * reflective read and the direct read never drift.
 */
export const MATH_CONSTANT_VALUES: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
  LN2: Math.LN2,
  LN10: Math.LN10,
  SQRT2: Math.SQRT2,
  SQRT1_2: Math.SQRT1_2,
  LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E,
};
export const NUMBER_CONSTANT_VALUES: Record<string, number> = {
  EPSILON: Number.EPSILON,
  MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
  MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
  MAX_VALUE: Number.MAX_VALUE,
  MIN_VALUE: Number.MIN_VALUE,
  POSITIVE_INFINITY: Infinity,
  NEGATIVE_INFINITY: -Infinity,
  NaN: NaN,
};

/**
 * (#2933) Fold a `<namespace>.<constant>` VALUE read to its `f64.const` when
 * `builtinName` is `Math`/`Number` and `propName` is one of their numeric
 * static data constants. Returns the emitted `ValType` (`f64`) or `undefined`
 * when the pair is not a foldable namespace constant (caller falls through).
 *
 * Used by the reflective element-access path (`Math["PI"]`) so a computed read
 * of a namespace constant emits the SAME constant the syntactic dot read does.
 * Observationally identical in host mode (which would otherwise read the same
 * value via `__get_builtin`/`__extern_get`) and the only host-free lowering in
 * standalone (the generic computed read returns 0 there — #2933).
 */
function tryEmitBuiltinNamespaceConstantValue(
  fctx: FunctionContext,
  builtinName: string,
  propName: string,
): ValType | undefined {
  const table =
    builtinName === "Math" ? MATH_CONSTANT_VALUES : builtinName === "Number" ? NUMBER_CONSTANT_VALUES : undefined;
  if (!table || !(propName in table)) return undefined;
  fctx.body.push({ op: "f64.const", value: table[propName]! });
  return { kind: "f64" };
}

/**
 * (#2595) Per-constructor element byte width for `TypedArray.BYTES_PER_ELEMENT`
 * (static, §23.2.6.x) and `view.BYTES_PER_ELEMENT` (instance, §23.2.3.1). Both
 * reads are statically known per constructor name — pure constant folds, no
 * runtime support. Includes the two BigInt views (8 bytes each) which are not in
 * `TYPED_ARRAY_NAMES`. Single source of truth for both the static-read constant
 * emitter and the instance-read arm in the typed-array property block.
 */
export const TYPED_ARRAY_BYTES_PER_ELEMENT: Record<string, number> = {
  Int8Array: 1,
  Uint8Array: 1,
  Uint8ClampedArray: 1,
  Int16Array: 2,
  Uint16Array: 2,
  Int32Array: 4,
  Uint32Array: 4,
  Float32Array: 4,
  Float64Array: 8,
  BigInt64Array: 8,
  BigUint64Array: 8,
};

/**
 * (#2861) A built-in **constructor**'s own `length` (declared arity, a
 * non-configurable data property) — statically known per ctor name, so
 * `<Ctor>.length` folds to a numeric constant and `<Ctor>.name` folds to the
 * ctor-name string (`Ctor.name === "Ctor"` for every standard builtin). Both
 * refuse under `--target standalone` today (`#1907`/`#1888 S6-b` builtin static
 * value read); host mode reads the identical value via `__get_builtin`, so the
 * fold is observationally identical and host-mode never reaches the fold (the
 * `__get_builtin` branch returns first).
 *
 * Values verified against the host runtime (Node). The NAMESPACES `Math` / `JSON`
 * / `Reflect` / `Atomics` are deliberately EXCLUDED — they are not functions, so
 * their `.length`/`.name` are `undefined`; folding a name/arity for them would be
 * wrong, so they keep refusing (namespace static reads are a separate #2860
 * follow-up).
 */
export const BUILTIN_CTOR_ARITY: Record<string, number> = {
  Object: 1,
  Array: 1,
  Function: 1,
  Symbol: 0,
  Proxy: 2,
  BigInt: 1,
  Date: 7,
  RegExp: 2,
  ArrayBuffer: 1,
  SharedArrayBuffer: 1,
  DataView: 1,
  Promise: 1,
  WeakMap: 0,
  WeakSet: 0,
  WeakRef: 1,
  FinalizationRegistry: 1,
  Iterator: 0,
  Map: 0,
  Set: 0,
  Error: 1,
  TypeError: 1,
  RangeError: 1,
  SyntaxError: 1,
  URIError: 1,
  EvalError: 1,
  ReferenceError: 1,
  SuppressedError: 3,
  String: 1,
  Number: 1,
  Boolean: 1,
  Int8Array: 3,
  Uint8Array: 3,
  Uint8ClampedArray: 3,
  Int16Array: 3,
  Uint16Array: 3,
  Int32Array: 3,
  Uint32Array: 3,
  Float32Array: 3,
  Float64Array: 3,
  BigInt64Array: 3,
  BigUint64Array: 3,
  DisposableStack: 0,
  AsyncDisposableStack: 0,
};

/**
 * (#2593) Recover the packed-element signedness ("s"/"u") of a typed-array
 * element-access receiver from its TS type. Returns undefined when the receiver
 * is not a recognised integer typed-array view (callers then fall back to the
 * legacy storage-kind heuristic). The signedness must come from the VIEW NAME,
 * not the i8/i16 storage kind, because signed and unsigned views of the same
 * width share storage but read with opposite sign-extension.
 */
function typedArrayViewSignedness(ctx: CodegenContext, receiver: ts.Expression): "s" | "u" | undefined {
  const t = ctx.checker.getTypeAtLocation(receiver);
  let name = t.getSymbol()?.name ?? t.aliasSymbol?.name;
  // `new Int8Array(...)` receiver: recover the constructor name when the type
  // symbol is missing (e.g. a fresh NewExpression whose type didn't resolve).
  if ((!name || !TYPED_ARRAY_NAMES.has(name)) && ts.isNewExpression(receiver) && ts.isIdentifier(receiver.expression)) {
    name = receiver.expression.text;
  }
  if (!name || !TYPED_ARRAY_NAMES.has(name)) return undefined;
  return typedArrayPackedSignedness(name);
}

/**
 * True when `<builtinName>.<propName>` has a Wasm-native **f64 constant**
 * emitter downstream in `compileMemberRead` that the `__get_builtin` shortcut
 * must not pre-empt. Keeps the standalone path host-import-free for the
 * numeric-constant reads we can already lower natively (Math.PI →
 * `f64.const`, Number.MAX_SAFE_INTEGER → `f64.const`).
 *
 * Scoped to Math/Number f64 constants ONLY. `Symbol.<wellKnown>` also has a
 * downstream emitter (an `i32.const` symbol id), but that i32 result does not
 * yet compose safely with every consumer under standalone — e.g.
 * `Symbol.iterator !== undefined` would compare an i32 against an externref
 * `undefined`, producing **invalid Wasm**. Leaving the `__get_builtin` shortcut
 * to keep refusing-loud for Symbol is strictly safer than emitting an invalid
 * module (refuse-loud > silent-wrong); native Symbol value-reads are deferred
 * to the S6-b builtins-as-globals lever.
 */
function hasNativeBuiltinConstantHandler(builtinName: string, propName: string): boolean {
  // (#2861) `<Ctor>.length` (declared arity) / `<Ctor>.name` (ctor name string)
  // have a downstream constant emitter; defer the standalone refusal to it. Only
  // for real constructors (BUILTIN_CTOR_ARITY excludes the Math/JSON/Reflect/
  // Atomics namespaces, whose `.length`/`.name` are undefined). Checked FIRST so
  // it isn't pre-empted by the per-builtin branches below (e.g. the `Symbol`
  // branch returns for any non-well-known prop, which would refuse `Symbol.length`).
  // `length`/`name` never collide with a Math/Number constant name.
  if ((propName === "length" || propName === "name") && builtinName in BUILTIN_CTOR_ARITY) return true;
  if (builtinName === "Math") return MATH_CONSTANT_PROPS.has(propName);
  if (builtinName === "Number") return NUMBER_CONSTANT_PROPS.has(propName);
  // (#2610) `Symbol.<wellKnown>` as a VALUE folds to its small i32 sentinel id
  // at the downstream constant emitter (`getWellKnownSymbolId`, ~line 4072) —
  // host-free, no builtin-prototype object needed (NOT #2175-gated). Defer the
  // standalone builtin-static-value-read refusal to it, mirroring the
  // Math/Number constant defers above. Gate is exact: only the well-known
  // names the emitter actually folds (a non-well-known `Symbol.foo` returns
  // undefined here, so it still refuses-loud — correct, no constant exists).
  if (builtinName === "Symbol") return getWellKnownSymbolId(propName) !== undefined;
  // (#2595) `<TypedArrayName>.BYTES_PER_ELEMENT` static read has a downstream
  // constant emitter; defer the standalone `__get_builtin` refusal to it.
  if (propName === "BYTES_PER_ELEMENT") return builtinName in TYPED_ARRAY_BYTES_PER_ELEMENT;
  return false;
}

/**
 * Consume an externref value and push the Array.isArray boolean result.
 *
 * Spec basis: ECMA-262 §23.1.2.3 delegates to IsArray (§7.2.2).
 *
 * Two regimes (#2047 — unified):
 *
 * - **`--target standalone`**: route through the in-module native
 *   `__extern_is_array` helper. That helper is reserved with the object runtime
 *   and *filled at finalize* (`fillExternIsArray`) with the COMPLETE, filtered
 *   array-carrier list, so a value-read of `Array.isArray` taken before a later
 *   array type (e.g. `boolean[]` → `__vec_i32`) is registered no longer bakes an
 *   incomplete `ref.test` chain. This both fixes the first-emission snapshot bug
 *   (`const f = Array.isArray; f(boolean[])` ⇒ `false`) and excludes the
 *   exclusively-non-array byte carriers (`i32_byte` ArrayBuffer/DataView,
 *   `i8_byte` Uint8Array) per §7.2.2.
 * - **Host / WASI**: keep the inline `ref.test` chain over every registered vec
 *   type (it detects compiled WasmGC array values materialised into an externref
 *   slot — #1678), ORed in host mode with the real JS `Array.isArray` host
 *   predicate for foreign JS arrays (#1328). Host output is unchanged.
 */
export function emitArrayIsArrayExternrefPredicate(ctx: CodegenContext, fctx: FunctionContext): void {
  // (#2047) Standalone: defer entirely to the finalize-filled native helper.
  // It owns the complete, byte-carrier-filtered carrier list (late binding),
  // so neither declaration order nor lazy vec registration can produce a wrong
  // answer here. WASI is intentionally NOT routed here: its
  // `__extern_is_array` does not resolve to the native object-runtime func
  // (OBJECT_RUNTIME_HELPER_NAMES routing is `ctx.standalone`-only), so it stays
  // on the inline chain below.
  if (ctx.standalone) {
    const nativeIdx = ensureLateImport(ctx, "__extern_is_array", [{ kind: "externref" }], [{ kind: "i32" }]);
    if (nativeIdx !== undefined) {
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "call", funcIdx: nativeIdx });
      return;
    }
    // Defensive fallback (should not happen — the object runtime always reserves
    // the helper under standalone): nothing is an array.
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }

  const vecTypeIdxs = Array.from(new Set(ctx.vecTypeMap.values()));
  const isArrIdx =
    !noJsHost(ctx) && !ctx.strictNoHostImports
      ? ensureLateImport(ctx, "__extern_is_array", [{ kind: "externref" }], [{ kind: "i32" }])
      : undefined;

  if (vecTypeIdxs.length === 0 && isArrIdx === undefined) {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }

  const externTmp = allocLocal(fctx, `__isarr_ext_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: externTmp });
  let emittedTerm = false;

  if (vecTypeIdxs.length > 0) {
    const anyTmp = allocLocal(fctx, `__isarr_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
    fctx.body.push({ op: "local.get", index: externTmp });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "local.set", index: anyTmp });
    for (let vi = 0; vi < vecTypeIdxs.length; vi++) {
      fctx.body.push({ op: "local.get", index: anyTmp });
      fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdxs[vi]! });
      if (vi > 0) fctx.body.push({ op: "i32.or" });
    }
    emittedTerm = true;
  }

  if (isArrIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "local.get", index: externTmp });
    fctx.body.push({ op: "call", funcIdx: isArrIdx });
    if (emittedTerm) fctx.body.push({ op: "i32.or" });
    emittedTerm = true;
  }

  if (!emittedTerm) {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
}

function reportUnsupportedStandaloneBuiltinValueRead(ctx: CodegenContext, builtinName: string, propName: string): void {
  if (!ctx.standaloneRefusedImports) ctx.standaloneRefusedImports = new Set<string>();
  const key = `#1907:${builtinName}.${propName}`;
  if (ctx.standaloneRefusedImports.has(key)) return;
  ctx.standaloneRefusedImports.add(key);
  reportErrorNoNode(
    ctx,
    `Codegen error: ${builtinName}.${propName} built-in static property value read is not supported ` +
      `in --target standalone (#1907 / #1888 S6-b). Add a native built-in method closure for this pair.`,
  );
}

export function makeBuiltinClosureFctx(
  name: string,
  selfType: ValType,
  paramTypes: ValType[],
  returnType: ValType | null,
): FunctionContext {
  const fctx: FunctionContext = {
    name,
    params: [{ name: "__self", type: selfType }, ...paramTypes.map((type, i) => ({ name: `arg${i}`, type }))],
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  for (let i = 0; i < fctx.params.length; i++) {
    fctx.localMap.set(fctx.params[i]!.name, i);
  }
  return fctx;
}

/**
 * (#2175 S1) Register a builtin's `$NativeProto` glue (so its proto object can
 * materialize and its members resolve to native-method closures) and return its
 * brand. Returns `undefined` for builtins not yet wired into the native-proto
 * core (caller falls through to the existing refusal). S1 wires RegExp only;
 * S3 adds %TypedArray% / the concrete views.
 */
export function tryEnsureNativeProtoBrand(ctx: CodegenContext, builtinName: string): number | undefined {
  if (builtinName === "RegExp") {
    return ensureRegExpNativeProtoGlue(ctx);
  }
  // (#2193) Array.prototype / Object.prototype value reads — register the
  // native-proto glue on demand so the read resolves to a `$NativeProto` object
  // host-free instead of refusing. The proto OBJECT only needs the member CSV +
  // name (emitLazyNativeProtoGet never calls emitMemberBody); reflective member
  // closures degrade to a catchable TypeError until their native bodies land.
  if (builtinName === "Array") {
    return ensureArrayNativeProtoGlue(ctx);
  }
  if (builtinName === "Object") {
    return ensureObjectNativeProtoGlue(ctx);
  }
  // (#1907 / #1888 S6-b — S4) String / Number / Boolean wrapper protos: register
  // the native-proto glue on demand so `String.prototype.<method>` (and Number/
  // Boolean) value reads resolve to a `$NativeProto` host-free instead of
  // refusing. Reflective member closures degrade to a catchable TypeError until
  // their native bodies land — the value-read object needs only the member set.
  if (builtinName === "String") {
    return ensureStringNativeProtoGlue(ctx);
  }
  if (builtinName === "Number") {
    return ensureNumberNativeProtoGlue(ctx);
  }
  if (builtinName === "Boolean") {
    return ensureBooleanNativeProtoGlue(ctx);
  }
  // (#1907 / #1888 S6-b — S5) Date.prototype value reads: register the
  // native-proto glue on demand so `Date.prototype.<method>` value reads (and
  // their `.length` meta folds) resolve to a `$NativeProto` host-free instead of
  // refusing. Date carries no vec/runtime brand entanglement (unlike the
  // TypedArray views, see #2375), so the proto-object materialization is clean.
  if (builtinName === "Date") {
    return ensureDateNativeProtoGlue(ctx);
  }
  // (#1907 / #1888 S6-b — S6) Error / Map / Set protos. These three carry no
  // runtime-state entanglement that breaks the `$NativeProto` value-read
  // materialization (measured: clean flips, 0 regressions). Promise's INSTANCE
  // -state read was the #1907 null-deref; #2861 re-admits ONLY its static
  // `.prototype` value read (pure value object, never touches async-capability
  // state) — see the Promise arm below.
  if (builtinName === "Error") {
    return ensureErrorNativeProtoGlue(ctx);
  }
  // (#2861) NativeError subclass protos — TypeError/RangeError/ReferenceError/
  // SyntaxError/EvalError/URIError. Each has its own reserved brand; the proto
  // value object shares Error.prototype's clean-flip shape (no runtime-state
  // entanglement), so wiring the glue flips the `<NativeError>.prototype[.member]`
  // value-read CE → host-free value object.
  if (
    builtinName === "TypeError" ||
    builtinName === "RangeError" ||
    builtinName === "ReferenceError" ||
    builtinName === "SyntaxError" ||
    builtinName === "EvalError" ||
    builtinName === "URIError"
  ) {
    return ensureNativeErrorNativeProtoGlue(ctx, builtinName);
  }
  // (#2861) Promise.prototype — wired for the STATIC `.prototype` value read +
  // method-closure value reads only (then/catch/finally). The #1907 null-deref
  // was an INSTANCE-state read; the pure value-read object never touches async
  // capability state. Re-validated against the Promise standalone suite (no
  // currently-passing test regresses).
  if (builtinName === "Promise") {
    return ensurePromiseNativeProtoGlue(ctx);
  }
  // (#2861) Iterator.prototype — ES2025 iterator-helper value reads.
  if (builtinName === "Iterator") {
    return ensureIteratorNativeProtoGlue(ctx);
  }
  if (builtinName === "Map") {
    return ensureMapNativeProtoGlue(ctx);
  }
  if (builtinName === "Set") {
    return ensureSetNativeProtoGlue(ctx);
  }
  // (S7 trap-probe) Function / Symbol / BigInt / WeakMap / WeakSet protos —
  // measuring flips + the trap/regression check before committing each.
  if (builtinName === "Function") {
    return ensureFunctionNativeProtoGlue(ctx);
  }
  if (builtinName === "Symbol") {
    return ensureSymbolNativeProtoGlue(ctx);
  }
  if (builtinName === "BigInt") {
    return ensureBigIntNativeProtoGlue(ctx);
  }
  if (builtinName === "WeakMap") {
    return ensureWeakMapNativeProtoGlue(ctx);
  }
  if (builtinName === "WeakSet") {
    return ensureWeakSetNativeProtoGlue(ctx);
  }
  // (#2861) ArrayBuffer / DataView protos — the single largest standalone-CE
  // builtin cluster (ArrayBuffer 166, DataView 89). Their proto value objects
  // carry no runtime-state entanglement (the byte vec lives on the INSTANCE,
  // never the proto), so the `$NativeProto` materialization is clean. The
  // accessor getters (`byteLength`/`buffer`/`byteOffset`/…) fold `.length` to 0.
  if (builtinName === "ArrayBuffer") {
    return ensureArrayBufferNativeProtoGlue(ctx);
  }
  if (builtinName === "DataView") {
    return ensureDataViewNativeProtoGlue(ctx);
  }
  // (#2861) SharedArrayBuffer mirrors ArrayBuffer's clean value-object shape;
  // WeakRef / FinalizationRegistry are plain-method protos (held value / cells
  // live on the instance, never the proto).
  if (builtinName === "SharedArrayBuffer") {
    return ensureSharedArrayBufferNativeProtoGlue(ctx);
  }
  if (builtinName === "WeakRef") {
    return ensureWeakRefNativeProtoGlue(ctx);
  }
  if (builtinName === "FinalizationRegistry") {
    return ensureFinalizationRegistryNativeProtoGlue(ctx);
  }
  // (#2861) DisposableStack / AsyncDisposableStack — TC39 Explicit Resource
  // Management. The resource list lives on the instance, so the proto value
  // object is pure (member CSV only).
  if (builtinName === "DisposableStack") {
    return ensureDisposableStackNativeProtoGlue(ctx);
  }
  if (builtinName === "AsyncDisposableStack") {
    return ensureAsyncDisposableStackNativeProtoGlue(ctx);
  }
  // (#2861) SuppressedError (ES2026 error aggregation) is an Error subclass —
  // its prototype's own method set mirrors Error's (`toString`), with
  // `constructor`/`name`/`message` data props handled by the shared meta-fold.
  // Reuse the NativeError glue (its own-brand slot 43).
  if (builtinName === "SuppressedError") {
    return ensureNativeErrorNativeProtoGlue(ctx, builtinName);
  }
  // (#2651 M1 / D2) Concrete TypedArray view protos — `Int8Array.prototype`,
  // `Uint8Array.prototype`, … This is the measured Slice-0 lever: the
  // `<View>.prototype` value read (the #1907 / #1888 S6-b `Int8Array.prototype`
  // 460+ residual) is what gates the bulk of the ctor-iteration harness rows
  // (`testTypedArray.js` builds `const TypedArray =
  // Object.getPrototypeOf(Int8Array.prototype).constructor`, then `verifyProperty(
  // TypedArray.prototype.<m>, …)`). Each view shares the `%TypedArray%.prototype`
  // member set; the proto OBJECT is a pure value object (member CSV only — never
  // re-emits a body that touches the view's vec/runtime state, per #2375).
  // Returns undefined for non-wired (bigint) views → existing refusal.
  {
    const taBrand = ensureTypedArrayViewNativeProtoGlue(ctx, builtinName);
    if (taBrand !== undefined) return taBrand;
  }
  // (#2901) The abstract `%TypedArray%` intrinsic proto — the receiver the
  // `testTypedArray.js` harness reaches via `Object.getPrototypeOf(Int8Array).prototype`.
  // Register the shared intrinsic glue so the #2885 gOPD synthesis + #2876 reflective
  // `.call` resolve its §23.2.3 accessor descriptors host-free.
  if (builtinName === "%TypedArray%") {
    return ensureTypedArrayIntrinsicNativeProtoGlue(ctx);
  }
  // Other builtins: only resolve if some path already registered glue for them.
  const brand = getBuiltinBrand(ctx, builtinName);
  if (brand === undefined) return undefined;
  return getNativeProtoBuiltinGlue(ctx, brand) ? brand : undefined;
}

/**
 * (#2175 S1) `<Builtin>.prototype.<member>` value read → a native-method/getter
 * closure value. Detects the two-level shape (inner is `<Builtin>.prototype`
 * where `<Builtin>` is an unshadowed registered-brand ctor identifier),
 * registers the brand glue, classifies the member as getter/method, and emits a
 * `ref.func` + `struct.new` closure value. Getters are returned as a closure
 * here too (the descriptor `.get` is the same value); calling them runs the
 * brand-recovery prologue on `this`.
 *
 * Returns `undefined` when the shape doesn't match (caller falls through), or
 * the closure value's ValType. Standalone-only.
 */
/**
 * (#2175 S1) `<Builtin>.prototype.<member>.length` / `.name` — fold the
 * native-method-closure value's arity / member name at compile time from the
 * brand glue. The member is statically known, so this is a constant emit (no
 * closure materialized). Returns `undefined` when the shape doesn't match.
 */
function tryCompileStandaloneBuiltinProtoMemberMeta(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | undefined {
  if (!ctx.standalone || ts.isPrivateIdentifier(expr.name)) return undefined;
  const metaProp = expr.name.text;
  if (metaProp !== "length" && metaProp !== "name") return undefined;
  const memberAccess = skipTransparentExpressions(expr.expression);
  if (!ts.isPropertyAccessExpression(memberAccess)) return undefined;
  const inner = skipTransparentExpressions(memberAccess.expression);
  // (#2896) `<Builtin>.<staticMethod>.length` / `.name` — fold the spec
  // metadata for direct reads of ANY standard builtin static method (the
  // BUILTIN_STATIC_METHOD_ARITY table; `.name` === the property key per
  // §10.2.9). No closure is materialized, so this also answers methods whose
  // VALUE-read is not yet wired host-free (`Number.isNaN.length` etc.).
  // Sibling of the `<Builtin>.prototype.<member>` fold below; the runtime
  // reflective reads for wired closures resolve through the #2896 meta
  // subtypes instead (same values — STANDALONE_STATIC_METHOD_META agrees with
  // this table).
  if (ts.isIdentifier(inner)) {
    const staticShadowed = fctx.localMap.has(inner.text) || (fctx.boxedCaptures?.has(inner.text) ?? false);
    const staticArity = BUILTIN_STATIC_METHOD_ARITY[inner.text]?.[memberAccess.name.text];
    if (!staticShadowed && staticArity !== undefined) {
      if (metaProp === "length") {
        fctx.body.push({ op: "f64.const", value: staticArity });
        return { kind: "f64" };
      }
      return compileStringLiteral(ctx, fctx, memberAccess.name.text) ?? undefined;
    }
  }
  if (!ts.isPropertyAccessExpression(inner)) return undefined;
  if (inner.name.text !== "prototype" || !ts.isIdentifier(inner.expression)) return undefined;
  const builtinName = inner.expression.text;
  if (!BUILTIN_CTOR_NAMES.has(builtinName)) return undefined;
  const isShadowed = fctx.localMap.has(builtinName) || (fctx.boxedCaptures?.has(builtinName) ?? false);
  if (isShadowed) return undefined;

  const brand = tryEnsureNativeProtoBrand(ctx, builtinName);
  if (brand === undefined) return undefined;
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return undefined;

  const member = memberAccess.name.text;
  // Only fold for members the glue actually advertises (so a typo / unknown
  // member still routes through the normal path rather than fabricating a 0).
  if (!glue.memberCsv.split(",").includes(member)) return undefined;

  if (metaProp === "length") {
    const arity = glue.memberKind(member) === "getter" ? 0 : glue.memberLength(member);
    fctx.body.push({ op: "f64.const", value: arity });
    return { kind: "f64" };
  }
  // `.name` — the member's own name (getters are spelled "get <member>" per
  // §10.2.9, but the test gate reads method names; emit the bare member name).
  return compileStringLiteral(ctx, fctx, member) ?? undefined;
}

function tryCompileStandaloneBuiltinProtoMemberRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | undefined {
  if (!ctx.standalone || ts.isPrivateIdentifier(expr.name)) return undefined;
  const inner = skipTransparentExpressions(expr.expression);
  if (!ts.isPropertyAccessExpression(inner)) return undefined;
  if (inner.name.text !== "prototype") return undefined;
  if (!ts.isIdentifier(inner.expression)) return undefined;
  const builtinName = inner.expression.text;
  if (!BUILTIN_CTOR_NAMES.has(builtinName)) return undefined;
  const isShadowed = fctx.localMap.has(builtinName) || (fctx.boxedCaptures?.has(builtinName) ?? false);
  if (isShadowed) return undefined;

  const brand = tryEnsureNativeProtoBrand(ctx, builtinName);
  if (brand === undefined) return undefined;

  const member = expr.name.text;
  // (#4200) `constructor` is an OWN data property of every builtin prototype,
  // but it is not a METHOD, so it is absent from the per-brand method CSVs and
  // fell to the unknown-member arm below → `undefined`. It cannot join those
  // CSVs (the shared consumer would mint a method closure for it); it resolves
  // instead to the identity-stable constructor carrier the bare `<Builtin>`
  // identifier reads, so `Error.prototype.constructor === Error` is genuinely
  // true. Same module backs the gOPD synthesis, so the descriptor's `.value`
  // and this read cannot drift. Declines (falls through) for builtins with no
  // carrier — see builtin-proto-constructor.ts.
  if (member === "constructor") {
    const ctorType = emitBuiltinProtoConstructorValue(ctx, fctx, builtinName);
    if (ctorType !== null) return ctorType;
    return undefined;
  }
  // (#2984 Phase 2) Own-CSV gate + Object.prototype inheritance + un-wired-
  // member refusal fallback — policy lives in native-proto-value-read.ts.
  const resolved = resolveStandaloneProtoMemberValueClosure(ctx, brand, builtinName, member);
  if (!resolved) return undefined;
  const { closure, kind } = resolved;

  if (kind === "getter") {
    // (#2885 Site 3) A plain read of `<Builtin>.prototype.<getter>` must INVOKE
    // the accessor on the receiver, not return the getter closure value. This
    // site only fires for the literal `<Builtin>.prototype.<getter>` shape, so
    // the receiver is always the proto object (`$NativeProto` externref): the
    // proto-identity arm in the getter body (Site 1) then yields `undefined`
    // (§22.2.6), e.g. `RegExp.prototype.global === undefined`. Instance reads
    // (`re.global`) route through `tryCompileStandaloneRegExpPropertyRead`, not
    // here. Returns externref (the unified getter result type).
    const closureInfo = ctx.closureInfoByTypeIdx.get(closure.type.typeIdx);
    if (!closureInfo) return undefined;

    // self struct (param 0) — unused by the body (no captures) but type-required.
    // (#2175 V2-S2) Use the identity-stable singleton so the getter function object
    // invoked here is the SAME object gOPD's `.get` synthesis returns (calls.ts
    // Site-2) — `gOPD(p,"flags").get === gOPD(p,"flags").get`. One value per
    // (brand, member), everywhere (C2).
    fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
    // `this` arg (param 1): the builtin proto object externref.
    if (!emitLazyNativeProtoGet(ctx, fctx, brand)) return undefined;
    // call_ref operand: the typed funcref. `ref.func` yields `(ref liftedType)`
    // directly (the func's declared type IS the lifted closure type), so no
    // struct.get / guard-cast is needed.
    fctx.body.push({ op: "ref.func", funcIdx: closure.funcIdx });
    fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
    return closureInfo.returnType ?? { kind: "externref" };
  }

  // (#2175 V2-S2) IDENTITY-STABLE method value: read via a module-level singleton
  // so `RegExp.prototype.exec === RegExp.prototype.exec` (a fresh `struct.new` per
  // read gave two distinct instances → `!==`). The value struct is the UNIQUE
  // per-(brand, member) meta subtype (`ensureBuiltinFnMetaType` cache key
  // `proto:<brand>:method:<member>`), so the singleton global keys on that distinct
  // typeIdx and `RegExp.prototype.exec !== RegExp.prototype.test` still holds. This
  // is the SAME singleton the #2885 gOPD synthesis (calls.ts Site-2) materializes,
  // so `gOPD(RegExp.prototype,"exec").value === RegExp.prototype.exec`.
  fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
  return closure.type;
}

/**
 * The result ValType of a builtin static that returns a JS **boolean**
 * (`Array.isArray`, `Object.is`, `Object.hasOwn`, `Reflect.has`, `Reflect.set`,
 * `Number.isNaN` & friends).
 *
 * The `boolean: true` brand is not decoration. An `i32` slot backs `number`,
 * `boolean` and symbol handles alike (#2785/#2795), and every place that lowers
 * a closure result across the externref ABI picks `__box_boolean` vs
 * `__box_number` from this brand — so an unbranded predicate reifies `false` as
 * the NUMBER `0`, and `Object.is(a, b) === false` is then false.
 *
 * It is also **load-bearing for other functions**, which is how the missing
 * brand stayed invisible: the funcref-wrapper registry keys one shared wrapper
 * per wasm signature (it must — WasmGC type identity is structural, so two
 * "different" `(externref, externref) -> i32` types are the SAME type at run
 * time and a `ref.test` ladder cannot tell them apart). Whoever registers that
 * signature FIRST fixes the brand for every closure that shares it. When
 * #4223's wrapper-constructor carriers began minting `Object.is`/`Object.hasOwn`
 * from inside `ensureObjectRuntime`, these unbranded statics started winning
 * that race — and every user boolean predicate reached through the inline
 * dynamic-call ladder began boxing as a number (test262's `isConfigurable()`
 * answering `0`, 105 standalone descriptor tests).
 */
const BOOLEAN_PREDICATE_RESULT: ValType = { kind: "i32", boolean: true };

export function ensureStandaloneBuiltinStaticMethodClosure(
  ctx: CodegenContext,
  builtinName: string,
  propName: string,
  _expr?: ts.PropertyAccessExpression,
): { type: { kind: "ref"; typeIdx: number }; funcIdx: number } | null {
  const key = `${builtinName}.${propName}`;
  let paramTypes: ValType[];
  let returnType: ValType | null;
  // (#2984 Phase 3) True for statics with no hand-written native body below:
  // they reify with a catchable-TypeError body instead of returning null.
  let genericThrowBody = false;

  switch (key) {
    case "Array.isArray":
      paramTypes = [{ kind: "externref" }];
      returnType = BOOLEAN_PREDICATE_RESULT;
      break;
    case "Object.assign":
      // Deno snapshots Object.assign into its primordials object, then invokes
      // that captured function while constructing `Deno.core`. Register the
      // native object runtime before minting the closure so every funcidx used
      // by the body is settled. The closure exposes the builtin's declared
      // two-argument shape; its second argument is packed into the same
      // `$ObjVec` consumed by the direct Object.assign lowering.
      ensureObjVecBuilders(ctx);
      paramTypes = [{ kind: "externref" }, { kind: "externref" }];
      returnType = { kind: "externref" };
      break;
    case "Object.keys":
      paramTypes = [{ kind: "externref" }];
      // Standalone Object.keys returns the object-runtime `$ObjVec` as an
      // externref; consumers read it back through native __extern_length /
      // __extern_get_idx. Preserve that contract for method values.
      returnType = { kind: "externref" };
      break;
    case "Object.getOwnPropertyNames":
      paramTypes = [{ kind: "externref" }];
      returnType = { kind: "externref" };
      break;
    case "Object.getOwnPropertyDescriptor":
      paramTypes = [{ kind: "externref" }, { kind: "externref" }];
      returnType = { kind: "externref" };
      break;
    case "Object.hasOwn":
      paramTypes = [{ kind: "externref" }, { kind: "externref" }];
      returnType = BOOLEAN_PREDICATE_RESULT;
      break;
    case "Object.defineProperty":
      ensureObjectRuntime(ctx);
      paramTypes = [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }];
      returnType = { kind: "externref" };
      break;
    case "Object.setPrototypeOf":
      ensureObjectRuntime(ctx);
      paramTypes = [{ kind: "externref" }, { kind: "externref" }];
      returnType = { kind: "externref" };
      break;
    case "Object.freeze":
    case "Object.seal":
    case "Object.preventExtensions":
      ensureObjectRuntime(ctx);
      paramTypes = [{ kind: "externref" }];
      returnType = { kind: "externref" };
      break;
    // (#2933) Namespace static-method VALUE reads for the fixed-arity `Reflect.*`
    // methods that the standalone CALL path already backs with a simple
    // externref/i32 native (calls.ts §"Reflect API"). The value closure calls
    // the SAME native, so `const f: any = Reflect.get; f(o, "k")` is
    // observationally identical to `Reflect.get(o, "k")`. The variadic
    // (`Math.max`) and native-`$AnyValue`-return (`JSON.stringify`, `JSON.parse`)
    // methods stay refused — they need variadic / anyref-boundary closure work
    // (see the issue's remaining scope). `Reflect.get`/`set` fix the arity at 2/3
    // (no explicit-receiver slot), matching the call path which refuses the
    // receiver form under standalone (#2046).
    case "Reflect.get":
      paramTypes = [{ kind: "externref" }, { kind: "externref" }];
      returnType = { kind: "externref" };
      break;
    case "Reflect.has":
      paramTypes = [{ kind: "externref" }, { kind: "externref" }];
      returnType = BOOLEAN_PREDICATE_RESULT;
      break;
    case "Reflect.set":
      paramTypes = [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }];
      returnType = BOOLEAN_PREDICATE_RESULT;
      break;
    case "Reflect.ownKeys":
      paramTypes = [{ kind: "externref" }];
      returnType = { kind: "externref" };
      break;
    case "Reflect.getOwnPropertyDescriptor":
      paramTypes = [{ kind: "externref" }, { kind: "externref" }];
      returnType = { kind: "externref" };
      break;
    case "Reflect.defineProperty":
      paramTypes = [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }];
      returnType = BOOLEAN_PREDICATE_RESULT;
      break;
    // (#2933) JSON.stringify as a VALUE — fixed 1-arg compact form. Serialises
    // host-free via the native `__json_stringify_root` (the SAME entry the
    // direct `JSON.stringify(o)` call uses); returns the JSON `$AnyString`
    // coerced to an externref at the any-call boundary. Replacer/space args are
    // out of scope (matching the standalone call-path narrowing).
    case "JSON.stringify":
      paramTypes = [{ kind: "externref" }];
      returnType = { kind: "externref" };
      break;
    // (#2933) Math.max / Math.min as VALUES — genuinely VARIADIC. Reified with
    // the canonical variadic closure convention: ONE `(ref null $vec_externref)`
    // args param carrying every call-site argument (packed by the variadic
    // dispatch arm in call-identifier.ts), so a single closure serves every
    // call-site arity — `g()`, `g(a)`, `g(a,b,c,…)`. The body folds the vec
    // with `f64.max`/`f64.min`, whose Wasm semantics are exactly §21.3.2.24/.25
    // (NaN propagates; max(+0,-0)=+0 / min(+0,-0)=-0), seeded with ±Infinity.
    // Result is boxed via the engine's `__any_box_f64` (→ externref). Falls
    // through to the Phase-3 generic throw body when the any-value substrate
    // (native box types / $AnyValue helpers) is unavailable.
    case "Math.max":
    case "Math.min": {
      // Pre-register EVERYTHING the body + call-site arm need, BEFORE the
      // wrapper/func creation (first-registration-mid-body desyncs codegen —
      // #2704). `addUnionImports` registers the native `$BoxedNumber`/
      // `$BoxedBoolean` substrate (`nativeBoxNumberTypeIdx`) that
      // `ensureAnyFromExternHelper` requires — in standalone these are DEFINED
      // funcs (no import, no index shift). If the substrate is still
      // unavailable, degrade to the generic catchable-TypeError body
      // (identity/meta still work).
      addUnionImports(ctx);
      const fromExternIdx = ensureAnyFromExternHelper(ctx);
      if (fromExternIdx === undefined) {
        const genericArity = BUILTIN_STATIC_METHOD_ARITY[builtinName]?.[propName];
        if (genericArity === undefined) return null;
        paramTypes = [];
        for (let i = 0; i < genericArity; i++) paramTypes.push({ kind: "externref" });
        returnType = { kind: "externref" };
        genericThrowBody = true;
        break;
      }
      ensureAnyHelpers(ctx); // __any_to_f64 / __any_box_f64
      const { vecTypeIdx } = ensureExtrasArgvGlobal(ctx);
      paramTypes = [{ kind: "ref_null", typeIdx: vecTypeIdx }];
      returnType = { kind: "externref" };
      break;
    }
    // (#2963 Tier 2a) `Number.is{Integer,Finite,NaN,SafeInteger}` as first-class
    // VALUES. Fixed 1-arg predicates: the reified closure takes the boxed arg as
    // externref (the all-externref convention — coercion moves INSIDE the body)
    // and returns i32 (0/1), exactly like the `Array.isArray` value closure. The
    // body applies the `__typeof_number` guard (NO ToNumber — a non-Number arg is
    // `false` per §21.1.2.x, and the settled guard already excludes the #2979
    // UNDEF_F64-sentinel `$BoxedNumber` that carries `undefined`), then
    // `__unbox_number` → the SHARED `numberIsPredicateOps` f64 test (the SAME ops
    // the direct `Number.is*(n)` call emits → observational identity). Both
    // natives are standalone-DEFINED funcs (host-free) registered by
    // `addUnionImports`; if the substrate is unavailable, degrade to the generic
    // catchable-TypeError body (identity/meta still hold).
    case "Number.isInteger":
    case "Number.isFinite":
    case "Number.isNaN":
    case "Number.isSafeInteger": {
      addUnionImports(ctx);
      const typeofNumIdx = ctx.funcMap.get("__typeof_number");
      const unboxNumIdx = ctx.funcMap.get("__unbox_number");
      if (typeofNumIdx === undefined || unboxNumIdx === undefined) {
        const genericArity = BUILTIN_STATIC_METHOD_ARITY[builtinName]?.[propName];
        if (genericArity === undefined) return null;
        paramTypes = [];
        for (let i = 0; i < genericArity; i++) paramTypes.push({ kind: "externref" });
        returnType = { kind: "externref" };
        genericThrowBody = true;
        break;
      }
      paramTypes = [{ kind: "externref" }];
      returnType = BOOLEAN_PREDICATE_RESULT;
      break;
    }
    // (#2963 Tier 2b) `Object.is(x, y)` as a first-class VALUE — SameValue
    // (§20.1.2.13), NOT `===`. Fixed 2-arg `[externref, externref] -> i32`. The
    // direct standalone `Object.is` call only backs COMPILE-TIME same-typed
    // scalar args (the general boxed `__object_is` is a host import); a reified
    // value gets two boxed `any` args, so the body composes host-free: if BOTH
    // boxes are Numbers (`__typeof_number`), run the shared `sameValueNumberOps`
    // (bit-compare + both-NaN — the ONLY place SameValue diverges from `===`:
    // `+0`/`-0` unequal, `NaN`/`NaN` equal); otherwise SameValue reduces to `===`
    // for every non-Number case, so reuse `__extern_strict_eq` (object identity
    // via `ref.eq`, string content, null/undefined/boolean by value). Degrade to
    // the generic catchable-TypeError body if any native is unavailable.
    case "Object.is": {
      addUnionImports(ctx);
      const typeofNumIdx = ctx.funcMap.get("__typeof_number");
      const unboxNumIdx = ctx.funcMap.get("__unbox_number");
      const strictEqIdx = ensureExternStrictEqHelper(ctx);
      if (typeofNumIdx === undefined || unboxNumIdx === undefined || strictEqIdx === undefined) {
        const genericArity = BUILTIN_STATIC_METHOD_ARITY[builtinName]?.[propName];
        if (genericArity === undefined) return null;
        paramTypes = [];
        for (let i = 0; i < genericArity; i++) paramTypes.push({ kind: "externref" });
        returnType = { kind: "externref" };
        genericThrowBody = true;
        break;
      }
      paramTypes = [{ kind: "externref" }, { kind: "externref" }];
      returnType = BOOLEAN_PREDICATE_RESULT;
      break;
    }
    default: {
      // (#2984 Phase 3) Any OTHER standard builtin static method — the
      // `BUILTIN_STATIC_METHOD_ARITY` membership is the complete own
      // function-valued static surface of the global ctors/namespaces —
      // reifies as an identity-stable first-class closure whose BODY throws a
      // catchable TypeError (the #2193/#2651/#2984-Phase-2 degrade-to-
      // catchable pattern). The VALUE is spec-shaped: per-(builtin, method)
      // meta subtype (`.name`/`.length` reflective reads) + module singleton,
      // so `Object.getOwnPropertyDescriptor(Math, "atan2").value ===
      // Math.atan2` and `Math.atan2 === Math.atan2` hold; only INVOKING the
      // extracted value throws. Direct calls (`Math.atan2(y, x)`) never route
      // here — they keep their dedicated call lowerings. Every shape reaching
      // this branch was a hard refusal-CE before (#1907 static-value-read),
      // so no currently-passing program changes.
      const genericArity = BUILTIN_STATIC_METHOD_ARITY[builtinName]?.[propName];
      if (genericArity === undefined) return null;
      paramTypes = [];
      for (let i = 0; i < genericArity; i++) paramTypes.push({ kind: "externref" });
      returnType = { kind: "externref" };
      genericThrowBody = true;
      break;
    }
  }

  const resultTypes = returnType ? [returnType] : [];
  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, paramTypes, resultTypes);
  if (!wrapperTypes) return null;

  const funcName = `__builtin_static_${builtinName}_${propName}`;
  let funcIdx = ctx.funcMap.get(funcName);
  if (funcIdx === undefined) {
    const selfType: ValType = { kind: "ref", typeIdx: wrapperTypes.liftedSelfTypeIdx };
    const closureFctx = makeBuiltinClosureFctx(funcName, selfType, paramTypes, returnType);

    if (key === "Array.isArray") {
      closureFctx.body.push({ op: "local.get", index: 1 });
      emitArrayIsArrayExternrefPredicate(ctx, closureFctx);
    } else if (key === "Object.assign") {
      const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
      const assignIdx = ctx.funcMap.get("__object_assign");
      if (assignIdx === undefined) return null;
      const sourcesLocal = allocLocal(closureFctx, "assign_sources", { kind: "externref" });
      closureFctx.body.push(
        { op: "call", funcIdx: newIdx },
        { op: "local.set", index: sourcesLocal },
        { op: "local.get", index: sourcesLocal },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: pushIdx },
        { op: "local.get", index: 1 },
        { op: "local.get", index: sourcesLocal },
        { op: "call", funcIdx: assignIdx },
      );
    } else if (key === "Object.keys") {
      const keysIdx = ensureLateImport(ctx, "__object_keys", [{ kind: "externref" }], [{ kind: "externref" }]);
      if (keysIdx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 });
      closureFctx.body.push({ op: "call", funcIdx: keysIdx });
      if (returnType && !valTypesMatch({ kind: "externref" }, returnType)) {
        coerceType(ctx, closureFctx, { kind: "externref" }, returnType);
      }
    } else if (key === "Object.getOwnPropertyNames") {
      const namesIdx = ensureLateImport(ctx, "__getOwnPropertyNames", [{ kind: "externref" }], [{ kind: "externref" }]);
      if (namesIdx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 });
      closureFctx.body.push({ op: "call", funcIdx: namesIdx });
    } else if (key === "Object.getOwnPropertyDescriptor") {
      const gopdIdx = ensureLateImport(
        ctx,
        "__getOwnPropertyDescriptor",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      if (gopdIdx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 });
      closureFctx.body.push({ op: "local.get", index: 2 });
      closureFctx.body.push({ op: "call", funcIdx: gopdIdx });
    } else if (key === "Object.hasOwn") {
      const hasOwnIdx = ensureLateImport(
        ctx,
        "__object_hasOwn",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      if (hasOwnIdx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 });
      closureFctx.body.push({ op: "local.get", index: 2 });
      closureFctx.body.push({ op: "call", funcIdx: hasOwnIdx });
    } else if (key === "Object.defineProperty") {
      const defineIdx = ctx.funcMap.get("__obj_define_from_desc");
      if (defineIdx === undefined) return null;
      closureFctx.body.push(
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 3 },
        { op: "call", funcIdx: defineIdx },
      );
    } else if (key === "Object.setPrototypeOf") {
      const setPrototypeIdx = ctx.funcMap.get("__object_setPrototypeOf");
      if (setPrototypeIdx === undefined) return null;
      closureFctx.body.push(
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: setPrototypeIdx },
      );
    } else if (key === "Object.freeze" || key === "Object.seal" || key === "Object.preventExtensions") {
      const helperName =
        key === "Object.freeze"
          ? "__object_freeze"
          : key === "Object.seal"
            ? "__object_seal"
            : "__object_preventExtensions";
      const integrityIdx = ctx.funcMap.get(helperName);
      if (integrityIdx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: integrityIdx });
    } else if (key === "Reflect.get") {
      // (#2933) Same native the 2-arg standalone `Reflect.get(target, key)` call
      // path uses (calls.ts). The value closure is fixed 2-arg — the optional
      // receiver form is unsupported in standalone (#2046), consistent there.
      const idx = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      if (idx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 });
      closureFctx.body.push({ op: "local.get", index: 2 });
      closureFctx.body.push({ op: "call", funcIdx: idx });
    } else if (key === "Reflect.has") {
      const idx = ensureLateImport(
        ctx,
        "__extern_has",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      if (idx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 });
      closureFctx.body.push({ op: "local.get", index: 2 });
      closureFctx.body.push({ op: "call", funcIdx: idx });
    } else if (key === "Reflect.set") {
      const idx = ensureLateImport(
        ctx,
        "__reflect_set",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      if (idx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 });
      closureFctx.body.push({ op: "local.get", index: 2 });
      closureFctx.body.push({ op: "local.get", index: 3 });
      closureFctx.body.push({ op: "call", funcIdx: idx });
    } else if (key === "Reflect.ownKeys") {
      // Reflect.ownKeys includes non-enumerable own properties. The native
      // runtime does not yet retain symbol-keyed properties, so its strongest
      // available approximation is __getOwnPropertyNames, not __object_keys
      // (which deliberately implements Object.keys' enumerable-only view).
      // This distinction is observable for builtin namespace carriers: Deno's
      // primordials bootstrap discovers JSON.parse/stringify through this
      // extracted function value.
      const idx = ensureLateImport(ctx, "__getOwnPropertyNames", [{ kind: "externref" }], [{ kind: "externref" }]);
      if (idx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 });
      closureFctx.body.push({ op: "call", funcIdx: idx });
    } else if (key === "Reflect.getOwnPropertyDescriptor") {
      // The first-class Reflect method must share the direct call path's
      // native descriptor provider. Deno snapshots this method through object
      // destructuring before using it to copy every primordial descriptor.
      const runtime = ensureObjectRuntime(ctx);
      const beforeThrow = closureFctx.body.length;
      emitThrowTypeError(ctx, closureFctx, "Reflect.getOwnPropertyDescriptor called on non-object");
      const throwInstrs = closureFctx.body.splice(beforeThrow);
      closureFctx.body.push(
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: runtime.objectTypeIdx },
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: runtime.proxyTypeIdx },
        { op: "i32.or" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: throwInstrs },
      );
      const idx = ensureLateImport(
        ctx,
        "__getOwnPropertyDescriptor",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      if (idx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 }, { op: "local.get", index: 2 }, { op: "call", funcIdx: idx });
    } else if (key === "Reflect.defineProperty") {
      // Deno snapshots Reflect.defineProperty and invokes it with descriptor
      // objects returned by Reflect.getOwnPropertyDescriptor. Route that
      // first-class call through the same native dynamic-descriptor applier as
      // the direct syntax and surface its boolean [[DefineOwnProperty]] result.
      const runtime = ensureObjectRuntime(ctx);
      const beforeThrow = closureFctx.body.length;
      emitThrowTypeError(ctx, closureFctx, "Reflect.defineProperty called on non-object");
      const throwInstrs = closureFctx.body.splice(beforeThrow);
      closureFctx.body.push(
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: runtime.objectTypeIdx },
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: runtime.proxyTypeIdx },
        { op: "i32.or" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: throwInstrs },
      );
      const defineIdx = ctx.funcMap.get("__obj_define_from_desc");
      const truthyIdx = ctx.funcMap.get("__is_truthy");
      if (defineIdx === undefined || truthyIdx === undefined) return null;
      closureFctx.body.push(
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 3 },
        { op: "call", funcIdx: defineIdx },
        { op: "call", funcIdx: truthyIdx },
      );
    } else if (key === "JSON.stringify") {
      // Ensure the native codec (`__json_stringify_value` + its 1-arg entry
      // `__json_stringify_root`, `anyref -> ref $AnyString`) is registered; the
      // helper is idempotent. The value arg reaches the closure as an externref
      // (any-boundary); recover the internal ref (`any.convert_extern`), call
      // root, then box the `$AnyString` result back to externref for the
      // fixed-arity value-closure return — same coercion the call path applies.
      // OBSERVATIONALLY IDENTICAL to the direct `JSON.stringify(anyVar)` path:
      // objects/numbers/strings serialise correctly; an array reaching this via
      // `any`-boxing inherits the SAME pre-existing substrate limitation the
      // direct any-path has (top-level any-boxed array → "null"), so the closure
      // introduces no new divergence — it is not a fresh correctness landmine.
      emitJsonStringifyValue(ctx);
      const rootIdx = ctx.funcMap.get("__json_stringify_root");
      if (rootIdx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 });
      closureFctx.body.push({ op: "any.convert_extern" });
      closureFctx.body.push({ op: "call", funcIdx: rootIdx });
      closureFctx.body.push({ op: "extern.convert_any" });
    } else if ((key === "Math.max" || key === "Math.min") && !genericThrowBody) {
      // (#2933) Variadic fold body. Params: 0=self, 1=argsVec
      // (ref null $vec_externref: field0 = i32 len, field1 = externref array).
      // acc seeds -Infinity (max) / +Infinity (min); every element runs the
      // engine ToNumber pipeline (`__any_from_extern` → `__any_to_f64` —
      // no hand-rolled coercion matrix), then folds with `f64.max`/`f64.min`
      // (spec-exact: NaN propagation, signed-zero ordering). Result boxed via
      // `__any_box_f64` → externref.
      const { vecTypeIdx } = ensureExtrasArgvGlobal(ctx);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const fromExternIdx = ctx.funcMap.get("__any_from_extern");
      const toF64Idx = ctx.funcMap.get("__any_to_f64");
      // Result boxing: the native `$BoxedNumber` carrier (`__box_number`,
      // f64 → externref) — the SAME box every dynamic-dispatch return arm uses,
      // so call-site unboxing (`__unbox_number`), `__any_from_extern` (tag-3)
      // and `__any_strict_eq` (NaN ≠ NaN, #3174) all recover it correctly. An
      // `__any_box_f64` $AnyValue box here would read back NaN through
      // `__unbox_number`.
      const boxNumIdx = ctx.funcMap.get("__box_number");
      if (fromExternIdx === undefined || toF64Idx === undefined || boxNumIdx === undefined) return null;
      const foldOp = key === "Math.max" ? ("f64.max" as const) : ("f64.min" as const);
      const seed = key === "Math.max" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      const iLocal = allocLocal(closureFctx, "i", { kind: "i32" });
      const nLocal = allocLocal(closureFctx, "n", { kind: "i32" });
      const accLocal = allocLocal(closureFctx, "acc", { kind: "f64" });
      const arrLocal = allocLocal(closureFctx, "arr", { kind: "ref_null", typeIdx: arrTypeIdx });
      closureFctx.body.push(
        { op: "f64.const", value: seed },
        { op: "local.set", index: accLocal },
        // argsVec null → empty fold (Math.max() = -Infinity / Math.min() = +Infinity)
        { op: "local.get", index: 1 },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
            { op: "local.set", index: nLocal },
            { op: "local.get", index: 1 },
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
            { op: "local.set", index: arrLocal },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: iLocal },
                    { op: "local.get", index: nLocal },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: accLocal },
                    { op: "local.get", index: arrLocal },
                    { op: "ref.as_non_null" },
                    { op: "local.get", index: iLocal },
                    { op: "array.get", typeIdx: arrTypeIdx },
                    { op: "call", funcIdx: fromExternIdx },
                    { op: "call", funcIdx: toF64Idx },
                    { op: foldOp },
                    { op: "local.set", index: accLocal },
                    { op: "local.get", index: iLocal },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: iLocal },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
          ],
        },
        { op: "local.get", index: accLocal },
        { op: "call", funcIdx: boxNumIdx },
      );
    } else if (
      (key === "Number.isInteger" ||
        key === "Number.isFinite" ||
        key === "Number.isNaN" ||
        key === "Number.isSafeInteger") &&
      !genericThrowBody
    ) {
      // (#2963 Tier 2a) Predicate body. Params: 0=self, 1=arg (boxed externref).
      // `__typeof_number` answers "is this box a Number?" (excludes null /
      // undefined / the UNDEF_F64-sentinel box / non-number tags) WITHOUT
      // coercing — a non-Number arg yields `false` per §21.1.2.x. On a hit,
      // `__unbox_number` recovers the f64 and the shared `numberIsPredicateOps`
      // runs the exact test the direct call emits.
      const typeofNumIdx = ctx.funcMap.get("__typeof_number");
      const unboxNumIdx = ctx.funcMap.get("__unbox_number");
      if (typeofNumIdx === undefined || unboxNumIdx === undefined) return null;
      const valTmp = allocLocal(closureFctx, "np_val", { kind: "f64" });
      closureFctx.body.push(
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: typeofNumIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: unboxNumIdx },
            { op: "local.set", index: valTmp },
            ...numberIsPredicateOps(propName, valTmp),
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      );
    } else if (key === "Object.is" && !genericThrowBody) {
      // (#2963 Tier 2b) Body. Params: 0=self, 1=x, 2=y (both boxed externref).
      const typeofNumIdx = ctx.funcMap.get("__typeof_number");
      const unboxNumIdx = ctx.funcMap.get("__unbox_number");
      const strictEqIdx = ctx.funcMap.get("__extern_strict_eq");
      if (typeofNumIdx === undefined || unboxNumIdx === undefined || strictEqIdx === undefined) return null;
      const nx = allocLocal(closureFctx, "sv_nx", { kind: "f64" });
      const ny = allocLocal(closureFctx, "sv_ny", { kind: "f64" });
      closureFctx.body.push(
        // both boxes Numbers?  __typeof_number(x) & __typeof_number(y)
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: typeofNumIdx },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: typeofNumIdx },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            // SameValue over two Numbers (the only §20.1.2.13 arm that ≠ ===).
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: unboxNumIdx },
            { op: "local.set", index: nx },
            { op: "local.get", index: 2 },
            { op: "call", funcIdx: unboxNumIdx },
            { op: "local.set", index: ny },
            ...sameValueNumberOps(nx, ny),
          ],
          else: [
            // Every non-Number SameValue case coincides with `===`.
            { op: "local.get", index: 1 },
            { op: "local.get", index: 2 },
            { op: "call", funcIdx: strictEqIdx },
          ],
        },
      );
    } else if (genericThrowBody && builtinName === "Math" && emitMathValueReadBody(ctx, closureFctx, propName)) {
      // (#4565; supersedes the #4491 wave-4 lane G arm, same defect) — the
      // upstream module mints the `Math_<fn>` kernel late itself, so it needs
      // no collector-phase seeding. Kept BEFORE the `genericThrowBody` arm
      // below because that arm claims every `default:` case.
    } else if (genericThrowBody) {
      // (#2984 Phase 3) Degrade-to-catchable body: a real TypeError instance +
      // `throw` — the EXACT helper the Phase-2 proto refusal bodies use,
      // proven catchable through the closure-call path. The body ends in
      // `throw`, so it validates against the declared externref result
      // (unreachable tail).
      emitThrowTypeError(ctx, closureFctx, `${key} is not yet implemented in --target standalone`);
    }

    funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: funcName,
      typeIdx: wrapperTypes.liftedFuncTypeIdx,
      locals: closureFctx.locals,
      body: closureFctx.body,
      exported: false,
    });
    ctx.funcMap.set(funcName, funcIdx);
  }

  // (#2933) Publish the variadic calling convention so any-callee call sites
  // (call-identifier.ts) emit the variadic dispatch arm. Both Math.max and
  // Math.min share the SAME lifted func type (one vec param → one `ref.test`
  // arm serves both; `call_ref` dispatches to the right body via the funcref
  // value). Idempotent — the wrapper types are cached per signature.
  if ((key === "Math.max" || key === "Math.min") && !genericThrowBody) {
    const { vecTypeIdx } = ensureExtrasArgvGlobal(ctx);
    ctx.variadicBuiltinClosure = {
      funcTypeIdx: wrapperTypes.liftedFuncTypeIdx,
      structTypeIdx: wrapperTypes.structTypeIdx,
      vecTypeIdx,
      arrTypeIdx: getArrTypeIdxFromVec(ctx, vecTypeIdx),
    };
  }

  // (#2896) The value struct is the UNIQUE per-(builtin, method) metadata
  // subtype of the signature wrapper, so the reflective runtime natives can
  // `ref.test` it and answer its spec `name`/`length` own properties. All call
  // paths are unaffected (subtype of the wrapper the lifted func expects).
  // (#2984 Phase 3) Generic statics derive their spec meta from the arity
  // table (`.name` === the property key per §10.2.9); the hand-written table
  // stays first so wired closures keep their exact meta (byte-identical).
  const genericMetaArity = BUILTIN_STATIC_METHOD_ARITY[builtinName]?.[propName];
  const meta =
    STANDALONE_STATIC_METHOD_META[key] ??
    (genericMetaArity !== undefined ? { name: propName, length: genericMetaArity } : undefined);
  if (meta) {
    const metaTypeIdx = ensureBuiltinFnMetaType(
      ctx,
      wrapperTypes.structTypeIdx,
      wrapperTypes.closureInfo,
      `static:${key}`,
      meta.name,
      meta.length,
    );
    return { type: { kind: "ref", typeIdx: metaTypeIdx }, funcIdx };
  }

  return { type: { kind: "ref", typeIdx: wrapperTypes.structTypeIdx }, funcIdx };
}

// (#3267) Re-exported for property-access.ts internal call sites. These were
// module-private in property-access.ts; the move makes them cross-module, so
// they are exported here (no behaviour change — export visibility only).
export {
  getWellKnownSymbolId,
  tryEmitBuiltinNamespaceConstantValue,
  typedArrayViewSignedness,
  hasNativeBuiltinConstantHandler,
  reportUnsupportedStandaloneBuiltinValueRead,
  tryCompileStandaloneBuiltinProtoMemberMeta,
  tryCompileStandaloneBuiltinProtoMemberRead,
};
