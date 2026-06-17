// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Property access and element access codegen.
 *
 * Extracted from expressions.ts to keep concerns separated.
 * Contains: compilePropertyAccess, compileElementAccess, null-guard helpers,
 * bounds-checked array access, and related utilities.
 */

import { ts } from "../ts-api.js";
import {
  isExternalDeclaredClass,
  isIteratorResultType,
  isNullablePrimitiveType,
  isStringType,
} from "../checker/type-mapper.js";
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import { emitBoundsCheckedArrayGet } from "./array-methods.js";
import { classMemberFuncKey } from "./class-member-keys.js"; // (#1983) collision-free class-member funcMap keys
import { popBody } from "./context/bodies.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitCachedMethodClosureAccess, emitFuncRefAsClosure, getOrCreateFuncRefWrapperTypes } from "./closures.js";
import { emitLazyClassObjectGet, emitLazyProtoGet, findExternInfoForMember } from "./expressions/extern.js";
import {
  classifyPrivateMember,
  emitPrivateBrandPredicate,
  emitThrowTypeError,
  noJsHost,
  resolveDeclaringClassForPrivateName,
} from "./expressions/helpers.js";
import { emitUndefined, patchStructNewForAddedField } from "./expressions/late-imports.js";
import { emitSymbolDescLoad } from "./symbol-native.js";
import { addUnionImports, resolveWasmType } from "./index.js";
import { tryCompileNativeGeneratorResultProperty } from "./generators-native.js";
import { tryCompileNativeMapSizeGet } from "./map-runtime.js";
import { tryCompileNativeSetSizeGet } from "./set-runtime.js";
import { tryEmitLinearU8ElementGet, tryEmitLinearU8Length } from "./linear-uint8-codegen.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import {
  ensureRegExpNativeProtoGlue,
  tryCompileStandaloneRegExpMatchResultRead,
  tryCompileStandaloneRegExpPropertyRead,
} from "./regexp-standalone.js";
import {
  emitLazyNativeProtoGet,
  ensureStandaloneNativeMethodClosure,
  getBuiltinBrand,
  getNativeProtoBuiltinGlue,
} from "./native-proto.js";
import { isBuiltinSubtype, isBuiltinTypeName } from "./builtin-tags.js";
import { getOrRegisterErrorStructType, isWasiErrorName } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag, localGlobalIdx } from "./registry/imports.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStringLiteral,
  compileSuperElementAccess,
  compileSuperPropertyAccess,
  ensureLateImport,
  flushLateImportShifts,
  getCol,
  getLine,
  resolveComputedKeyExpression,
  resolveThisStructName,
  skipTransparentExpressions,
  valTypesMatch,
} from "./shared.js";
import { coercionInstrs, defaultValueInstrs } from "./type-coercion.js";
import { tryEmitJsonParseElementAccess, tryEmitJsonParsePropertyAccess } from "./json-standalone.js";
import { reserveAccessorGetDriver } from "./accessor-driver.js";
import { S5C_STRUCT_ACCESSOR_CLOSURE } from "./struct-accessor-closure.js";
import { tryCompileTemporalPropertyAccess } from "./temporal-native.js";

const BUILTIN_CTOR_NAMES = new Set([
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
};

/**
 * #2020: resolve an inherited static-property global by walking the class
 * parent chain (classParentMap), retrying `<Ancestor>_<prop>` at each level.
 * Static fields, like static methods, are inherited: `class B extends A {}`
 * sees `A`'s static fields through `B`. Returns the owning ancestor's global
 * index, or undefined when no ancestor declares the property. Callers run the
 * own-class lookup first, so own statics correctly shadow inherited ones.
 */
export function resolveInheritedStaticProp(
  ctx: CodegenContext,
  className: string,
  propName: string,
): number | undefined {
  const seen = new Set<string>([className]);
  let cls: string | undefined = ctx.classParentMap.get(className);
  while (cls && !seen.has(cls)) {
    seen.add(cls);
    const globalIdx = ctx.staticProps.get(`${cls}_${propName}`);
    if (globalIdx !== undefined) return globalIdx;
    cls = ctx.classParentMap.get(cls);
  }
  return undefined;
}

/**
 * ES spec IsAnonymousFunctionDefinition: returns true when the expression is
 * an anonymous FunctionExpression / ArrowFunction / ClassExpression (with
 * optional parentheses around it). Used by NamedEvaluation to decide whether
 * a binding name is assigned to the function's .name. (#1049)
 */
function isAnonymousFunctionDefinition(expr: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isFunctionExpression(expr) && !expr.name) return true;
  if (ts.isArrowFunction(expr)) return true;
  if (ts.isClassExpression(expr) && !expr.name) return true;
  return false;
}
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
  if (builtinName === "Math") return MATH_CONSTANT_PROPS.has(propName);
  if (builtinName === "Number") return NUMBER_CONSTANT_PROPS.has(propName);
  return false;
}

const DESCRIPTOR_FLAG_ACCESSOR = 1 << 4;

function runtimeAccessorDescriptorKey(
  ctx: CodegenContext,
  receiver: ts.Expression,
  propName: string,
): string | undefined {
  if (!ts.isIdentifier(receiver)) return undefined;
  const key = `${receiver.text}:${propName}`;
  const flags = ctx.definedPropertyFlags.get(key);
  if (flags === undefined || (flags & DESCRIPTOR_FLAG_ACCESSOR) === 0) return undefined;
  return ctx.sidecarDefinedPropertyKeys.has(key) ? key : undefined;
}

function emitRuntimeDescriptorGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  propName: string,
  accessNode: ts.Expression,
): ValType | null {
  const accessType = ctx.checker.getTypeAtLocation(accessNode);
  const accessWasm = resolveWasmType(ctx, accessType);
  const resultType: ValType =
    accessWasm.kind === "f64" || accessWasm.kind === "i32" ? accessWasm : { kind: "externref" };
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  let unboxIdx: number | undefined;
  if (resultType.kind === "f64" || resultType.kind === "i32") {
    unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  }
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined) return null;

  const recvType = compileExpression(ctx, fctx, receiver);
  if (!recvType) return null;
  if (recvType.kind === "ref_null") {
    if (!isProvablyNonNull(receiver, ctx.checker)) {
      emitNullCheckThrow(ctx, fctx, recvType, accessNode);
    }
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  } else if (recvType.kind === "ref") {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  } else if (recvType.kind !== "externref") {
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  }

  addStringConstantGlobal(ctx, propName);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
  fctx.body.push({ op: "call", funcIdx: getIdx });
  if (resultType.kind === "f64" && unboxIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: unboxIdx });
  } else if (resultType.kind === "i32" && unboxIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: unboxIdx });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  }
  return resultType;
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
    fctx.body.push({ op: "local.get", index: externTmp } as Instr);
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "local.set", index: anyTmp });
    for (let vi = 0; vi < vecTypeIdxs.length; vi++) {
      fctx.body.push({ op: "local.get", index: anyTmp } as Instr);
      fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdxs[vi]! } as Instr);
      if (vi > 0) fctx.body.push({ op: "i32.or" } as Instr);
    }
    emittedTerm = true;
  }

  if (isArrIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "local.get", index: externTmp } as Instr);
    fctx.body.push({ op: "call", funcIdx: isArrIdx });
    if (emittedTerm) fctx.body.push({ op: "i32.or" } as Instr);
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

function makeBuiltinClosureFctx(
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
 * (#2175 S0) Generalized native-method-closure factory. `kind`:
 *   - `"static"` — the existing receiver-less builtin-static behaviour
 *     (`Array.isArray`, `Object.keys`, `Object.getOwnPropertyDescriptor`),
 *     kept BYTE-IDENTICAL — delegates to the unchanged
 *     `ensureStandaloneBuiltinStaticMethodClosure` below.
 *   - `"method"` / `"getter"` — brand-keyed native-method/getter closures with
 *     an `externref this` first user param + a brand-recovery prologue,
 *     delegated to `ensureStandaloneNativeMethodClosure` (native-proto.ts).
 *
 * S0 reaches only the `"static"` path; S1 wires `"method"`/`"getter"` for
 * RegExp through the refusal site below.
 */
function ensureStandaloneNativeMethodClosureLocal(
  ctx: CodegenContext,
  builtinName: string,
  propName: string,
  expr: ts.PropertyAccessExpression,
  kind: "static" | "method" | "getter",
  brand?: number,
): { type: { kind: "ref"; typeIdx: number }; funcIdx: number } | null {
  if (kind !== "static") {
    if (brand === undefined) return null;
    return ensureStandaloneNativeMethodClosure(ctx, brand, propName, kind);
  }
  return ensureStandaloneBuiltinStaticMethodClosure(ctx, builtinName, propName, expr);
}

/**
 * (#2175 S1) Register a builtin's `$NativeProto` glue (so its proto object can
 * materialize and its members resolve to native-method closures) and return its
 * brand. Returns `undefined` for builtins not yet wired into the native-proto
 * core (caller falls through to the existing refusal). S1 wires RegExp only;
 * S3 adds %TypedArray% / the concrete views.
 */
function tryEnsureNativeProtoBrand(ctx: CodegenContext, builtinName: string): number | undefined {
  if (builtinName === "RegExp") {
    return ensureRegExpNativeProtoGlue(ctx);
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
    fctx.body.push({ op: "f64.const", value: arity } as Instr);
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
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return undefined;

  const member = expr.name.text;
  const kind = glue.memberKind(member);
  const closure = ensureStandaloneNativeMethodClosure(ctx, brand, member, kind);
  if (!closure) return undefined;

  fctx.body.push({ op: "ref.func", funcIdx: closure.funcIdx } as Instr);
  fctx.body.push({ op: "struct.new", typeIdx: closure.type.typeIdx } as Instr);
  return closure.type;
}

function ensureStandaloneBuiltinStaticMethodClosure(
  ctx: CodegenContext,
  builtinName: string,
  propName: string,
  _expr: ts.PropertyAccessExpression,
): { type: { kind: "ref"; typeIdx: number }; funcIdx: number } | null {
  const key = `${builtinName}.${propName}`;
  let paramTypes: ValType[];
  let returnType: ValType | null;

  switch (key) {
    case "Array.isArray":
      paramTypes = [{ kind: "externref" }];
      returnType = { kind: "i32" };
      break;
    case "Object.keys":
      paramTypes = [{ kind: "externref" }];
      // Standalone Object.keys returns the object-runtime `$ObjVec` as an
      // externref; consumers read it back through native __extern_length /
      // __extern_get_idx. Preserve that contract for method values.
      returnType = { kind: "externref" };
      break;
    case "Object.getOwnPropertyDescriptor":
      paramTypes = [{ kind: "externref" }, { kind: "externref" }];
      returnType = { kind: "externref" };
      break;
    default:
      return null;
  }

  const resultTypes = returnType ? [returnType] : [];
  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, paramTypes, resultTypes);
  if (!wrapperTypes) return null;

  const funcName = `__builtin_static_${builtinName}_${propName}`;
  let funcIdx = ctx.funcMap.get(funcName);
  if (funcIdx === undefined) {
    const selfType: ValType = { kind: "ref", typeIdx: wrapperTypes.structTypeIdx };
    const closureFctx = makeBuiltinClosureFctx(funcName, selfType, paramTypes, returnType);

    if (key === "Array.isArray") {
      closureFctx.body.push({ op: "local.get", index: 1 });
      emitArrayIsArrayExternrefPredicate(ctx, closureFctx);
    } else if (key === "Object.keys") {
      const keysIdx = ensureLateImport(ctx, "__object_keys", [{ kind: "externref" }], [{ kind: "externref" }]);
      if (keysIdx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 });
      closureFctx.body.push({ op: "call", funcIdx: keysIdx });
      if (returnType && !valTypesMatch({ kind: "externref" }, returnType)) {
        coerceType(ctx, closureFctx, { kind: "externref" }, returnType);
      }
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
    }

    funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: funcName,
      typeIdx: wrapperTypes.liftedFuncTypeIdx,
      locals: closureFctx.locals,
      body: closureFctx.body,
      exported: false,
    });
    ctx.funcMap.set(funcName, funcIdx);
  }

  return { type: { kind: "ref", typeIdx: wrapperTypes.structTypeIdx }, funcIdx };
}

/**
 * (#1337) True when `expr` is the syntactic shape `<receiver>.bind(...)`.
 */
function isDirectBindCall(expr: ts.Expression): boolean {
  return (
    ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "bind"
  );
}

/**
 * (#1337) True when `expr` denotes a value produced by `Function.prototype.bind`
 * — either directly (`fn.bind(...)`) or indirectly through a `const`/`let`/`var`
 * binding whose initializer is a `.bind(...)` call (`const g = fn.bind(...); g.name`).
 *
 * `.name` / `.length` on a bound function MUST be read at runtime (the host's
 * bound exotic carries `"bound " + target.name` and
 * `max(0, target.length - boundArgs.length)`), NOT statically folded to the
 * target's symbol name / param count. The immediate form is handled by the
 * direct check; this helper extends that to the deferred-storage form, which is
 * the bulk of the `built-ins/Function/prototype/bind/*` test262 cluster.
 */
function isBindResultExpr(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (isDirectBindCall(expr)) return true;
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    const decl = sym?.valueDeclaration;
    if (
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      // Only trust the initializer for single-assignment bindings (const, or
      // a let/var with exactly one declaration site we can see). A reassigned
      // binding could hold something else, but const is the overwhelming case
      // in the test262 corpus and matches the spec-correct runtime read.
      isDirectBindCall(decl.initializer)
    ) {
      return true;
    }
  }
  return false;
}

// ── Struct name resolution (moved from expressions/misc.ts) ──────────

/**
 * Resolve the struct name for a TypeScript type by consulting structMap,
 * classExprNameMap, and anonTypeMap.
 */
export function resolveStructName(ctx: CodegenContext, tsType: ts.Type): string | undefined {
  const name = tsType.symbol?.name;
  if (name && name !== "__type" && name !== "__object" && ctx.structMap.has(name)) {
    return name;
  }
  // Check class expression name mapping (e.g. "__class" → "Point")
  if (name) {
    const mapped = ctx.classExprNameMap.get(name);
    if (mapped && ctx.structMap.has(mapped)) {
      return mapped;
    }
  }
  return ctx.anonTypeMap.get(tsType);
}

/**
 * Resolve a struct name for a property access/assignment target expression,
 * with fallbacks for widened variables and `this` in function constructors.
 */
export function resolveStructNameForExpr(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: ts.Expression,
): string | undefined {
  // (#1239) Variables initialised by an object literal containing get/set
  // accessor declarations are stored as externref plain JS objects. The
  // wasmGC struct path would silently drop the accessor body — bail out
  // so all reads/writes go through the externref host path that honours
  // the real accessor descriptor. Unwrap `ParenthesizedExpression` /
  // `AsExpression` / `NonNullExpression` wrappers so `(o as any).x` and
  // `(o)!.x` still trigger the override.
  let bareIdent: ts.Expression = expression;
  while (
    ts.isParenthesizedExpression(bareIdent) ||
    ts.isAsExpression(bareIdent) ||
    ts.isNonNullExpression(bareIdent) ||
    ts.isSatisfiesExpression(bareIdent) ||
    ts.isTypeAssertionExpression(bareIdent)
  ) {
    bareIdent = (bareIdent as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  if (ts.isIdentifier(bareIdent) && ctx.externrefAccessorVars.has(bareIdent.text)) {
    return undefined;
  }
  const objType = ctx.checker.getTypeAtLocation(expression);
  let typeName = resolveStructName(ctx, objType);
  if (!typeName && ts.isIdentifier(expression)) {
    typeName = ctx.widenedVarStructMap.get(expression.text);
  }
  if (!typeName && expression.kind === ts.SyntaxKind.ThisKeyword) {
    typeName = resolveThisStructName(ctx, fctx);
  }
  return typeName;
}

/**
 * (#1239) Same role as `resolveStructName(ctx, type)`, but consults
 * `ctx.externrefAccessorVars` first so an Identifier holding an
 * accessor-bearing object literal force-bails to the externref path.
 *
 * Use this at every site that previously called `resolveStructName(ctx,
 * <type-of-some-expression>)` when the underlying expression is
 * available, so the externref-tag override propagates uniformly.
 *
 * Sites without an expression (synthesized type arguments etc.) keep
 * calling `resolveStructName` directly — they can't involve an
 * accessor-tagged variable by construction.
 */
export function resolveEffectiveStructName(
  ctx: CodegenContext,
  expression: ts.Expression | undefined,
  fallbackType: ts.Type,
): string | undefined {
  if (expression) {
    let bare: ts.Expression = expression;
    while (
      ts.isParenthesizedExpression(bare) ||
      ts.isAsExpression(bare) ||
      ts.isNonNullExpression(bare) ||
      ts.isSatisfiesExpression(bare) ||
      ts.isTypeAssertionExpression(bare)
    ) {
      bare = (bare as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
    }
    if (ts.isIdentifier(bare) && ctx.externrefAccessorVars.has(bare.text)) {
      return undefined;
    }
  }
  return resolveStructName(ctx, fallbackType);
}

/**
 * Check if a type looks like an IteratorResult (has .value and .done properties)
 * even if the type checker doesn't resolve it as IteratorResult directly.
 * This handles cases where the type is a union (IteratorYieldResult | IteratorReturnResult).
 */
export function isGeneratorIteratorResultLike(ctx: CodegenContext, type: ts.Type, propName: string): boolean {
  if (propName !== "value" && propName !== "done") return false;
  // Check if the type has both .value and .done properties (IteratorResult shape)
  const props = type.getProperties();
  const hasValue = props.some((p) => p.name === "value");
  const hasDone = props.some((p) => p.name === "done");
  if (hasValue && hasDone) return true;
  // Check union types (IteratorResult = IteratorYieldResult | IteratorReturnResult)
  if (type.isUnion()) {
    for (const t of type.types) {
      if (isIteratorResultType(t)) return true;
    }
  }
  return false;
}

/**
 * Get the value type T from IteratorResult<T>.
 * Returns the ValType for the value, or null if not determinable.
 */
export function getIteratorResultValueType(ctx: CodegenContext, type: ts.Type): ValType | null {
  // Try to get T from the type arguments
  const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference);
  if (typeArgs.length > 0) {
    return resolveWasmType(ctx, typeArgs[0]!);
  }
  // For unions, check each member
  if (type.isUnion()) {
    for (const t of type.types) {
      const args = ctx.checker.getTypeArguments(t as ts.TypeReference);
      if (args.length > 0) {
        return resolveWasmType(ctx, args[0]!);
      }
    }
  }
  return null;
}

// ── Dummy struct helpers ────────────────────────────────────────────

/**
 * Emit instructions to create a dummy struct instance for a class.
 * Used when invoking static/prototype getters that require a `this` parameter
 * but we don't have a real instance available.
 */
function emitDummyStruct(ctx: CodegenContext, fctx: FunctionContext, className: string): boolean {
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return false;

  for (const field of fields) {
    if (field.name === "__tag") {
      const tag = ctx.classTagMap.get(className) ?? 0;
      fctx.body.push({ op: "i32.const", value: tag });
    } else {
      switch (field.type.kind) {
        case "f64":
          fctx.body.push({ op: "f64.const", value: 0 });
          break;
        case "i32":
          fctx.body.push({ op: "i32.const", value: 0 });
          break;
        case "externref":
          fctx.body.push({ op: "ref.null.extern" });
          break;
        case "ref_null":
          fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        case "ref":
          fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        default:
          fctx.body.push({ op: "i32.const", value: 0 });
          break;
      }
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
  return true;
}

/**
 * Emit a call to a getter function, passing a dummy struct instance as `this`.
 * Returns the getter's return type, or null on failure.
 */
function emitGetterCallWithDummy(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  getterName: string,
  funcIdx: number,
): ValType | null {
  if (!emitDummyStruct(ctx, fctx, className)) return null;
  fctx.body.push({ op: "call", funcIdx });
  // Determine return type from the getter's function type
  const localIdx = funcIdx - ctx.numImportFuncs;
  const funcDef = localIdx >= 0 ? ctx.mod.functions[localIdx] : undefined;
  if (funcDef) {
    const funcType = ctx.mod.types[funcDef.typeIdx];
    if (funcType?.kind === "func" && funcType.results.length > 0) {
      return funcType.results[0]!;
    }
  }
  return { kind: "externref" };
}

// ── Null guard helpers ───────────────────────────────────────────────

/**
 * Returns true when the expression is guaranteed to produce a non-null value,
 * allowing the caller to skip runtime null guards.
 *
 * Provably non-null cases:
 *  - `new Foo()`          — constructor always returns an object
 *  - `{ x: 1 }`          — object literals are never null
 *  - `[1, 2]`            — array literals are never null
 *  - `"str"` / template  — string literals are never null
 *  - Parenthesized wrapper around any of the above
 */
export function isProvablyNonNull(expr: ts.Expression, checker?: ts.TypeChecker): boolean {
  // Unwrap parentheses: (new Foo()).bar
  let inner: ts.Expression = expr;
  while (ts.isParenthesizedExpression(inner)) {
    inner = inner.expression;
  }
  switch (inner.kind) {
    case ts.SyntaxKind.NewExpression:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
      return true;
    default:
      break;
  }
  // Identifier referencing a const variable with a provably non-null initializer
  if (checker && ts.isIdentifier(inner)) {
    const sym = checker.getSymbolAtLocation(inner);
    if (sym) {
      const decl = sym.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const declList = decl.parent;
        if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
          return isProvablyNonNull(decl.initializer, checker);
        }
      }
    }
  }
  return false;
}

export function typeErrorThrowInstrs(ctx: CodegenContext, node?: ts.Node): Instr[] {
  const line = node ? getLine(node) : 0;
  const col = node ? getCol(node) : 0;
  const message =
    line > 0 && col > 0
      ? `TypeError: Cannot access property on null or undefined at ${line}:${col}`
      : "TypeError: Cannot access property on null or undefined";
  // Register the literal: in legacy mode this adds a `string_constants` global
  // import; in nativeStrings mode it just records the value with sentinel -1
  // so call sites can materialize it inline (#1174).
  addStringConstantGlobal(ctx, message);
  const tagIdx = ensureExnTag(ctx);
  return [...stringConstantExternrefInstrs(ctx, message), { op: "throw", tagIdx } as Instr];
}

/**
 * Emit a null check on the ref currently on the stack. If null, throws
 * TypeError via the exception tag. If non-null, the ref remains on the stack.
 * The `refType` should be the nullable ref type of the value on the stack.
 *
 * Stack: [ref_null T] -> [ref_null T]  (non-null at runtime after this point)
 */
export function emitNullCheckThrow(ctx: CodegenContext, fctx: FunctionContext, refType: ValType, node?: ts.Node): void {
  const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;

  const tmp = allocTempLocal(fctx, refType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  if (backupLocal !== undefined) {
    // A guarded cast backup exists: the null might be from a failed ref.cast
    // (wrong struct type), not from a genuinely null value.  Only throw
    // TypeError when the ORIGINAL pre-cast value was also null (#789).
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: backupLocal } as Instr,
        { op: "ref.is_null" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: typeErrorThrowInstrs(ctx, node),
          else: [], // wrong struct type — don't throw
        } as Instr,
      ],
      else: [],
    });
  } else {
    // No backup local — this is a direct null check on a genuine ref_null.
    // Throw TypeError so Wasm try-catch can intercept it (Wasm traps from
    // struct.get on null are NOT catchable by Wasm exception handling). (#789)
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: typeErrorThrowInstrs(ctx, node),
      else: [],
    });
  }

  fctx.body.push({ op: "local.get", index: tmp });
  releaseTempLocal(fctx, tmp);
}

/**
 * Find all struct types (other than excludeTypeIdx) that have a field named
 * propName.  Returns an array of {structTypeIdx, fieldIdx, fieldType} for
 * each matching struct type.  Used for multi-struct dispatch when the primary
 * ref.test fails (the object may be a valid GC struct of a different type).
 * When excludeTypeIdx is -1, no type is excluded (useful for the externref path
 * where there is no primary struct type).
 */
export function findAlternateStructsForField(
  ctx: CodegenContext,
  propName: string,
  excludeTypeIdx: number,
): { structTypeIdx: number; fieldIdx: number; fieldType: ValType }[] {
  const result: { structTypeIdx: number; fieldIdx: number; fieldType: ValType }[] = [];
  for (const [typeName, fields] of ctx.structFields) {
    const sIdx = ctx.structMap.get(typeName);
    if (sIdx === undefined || sIdx === excludeTypeIdx) continue;
    const fIdx = fields.findIndex((f) => f.name === propName);
    if (fIdx !== -1) {
      result.push({ structTypeIdx: sIdx, fieldIdx: fIdx, fieldType: fields[fIdx]!.type });
    }
  }
  return result;
}

export function emitNullGuardedStructGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objType: ValType,
  fieldType: ValType,
  typeIdx: number,
  fieldIdx: number,
  propName?: string,
  throwOnNull: boolean = false,
): void {
  // For result type in the if block, normalize ref to ref_null so the null branch is valid
  const resultType: ValType =
    fieldType.kind === "ref" ? { kind: "ref_null", typeIdx: (fieldType as any).typeIdx } : fieldType;

  // When propName is provided, the object may be a valid GC struct of a
  // DIFFERENT type (after emitGuardedRefCast returned ref.null for a type
  // mismatch).  We need multi-struct dispatch: try the primary struct type
  // first, then try alternative struct types that have the same field name.
  // We operate on anyref so we can re-test the same value against multiple
  // struct types without losing it.
  if (propName) {
    // Optimization: when objType is already the exact target struct type (ref_null typeIdx),
    // the Wasm type system guarantees the runtime value is typeIdx or null — no multi-struct
    // dispatch needed.  Use a simple null-check + direct struct.get, skipping ref.test + ref.cast.
    if (objType.kind === "ref_null" && (objType as { typeIdx: number }).typeIdx === typeIdx) {
      const tmp = allocLocal(fctx, `__ng_${fctx.locals.length}`, objType);
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val" as const, type: resultType },
        then: typeErrorThrowInstrs(ctx),
        else: [{ op: "local.get", index: tmp } as Instr, { op: "struct.get", typeIdx, fieldIdx } as Instr],
      });
      return;
    }

    // Widen the ref_null $T to anyref so we can multi-dispatch
    const tmpAny = allocLocal(fctx, `__ng_any_${fctx.locals.length}`, { kind: "anyref" });
    fctx.body.push({ op: "local.set", index: tmpAny });
    const resultLocal = allocLocal(fctx, `__ng_res_${fctx.locals.length}`, resultType);

    // Find alternative struct types with the same field name
    const alternates = findAlternateStructsForField(ctx, propName, typeIdx);

    // Build the fallback chain: try alternates on a given anyref, then default
    const buildFallback = (srcLocal: number, altIdx: number): Instr[] => {
      if (altIdx < alternates.length) {
        const alt = alternates[altIdx]!;
        const altCoerce = coercionInstrs(ctx, alt.fieldType, resultType, fctx);
        return [
          { op: "local.get", index: srcLocal } as Instr,
          { op: "ref.test", typeIdx: alt.structTypeIdx } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: srcLocal } as Instr,
              { op: "ref.cast", typeIdx: alt.structTypeIdx } as Instr,
              { op: "struct.get", typeIdx: alt.structTypeIdx, fieldIdx: alt.fieldIdx } as Instr,
              ...altCoerce,
              { op: "local.set", index: resultLocal } as Instr,
            ],
            else: buildFallback(srcLocal, altIdx + 1),
          } as Instr,
        ];
      }
      // No more alternates — return default value
      return [...defaultValueInstrs(resultType), { op: "local.set", index: resultLocal } as Instr];
    };

    // Check if emitGuardedRefCast saved a pre-cast backup (#792).
    // When the guarded cast failed (wrong struct type), the value on
    // the stack is ref.null but the backup anyref still holds the
    // original value which may match an alternate struct type.
    const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;

    // Null check: if the value is genuinely null, throw TypeError (#728)
    // But if the backup is available and non-null, use it for multi-struct dispatch
    fctx.body.push({ op: "local.get", index: tmpAny });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then:
        backupLocal !== undefined
          ? [
              // Value is null — could be wrong struct type or genuinely null.
              // Check the backup anyref to distinguish.
              { op: "local.get", index: backupLocal } as Instr,
              { op: "ref.is_null" } as Instr,
              {
                op: "if",
                blockType: { kind: "empty" },
                // Backup is also null → genuinely null, throw TypeError
                then: typeErrorThrowInstrs(ctx),
                // Backup is non-null → wrong struct type, try primary + alternates on backup
                else: [
                  { op: "local.get", index: backupLocal } as Instr,
                  { op: "ref.test", typeIdx } as Instr,
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: backupLocal } as Instr,
                      { op: "ref.cast", typeIdx } as Instr,
                      { op: "struct.get", typeIdx, fieldIdx } as Instr,
                      { op: "local.set", index: resultLocal } as Instr,
                    ],
                    else: buildFallback(backupLocal, 0),
                  } as Instr,
                ],
              } as Instr,
            ]
          : typeErrorThrowInstrs(ctx),
      else: [],
    });

    // Non-null path: try primary struct type on the original value
    fctx.body.push({ op: "local.get", index: tmpAny });
    fctx.body.push({ op: "ref.test", typeIdx });

    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: tmpAny } as Instr,
        { op: "ref.cast", typeIdx } as Instr,
        { op: "struct.get", typeIdx, fieldIdx } as Instr,
        { op: "local.set", index: resultLocal } as Instr,
      ],
      else: buildFallback(tmpAny, 0),
    });
    fctx.body.push({ op: "local.get", index: resultLocal });
    return;
  }

  const tmp = allocLocal(fctx, `__ng_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });
  // When throwOnNull is true, throw TypeError for null/undefined property access (#728).
  // When false (ref cells), return a default value for uninitialized captures.
  const nullBranch = throwOnNull ? typeErrorThrowInstrs(ctx) : defaultValueInstrs(resultType);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: resultType },
    then: nullBranch,
    else: [{ op: "local.get", index: tmp } as Instr, { op: "struct.get", typeIdx, fieldIdx } as Instr],
  });
}

/**
 * Emit a struct.get from an externref value. The externref on the stack is
 * converted to anyref via any.convert_extern, then null-safely cast to the
 * target struct type. If the value is the expected struct type, use struct.get.
 * If the value is non-null but wrong type, fall back to __extern_get (dynamic
 * property access) when propName is provided. If the value is null, return a
 * default value.
 *
 * Stack: [externref] -> [fieldType]
 */
export function emitExternrefToStructGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fieldType: ValType,
  structTypeIdx: number,
  fieldIdx: number,
  propName?: string,
  throwOnNull: boolean = false,
): void {
  // For result type, normalize ref to ref_null so the null branch is valid
  const resultType: ValType =
    fieldType.kind === "ref" ? { kind: "ref_null", typeIdx: (fieldType as any).typeIdx } : fieldType;

  // Convert externref -> anyref for struct type testing
  fctx.body.push({ op: "any.convert_extern" } as Instr);

  // Use multi-struct dispatch: try the primary struct type, then any
  // alternative struct types that have the same field name.  This handles
  // the case where the runtime object is a valid GC struct but of a
  // different type than expected (e.g., {x:1,y:2} compiled as $__anon_0
  // but accessed as $Point).  WasmGC structs are opaque to JS, so
  // __extern_get cannot read their fields — we must use struct.get.
  const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
  fctx.body.push({ op: "local.tee", index: tmpAny });
  const resultLocal = allocTempLocal(fctx, resultType);

  // Null check FIRST: if the externref-converted-to-anyref is null, throw TypeError (#728)
  // This catches property access on null/undefined before attempting struct dispatch.
  if (throwOnNull) {
    fctx.body.push({ op: "local.get", index: tmpAny });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: typeErrorThrowInstrs(ctx),
      else: [],
    });
  }

  // Build the __extern_get fallback: convert anyref back to externref and call
  // __extern_get(obj, key) for genuine JS objects that aren't GC structs.
  // This prevents silent wrong results (default 0/null) when a valid externref
  // object doesn't match any known struct type.
  let externGetFallback: Instr[] | undefined;
  if (propName) {
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getIdx !== undefined) {
      externGetFallback = [];
      // Convert anyref back to externref for __extern_get
      externGetFallback.push({ op: "local.get", index: tmpAny } as Instr);
      externGetFallback.push({ op: "extern.convert_any" } as Instr);
      // Push property name string
      addStringConstantGlobal(ctx, propName);
      externGetFallback.push(...stringConstantExternrefInstrs(ctx, propName));
      externGetFallback.push({ op: "call", funcIdx: getIdx } as Instr);
      // Coerce externref result to the expected result type
      if (resultType.kind === "f64") {
        const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
        flushLateImportShifts(ctx, fctx);
        if (unboxIdx !== undefined) {
          externGetFallback.push({ op: "call", funcIdx: unboxIdx } as Instr);
        }
      } else if (resultType.kind === "i32") {
        const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
        flushLateImportShifts(ctx, fctx);
        if (unboxIdx !== undefined) {
          externGetFallback.push({ op: "call", funcIdx: unboxIdx } as Instr);
          externGetFallback.push({ op: "i32.trunc_sat_f64_s" });
        }
      }
      // For ref/ref_null result types, the externref from __extern_get needs
      // to be converted to anyref and then cast to the expected struct type.
      // If the cast fails (wrong type from JS), fall back to a default value.
      if (resultType.kind === "ref_null") {
        // The __extern_get returns externref; convert to anyref, try ref.cast_null
        const tmpExtResult = allocTempLocal(fctx, { kind: "anyref" });
        externGetFallback.push({ op: "any.convert_extern" } as Instr);
        externGetFallback.push({ op: "local.tee", index: tmpExtResult } as Instr);
        externGetFallback.push({ op: "ref.test", typeIdx: (resultType as any).typeIdx } as Instr);
        externGetFallback.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: tmpExtResult } as Instr,
            { op: "ref.cast", typeIdx: (resultType as any).typeIdx } as Instr,
            { op: "local.set", index: resultLocal } as Instr,
          ],
          else: [...defaultValueInstrs(resultType), { op: "local.set", index: resultLocal } as Instr],
        } as Instr);
        releaseTempLocal(fctx, tmpExtResult);
      } else {
        externGetFallback.push({ op: "local.set", index: resultLocal } as Instr);
      }
    }
  }

  fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });

  // Find alternative struct types with the same field name
  const alternates = propName ? findAlternateStructsForField(ctx, propName, structTypeIdx) : [];

  // Build the fallback chain: try alternates, then __extern_get or default
  const buildFallbackChain = (altIdx: number): Instr[] => {
    if (altIdx < alternates.length) {
      const alt = alternates[altIdx]!;
      const altCoerce = coercionInstrs(ctx, alt.fieldType, resultType, fctx);
      return [
        { op: "local.get", index: tmpAny } as Instr,
        { op: "ref.test", typeIdx: alt.structTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: tmpAny } as Instr,
            { op: "ref.cast", typeIdx: alt.structTypeIdx } as Instr,
            { op: "struct.get", typeIdx: alt.structTypeIdx, fieldIdx: alt.fieldIdx } as Instr,
            ...altCoerce,
            { op: "local.set", index: resultLocal } as Instr,
          ],
          else: buildFallbackChain(altIdx + 1),
        } as Instr,
      ];
    }
    // No more struct alternates — use __extern_get for JS objects, or default value
    if (externGetFallback) {
      return externGetFallback;
    }
    return [...defaultValueInstrs(resultType), { op: "local.set", index: resultLocal } as Instr];
  };

  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: tmpAny } as Instr,
      { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
      { op: "struct.get", typeIdx: structTypeIdx, fieldIdx } as Instr,
      { op: "local.set", index: resultLocal } as Instr,
    ],
    else: buildFallbackChain(0),
  });

  fctx.body.push({ op: "local.get", index: resultLocal });
  releaseTempLocal(fctx, tmpAny);
  releaseTempLocal(fctx, resultLocal);
}

// ── Optional property access ─────────────────────────────────────────

export function compileOptionalPropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null {
  // Compile the receiver
  const objType = compileExpression(ctx, fctx, expr.expression);
  if (!objType) return null;

  // Determine result type from the TS type of the property being accessed
  const tsPropType = ctx.checker.getTypeAtLocation(expr);
  let resultType: ValType = resolveWasmType(ctx, tsPropType);
  // For ref types, use externref as the block type to avoid null-subtyping issues
  if (resultType.kind === "ref" || resultType.kind === "ref_null") {
    resultType = { kind: "externref" };
  }
  // (#2051) A short-circuited `?.` must yield `undefined`, not the property
  // type's default. When the whole-chain static type is a nullable primitive
  // (`number | undefined` etc., which `resolveWasmType` collapses to a bare
  // f64/i32 that cannot represent `undefined`), widen the result to externref so
  // the null arm can carry host `undefined` (via `emitUndefined`) and the
  // non-null arm boxes the primitive (`__box_number`/`__box_boolean`) — both
  // arms then agree on externref. The rest of the pipeline already discriminates
  // host undefined in this slot: `=== undefined` (`__extern_is_undefined`),
  // `typeof` (`__typeof`), and ToString (`__extern_toString`). Gated on the
  // nullable static type so non-nullable optional accesses (e.g. `s?.length`
  // where `s: string`) keep their bare f64/i32 codegen — no boxing, no perf hit.
  // This boxes into a plain externref, NOT the AnyValue struct, so the #1888
  // tag-5 comparator ABI is untouched.
  const widenToUndefinedExternref =
    (resultType.kind === "f64" || resultType.kind === "i32") && isNullablePrimitiveType(tsPropType);
  if (widenToUndefinedExternref) {
    resultType = { kind: "externref" };
  }

  // `?.` short-circuits on null/undefined. `ref.is_null` only validates on a
  // reference operand, but the receiver can lower to a non-reference value
  // type — e.g. a module-level `const obj = undefined` is stored as an i32
  // global, so reading it yields i32 (#1603). A non-reference receiver here is
  // the compiler's representation of `undefined`/`null`, which always
  // short-circuits the chain: drop the receiver and emit the default result.
  if (objType.kind !== "ref" && objType.kind !== "ref_null" && objType.kind !== "externref") {
    fctx.body.push({ op: "drop" });
    if (resultType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (resultType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      // (#2051) externref result (incl. the nullable-primitive widening above)
      // → host `undefined`, so `=== undefined` / `typeof` / `+` read it as
      // undefined rather than a bare null.
      emitUndefined(ctx, fctx);
    }
    return resultType;
  }

  const tmp = allocLocal(fctx, `__opt_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  const savedBody = fctx.body;
  fctx.savedBodies.push(savedBody);

  // then branch (null path): push the appropriate null/zero default
  let thenInstrs: Instr[];
  if (resultType.kind === "f64") {
    thenInstrs = [{ op: "f64.const", value: 0 }];
  } else if (resultType.kind === "i32") {
    thenInstrs = [{ op: "i32.const", value: 0 }];
  } else {
    // (#2051) externref result (incl. the nullable-primitive widening above) →
    // host `undefined`. Build via a body-swap because `emitUndefined` pushes to
    // `fctx.body` and may flush late imports; do not hand-roll the instr array.
    const savedForThen = fctx.body;
    fctx.body = [];
    emitUndefined(ctx, fctx);
    thenInstrs = fctx.body;
    fctx.body = savedForThen;
  }

  // else branch (non-null path): get the property from the temp
  fctx.body = [];
  fctx.body.push({ op: "local.get", index: tmp });
  // Compile the property access part without the receiver. After the
  // `ref.is_null` short-circuit the receiver is known non-null, so resolve
  // the property against the non-nullable part of the union — the bare
  // `C | null` union symbol is anonymous and would fail struct resolution,
  // leaving the receiver ref stranded on the stack (#1603).
  const tsObjType = ctx.checker.getNonNullableType(ctx.checker.getTypeAtLocation(expr.expression));
  const propName = expr.name.text;
  let elseResultType: ValType | null = null;
  if (isExternalDeclaredClass(tsObjType, ctx.checker)) {
    compileExternPropertyGetFromStack(ctx, fctx, tsObjType, propName);
    elseResultType = { kind: "externref" };
  } else if (isStringType(tsObjType) && propName === "length") {
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
      // len is field 0 of $AnyString — works for both FlatString and ConsString
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
    } else {
      const funcIdx = ctx.jsStringImports.get("length");
      if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
    }
    elseResultType = { kind: "i32" };
  } else {
    // General struct field access: look up the struct type and field index
    const structName = resolveStructName(ctx, tsObjType);
    if (structName) {
      const structTypeIdx = ctx.structMap.get(structName);
      const fields = ctx.structFields.get(structName);
      if (structTypeIdx !== undefined && fields) {
        // Check for accessor first
        const accessorKey = `${structName}_${propName}`;
        const getterName = `${structName}_get_${propName}`;
        const getterIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName));
        const closureAccGet =
          S5C_STRUCT_ACCESSOR_CLOSURE && ctx.standalone
            ? ctx.structAccessorClosure.get(accessorKey)?.getGlobal
            : undefined;
        if (closureAccGet !== undefined) {
          // (#1888 S5c / C3) Migrated struct accessor → route the read through the
          // host-free closure stored in the per-(struct,prop) global, using the
          // SAME S5b __call_accessor_get driver as the open-`$Object` arm. The
          // receiver struct ref is on the stack: box it to externref so the driver
          // threads it as `this` via __current_this (#1636-S1), then call. Result
          // is externref (the getter's boxed return); downstream coerces to the
          // member's static type, exactly as the __extern_get path does.
          fctx.body.push({ op: "extern.convert_any" } as Instr); // recv struct ref → externref
          fctx.body.push({ op: "global.get", index: closureAccGet }); // getter closure (externref)
          const driverIdx = reserveAccessorGetDriver(ctx);
          fctx.body.push({ op: "call", funcIdx: driverIdx });
          elseResultType = { kind: "externref" };
        } else if (ctx.classAccessorSet.has(accessorKey) && getterIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: getterIdx });
          // Determine getter return type
          const funcDef = ctx.mod.functions[getterIdx - ctx.numImportFuncs];
          if (funcDef) {
            const typeDef = ctx.mod.types[funcDef.typeIdx];
            if (typeDef && typeDef.kind === "func" && typeDef.results.length > 0) {
              elseResultType = typeDef.results[0]!;
            }
          }
        } else {
          const fieldIdx = fields.findIndex((f: any) => f.name === propName);
          if (fieldIdx >= 0) {
            // Cast to the concrete struct type if needed, using ref.test guard to avoid illegal cast traps
            if (objType.kind !== "ref" || (objType as any).typeIdx !== structTypeIdx) {
              // Use ref.test to guard against illegal casts at runtime
              const castTmp = allocLocal(fctx, `__optcast_tmp_${fctx.locals.length}`, objType);
              fctx.body.push({ op: "local.tee", index: castTmp });
              fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
              fctx.body.push({
                op: "if",
                blockType: { kind: "val", type: fields[fieldIdx]!.type },
                then: [
                  { op: "local.get", index: castTmp },
                  { op: "ref.cast", typeIdx: structTypeIdx },
                  { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
                ],
                else: [
                  // Type mismatch at runtime — emit a safe default (sNaN sentinel for f64 #866)
                  ...((fields[fieldIdx]!.type.kind === "f64"
                    ? [{ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" }]
                    : fields[fieldIdx]!.type.kind === "i32"
                      ? [{ op: "i32.const", value: 0 }]
                      : [{ op: "ref.null.extern" }]) as Instr[]),
                ],
              });
            } else {
              fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
            }
            elseResultType = fields[fieldIdx]!.type;
          }
        }
      }
    }
  }

  if (elseResultType === null) {
    // Property could not be resolved to a concrete struct field/getter. The
    // receiver ref is still on the stack from `local.get tmp`; coerce it to
    // the block result type so the `if` typechecks rather than leaving a
    // mismatched ref as the else-branch fallthrough (#1603).
    elseResultType = objType;
  }
  // Coerce else branch result to match the block result type
  if (!valTypesMatch(elseResultType, resultType)) {
    coerceType(ctx, fctx, elseResultType, resultType);
  }
  const elseInstrs = fctx.body;

  popBody(fctx, savedBody);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });

  return resultType;
}

/** Helper: compile extern property get when receiver is already on stack */
export function compileExternPropertyGetFromStack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objType: ts.Type,
  propName: string,
): void {
  const className = objType.getSymbol()?.name;
  if (!className) return;
  // Walk inheritance chain to find the property
  let current: string | undefined = className;
  while (current) {
    const info = ctx.externClasses.get(current);
    if (info?.properties.has(propName)) {
      const importName = `${info.importPrefix}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
      return;
    }
    current = (ctx as any).externClassParent?.get(current);
  }
}

// ── Property access ──────────────────────────────────────────────────

/**
 * #2077 — true when `recv` is (or resolves to) a `catch (e)` clause binding.
 * Used to scope the standalone `$Error`-guarded `.message`/`.name` read to
 * values that genuinely originate from a `throw`, so plain `any`-typed objects
 * (`const o: any = { message: "x" }`) keep reading their fields through the
 * normal object-property path rather than the Error struct guard (whose
 * non-Error `else` arm yields a null string → null-deref trap).
 *
 * A catch binding's symbol has a `valueDeclaration` that is the
 * `VariableDeclaration` whose parent is a `CatchClause` (TS models
 * `catch (e)` as a `VariableDeclaration` inside the `CatchClause`). Only a
 * plain identifier receiver is considered — a destructured catch binding
 * (`catch ({ message })`) isn't an identifier here and falls through to the
 * generic path.
 */
function receiverIsCatchClauseBinding(ctx: CodegenContext, recv: ts.Expression): boolean {
  if (!ts.isIdentifier(recv)) return false;
  const sym = ctx.checker.getSymbolAtLocation(recv);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  return (
    decl !== undefined && ts.isVariableDeclaration(decl) && decl.parent !== undefined && ts.isCatchClause(decl.parent)
  );
}

/**
 * (#2179) When the module uses `delete <member>` (JS-host mode only), route an
 * `any`/`unknown`-typed property READ through the tombstone-aware `__extern_get`
 * host helper instead of the inline `ref.test`+`struct.get` fast-path. Returns
 * the emitted result type (always `externref`) when it handled the read, or
 * `undefined` to let the normal path run.
 *
 * Tightly scoped so it never hijacks reads that the fast-path handles correctly:
 * only `any`/`unknown` receivers, never a method/function-typed access, never a
 * reserved accessor (`length`/`constructor`/`__proto__`/`prototype`), and never
 * when the receiver resolves to a concrete (non-`any`) struct/class/array type.
 */
function tryEmitDeleteAwareDynamicGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  objType: ts.Type,
  propName: string,
): ValType | null | undefined {
  if (!ctx.moduleUsesDelete || ctx.standalone) return undefined;
  // Only dynamic (`any`/`unknown`) receivers take the bypassed fast-path that
  // ignores the tombstone. Concrete struct/class/array receivers are typed and
  // unaffected by the `any`-read path this guards.
  const isAnyOrUnknown = (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
  if (!isAnyOrUnknown) return undefined;
  // Reserved accessors have dedicated lowerings (array length, proto walk,
  // constructor identity) — never reroute them.
  if (
    propName === "length" ||
    propName === "constructor" ||
    propName === "__proto__" ||
    propName === "prototype" ||
    propName === "name"
  ) {
    return undefined;
  }
  // A method/function-typed access (e.g. `o.fn` where `fn` is callable, or a
  // built-in method) must keep its closure/funcref lowering — `__extern_get`
  // would box it as a plain value.
  const accessType = ctx.checker.getTypeAtLocation(expr);
  if (accessType.getCallSignatures && accessType.getCallSignatures().length > 0) return undefined;

  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined) return undefined;

  // Evaluate the receiver, coerce to externref, then __extern_get(obj, "prop").
  const objResult = compileExpression(ctx, fctx, expr.expression);
  if (objResult && objResult.kind !== "externref") {
    coerceType(ctx, fctx, objResult, { kind: "externref" });
  } else if (!objResult) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
  }
  addStringConstantGlobal(ctx, propName);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
  fctx.body.push({ op: "call", funcIdx: getIdx } as Instr);
  return { kind: "externref" };
}

export function compilePropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null {
  // Optional chaining: obj?.prop
  if (expr.questionDotToken) {
    return compileOptionalPropertyAccess(ctx, fctx, expr);
  }

  // #1886 Slice B: linear-backed Uint8Array `buf.length` → the len i32 local
  // (widened to f64). Only fires for a registered linear-safe buffer; any other
  // receiver falls through to the GC property-access path unchanged.
  const linU8Len = tryEmitLinearU8Length(ctx, fctx, expr);
  if (linU8Len !== null) return linU8Len;

  const objType = ctx.checker.getTypeAtLocation(expr.expression);
  const propName = ts.isPrivateIdentifier(expr.name) ? "__priv_" + expr.name.text.slice(1) : expr.name.text;

  // (#2179) Tombstone-aware read for `any`/`unknown` receivers in delete-using
  // JS-host modules. The default `any`-receiver read resolves to an inline
  // `ref.test`+`struct.get` fast-path that reads the LIVE WasmGC field, ignoring
  // the runtime delete tombstone — so `delete o.a; o.a` returned the stale
  // value, and `o.a === undefined` constant-folded to `false` because the
  // field's static type is `f64` (never undefined). Route the read through the
  // tombstone-aware `__extern_get` host helper, which returns an `externref`
  // (real `undefined` when tombstoned, so `=== undefined` is no longer folded)
  // and re-add via `__extern_set`/`_safeSet` clears the tombstone. Gated on the
  // `moduleUsesDelete` pre-scan so delete-free modules keep the byte-identical
  // fast-path; standalone has no `__extern_get` host import (#2179 A7 covers it
  // via $Object representation steering — separate follow-up).
  {
    const dyn = tryEmitDeleteAwareDynamicGet(ctx, fctx, expr, objType, propName);
    if (dyn !== undefined) return dyn;
  }

  const jsonParsePropertyType = tryEmitJsonParsePropertyAccess(ctx, fctx, expr);
  if (jsonParsePropertyType !== undefined) return jsonParsePropertyType;

  {
    const temporalPropertyType = tryCompileTemporalPropertyAccess(ctx, fctx, expr);
    if (temporalPropertyType !== undefined) return temporalPropertyType;
  }

  // TextEncoder/TextDecoder read-only Web API properties under no-host
  // targets. These instances are stateless placeholders; preserve receiver
  // evaluation, then return the standard UTF-8/default option values.
  {
    const objSym =
      objType.getSymbol()?.name ??
      (ts.isNewExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)
        ? expr.expression.expression.text
        : undefined);
    if (
      (ctx.wasi || ctx.standalone || ctx.strictNoHostImports) &&
      (objSym === "TextEncoder" || objSym === "TextDecoder")
    ) {
      if (propName === "encoding") {
        const recvType = compileExpression(ctx, fctx, expr.expression);
        if (recvType !== null) fctx.body.push({ op: "drop" } as Instr);
        return compileStringLiteral(ctx, fctx, "utf-8");
      }
      if (objSym === "TextDecoder" && (propName === "fatal" || propName === "ignoreBOM")) {
        const recvType = compileExpression(ctx, fctx, expr.expression);
        if (recvType !== null) fctx.body.push({ op: "drop" } as Instr);
        fctx.body.push({ op: "i32.const", value: 0 } as Instr);
        return { kind: "i32" };
      }
    }
  }

  // #1914 — standalone RegExp reflection (`re.source`/`.flags`/`.global`/…/
  // `.lastIndex`) and match-result fields (`m.index`/`m.input`). Must run
  // BEFORE the extern-class property path, which would otherwise emit an
  // `env.RegExp_get_*` host import (a standalone purity leak), and before the
  // generic struct/vec fallbacks, which silently return 0 for `.index`.
  // (#2175 S1) `<Builtin>.prototype.<member>.length` / `.name` — the arity/name
  // of a native-method-closure VALUE, folded at compile time from the glue's
  // advertised metadata (e.g. `RegExp.prototype.test.length === 1`,
  // `.name === "test"`). Must precede the closure-value path so the member is
  // not materialized just to read its arity. Static, zero runtime cost.
  {
    const metaRead = tryCompileStandaloneBuiltinProtoMemberMeta(ctx, fctx, expr);
    if (metaRead !== undefined) return metaRead;
  }

  // (#2175 S1) `<Builtin>.prototype.<member>` as a value (two-level access whose
  // inner is a builtin proto): resolve `<member>` to a native-method/getter
  // closure value via the brand-keyed factory, with a brand-recovery prologue.
  // This is the reflective tier — `RegExp.prototype.test`, the `.flags`-getter,
  // etc. — that chained off the inner `RegExp.prototype` refusal pre-#2175.
  //
  // MUST run BEFORE the #1914 instance-reflection read: the static type of
  // `RegExp.prototype` is `RegExp`, so #1914's `isGlobalRegExpType` guard would
  // otherwise capture `RegExp.prototype.flags` and refuse (the proto object is
  // not a backend-created RegExp *value*). The proto-member path returns the
  // member's accessor/method *closure* — the correct reflective semantics.
  {
    const protoMember = tryCompileStandaloneBuiltinProtoMemberRead(ctx, fctx, expr);
    if (protoMember !== undefined) return protoMember;
  }

  {
    const standaloneRegExpRead = tryCompileStandaloneRegExpPropertyRead(ctx, fctx, expr);
    if (standaloneRegExpRead !== undefined) return standaloneRegExpRead;
    const standaloneMatchResultRead = tryCompileStandaloneRegExpMatchResultRead(ctx, fctx, expr);
    if (standaloneMatchResultRead !== undefined) return standaloneMatchResultRead;
  }

  // #1780 — `TextEncoder.encodeInto(...).read` / `.written` under no-host
  // targets. The call lowers to a native helper returning a
  // `TextEncoderEncodeIntoResult` WasmGC struct; read its fields with a direct
  // `struct.get` (fields: 0 = read, 1 = written, both f64) instead of the
  // generic `__extern_get` host import, which is unavailable standalone/WASI.
  if (
    (ctx.wasi || ctx.standalone || ctx.strictNoHostImports) &&
    (propName === "read" || propName === "written") &&
    objType.getSymbol()?.name === "TextEncoderEncodeIntoResult"
  ) {
    // Compile the receiver first: the `encodeInto(...)` call registers the
    // `TextEncoderEncodeIntoResult` struct and returns it as a ref, so the
    // struct type index is only known *after* the call is lowered.
    const recvType = compileExpression(ctx, fctx, expr.expression);
    const resultTypeIdx = ctx.structMap.get("TextEncoderEncodeIntoResult");
    if (
      resultTypeIdx !== undefined &&
      recvType &&
      (recvType.kind === "ref" || recvType.kind === "ref_null") &&
      recvType.typeIdx === resultTypeIdx
    ) {
      fctx.body.push({ op: "struct.get", typeIdx: resultTypeIdx, fieldIdx: propName === "read" ? 0 : 1 } as Instr);
      return { kind: "f64" };
    }
    // Receiver didn't lower to the result struct — undo nothing (we already
    // emitted it); coerce/return a sensible f64 fallback.
    if (recvType !== null) fctx.body.push({ op: "drop" } as Instr);
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    return { kind: "f64" };
  }

  // #1482 — `process.env.X` under `--target wasi`. Short-circuit BEFORE the
  // generic `__extern_get` host-import path: the standalone WASI module has
  // no `process` global, and even with a JS polyfill the generic extern lookup
  // path wouldn't know how to route through the WASI environ table. Lower to
  // a host-import call `__wasi_env_get_str(<key>) -> externref` (registered by
  // `registerWasiImports` when usage is detected). The JS polyfill supplies a
  // `(key) => process.env[key]` shim; a future pure-WASI implementation can
  // replace the host import with an inline call to `environ_get`.
  if (
    ctx.wasi &&
    ctx.wasiEnvGetStrIdx >= 0 &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "process" &&
    expr.expression.name.text === "env"
  ) {
    // Push the property name as an externref string (NativeString → externref).
    const keyType = compileStringLiteral(ctx, fctx, propName);
    if (keyType && keyType.kind !== "externref") {
      coerceType(ctx, fctx, keyType, { kind: "externref" });
    }
    fctx.body.push({ op: "call", funcIdx: ctx.wasiEnvGetStrIdx });
    return { kind: "externref" };
  }

  // (#1104 Phase 2) WASI/standalone-mode native Error property access.
  //
  // When the LHS TypeScript type resolves to a built-in Error subclass
  // (Error, TypeError, RangeError, SyntaxError, URIError, EvalError,
  // ReferenceError, AggregateError) and the property is `message` or `name`,
  // emit a direct `struct.get $Error_struct <field>` instead of falling
  // through to the generic `__extern_get` host-import path. The host import
  // is unavailable in standalone mode, so without this fast path
  // `error.message` traps at instantiation time. JS-host mode is unchanged
  // — the fast path is gated on `ctx.wasi`.
  //
  // Field layout in `$Error_struct` (registered by emitWasiErrorConstructor):
  //   0: tag      (i32)        — from BUILTIN_TYPE_TAGS, drives Phase 3 instanceof
  //   1: message  (mut externref) — populated by ctor's first arg
  //   2: name     (externref)   — Phase 1 placeholder (ref.null extern)
  //
  // The struct is converted to externref via `extern.convert_any` at
  // construction time, so call sites see externref. To read the field we
  // round-trip through anyref: `any.convert_extern + ref.cast (ref
  // $Error_struct) + struct.get`. If the receiver is already null at
  // runtime, `ref.cast` traps — but native JS has the same behaviour
  // (`null.message` throws), so the trap is acceptable Phase 1/2 semantics.
  if ((ctx.wasi || ctx.standalone) && (propName === "message" || propName === "name" || propName === "stack")) {
    const lhsTsName = objType.getSymbol()?.name;
    // (#1536c) A user subclass of a built-in Error (`class MyError extends
    // Error {}`) is externref-backed; its instance is the parent's
    // `$Error_struct` (created natively by `__new_<Parent>`). Treat it as an
    // Error LHS so `.message`/`.name`/`.stack` read the struct field directly
    // instead of the generic `__extern_get` host path (unavailable standalone,
    // returns null). The struct field layout is the parent's.
    const lhsUserErrorParent =
      lhsTsName !== undefined && !isBuiltinTypeName(lhsTsName) ? ctx.classBuiltinParentMap.get(lhsTsName) : undefined;
    const isErrorLhs =
      (lhsTsName !== undefined &&
        isBuiltinTypeName(lhsTsName) &&
        isWasiErrorName(lhsTsName) &&
        isBuiltinSubtype(lhsTsName, "Error")) ||
      (lhsUserErrorParent !== undefined && (lhsUserErrorParent === "Error" || isWasiErrorName(lhsUserErrorParent)));
    // #2077: a `catch (e)` binding is typed `any` (or `unknown`), so the static
    // `isErrorLhs` gate above never fires even though the caught value IS the
    // `$Error` struct at runtime — the field read then fell through to the
    // generic `__extern_get` host path, which returns null in standalone mode
    // (no host). For such a binding, emit a runtime `ref.test $Error`–guarded
    // read instead of trusting the static type.
    //
    // CRITICAL scope (#2077 regression fix): this guard MUST be restricted to a
    // `catch`-clause binding, NOT every `any`/`unknown` receiver. A general
    // `const o: any = { message: "x" }` reads `o.message` through the normal
    // object-property path (which works in standalone); hijacking ALL
    // `any.message`/`any.name` reads with the `$Error` guard made the non-Error
    // `else` arm return a null string, so `o.message.length` trapped
    // (null deref) on plain objects. Gating on the catch binding keeps the
    // common plain-object read on its working generic path and applies the
    // `$Error` guard only where the value genuinely originates from a `throw`.
    const isCatchBindingReceiver = receiverIsCatchClauseBinding(ctx, expr.expression);
    const isErrorLikeRuntimeLhs =
      !isErrorLhs && isCatchBindingReceiver && (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    if (isErrorLhs || isErrorLikeRuntimeLhs) {
      const structIdx = getOrRegisterErrorStructType(ctx);
      // $Error_struct field layout: 1=message, 2=name, 3=stack (#1536).
      const fieldIdx = propName === "message" ? 1 : propName === "name" ? 2 : 3;
      // Compile receiver. Mirror the standalone instanceof lowering
      // (identifiers.ts): compile WITHOUT forcing externref, then coerce, so a
      // catch-binding externref holding an `$Error` struct keeps its identity
      // through `any.convert_extern` + `ref.test` (forcing externref as the
      // expected type re-boxed the value and broke the ref.test — #2077).
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult && objResult.kind !== "externref") {
        coerceType(ctx, fctx, objResult, { kind: "externref" });
      } else if (!objResult) {
        fctx.body.push({ op: "ref.null.extern" } as Instr);
      }
      fctx.body.push({ op: "any.convert_extern" } as Instr);

      // The `$Error_struct` message/name fields are stored as `externref`
      // (populated by the ctor via `extern.convert_any` over a native
      // string). In nativeStrings/WASI mode every other string producer hands
      // consumers a `$AnyString` ref, so coerce here once and return that ref
      // type. Otherwise the externref result flows into native string ops
      // (`=== `, `.length`, concat, interpolation) that expect `(ref null
      // $AnyString)`, and the per-consumer externref→string coercion either
      // misfires or is skipped → invalid Wasm (#1797).
      const resultType: ValType =
        ctx.nativeStrings && ctx.anyStrTypeIdx >= 0
          ? { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx }
          : { kind: "externref" };

      if (isErrorLhs) {
        // Static Error type — the value is always an `$Error` struct, so cast
        // unconditionally (a runtime non-Error would mean a miscompile elsewhere).
        fctx.body.push({ op: "ref.cast", typeIdx: structIdx } as Instr);
        fctx.body.push({ op: "struct.get", typeIdx: structIdx, fieldIdx } as Instr);
        if (resultType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, resultType);
        return resultType;
      }

      // #2077 — `any`/`unknown` receiver (the common `catch (e)` case). The
      // anyref is on the stack. Guard with `ref.test $Error`: when it IS an
      // `$Error` struct, cast + read the field + coerce to the native string
      // ref; otherwise produce a null string (a non-Error value, e.g.
      // `throw "str"`, has no struct field to read). The whole read — including
      // the externref→string coercion — lives in the `then` arm so a non-Error
      // never executes a struct.get/cast. Mirrors the instanceof guard in
      // identifiers.ts, which proves the caught struct is recoverable here.
      const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
      fctx.body.push({ op: "local.set", index: tmpAny } as Instr);
      fctx.body.push({ op: "local.get", index: tmpAny } as Instr);
      fctx.body.push({ op: "ref.test", typeIdx: structIdx } as Instr);
      // Build the `then` arm (read + coerce) into a swapped body buffer so
      // coerceType's appends land in the arm, not the main body.
      const savedBody = fctx.body;
      fctx.body = [];
      fctx.body.push({ op: "local.get", index: tmpAny } as Instr);
      fctx.body.push({ op: "ref.cast", typeIdx: structIdx } as Instr);
      fctx.body.push({ op: "struct.get", typeIdx: structIdx, fieldIdx } as Instr);
      if (resultType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, resultType);
      const thenInstrs = fctx.body;
      fctx.body = savedBody;
      const elseInstrs: Instr[] =
        resultType.kind === "externref"
          ? [{ op: "ref.null.extern" } as Instr]
          : [{ op: "ref.null", typeIdx: (resultType as { typeIdx: number }).typeIdx } as Instr];
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: thenInstrs,
        else: elseInstrs,
      } as Instr);
      releaseTempLocal(fctx, tmpAny);
      return resultType;
    }
  }

  // #1365 — Private-name read with spec-compliant brand check.
  //
  // Per ES2022 §15.7 (PrivateFieldGet / PrivateBrandCheck): when reading
  // `obj.#x`, if `obj` lacks the brand of the class that declared `#x`,
  // throw a TypeError. Today the generic property-access path falls
  // through to alternate-struct lookup (which can read `__priv_x` from a
  // DIFFERENT class with the same field-name layout) or to `__extern_get`
  // (which silently returns undefined). Both violate the brand-tied
  // semantics of private names.
  //
  // Implementation: when the property name is a PrivateIdentifier, resolve
  // the lexically-declaring class via parent-chain walk. Compile the
  // receiver, ref.test it against the declaring class's struct, and on
  // failure throw a real TypeError instance (so `assert.throws(TypeError,
  // ...)` passes). On success, ref.cast + struct.get the field.
  //
  // Skips the brand check for:
  //   - `super.#x` — handled by the super branch below; super already
  //     guarantees the right brand structurally.
  //   - PrivateIdentifier accesses inside the class body where
  //     `expr.expression.kind === ThisKeyword` AND the local `this` is
  //     known to be the class struct ref — the legacy struct.get is
  //     correct in that case (TS guarantees the brand, no runtime check
  //     needed). The brand check fires only when the receiver type may
  //     differ from the declaring class.
  if (ts.isPrivateIdentifier(expr.name) && expr.expression.kind !== ts.SyntaxKind.SuperKeyword) {
    const declared = resolveDeclaringClassForPrivateName(ctx, expr.name);
    if (declared) {
      const fieldIdx = ctx.structFields.get(declared.className)!.findIndex((f) => f.name === declared.fieldName);
      if (fieldIdx >= 0) {
        const fieldType = ctx.structFields.get(declared.className)![fieldIdx]!.type;
        // Compile the receiver. Branch by what we got back — class refs
        // emit ref.test directly; externref needs any.convert_extern first.
        const objResult = compileExpression(ctx, fctx, expr.expression);
        // Save the receiver value so we can emit ref.test, then optionally
        // ref.cast against the brand. Use anyref as the saved type so we
        // can hold class-refs and externrefs uniformly.
        const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
        if (objResult?.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" } as Instr);
        }
        fctx.body.push({ op: "local.set", index: tmpAny });
        emitPrivateBrandPredicate(ctx, fctx, tmpAny, declared.className, declared.structTypeIdx);
        // result-type block: on success, return the field value; on
        // failure, throw TypeError (which doesn't return).
        const successInstrs: Instr[] = [
          { op: "local.get", index: tmpAny } as Instr,
          { op: "ref.cast", typeIdx: declared.structTypeIdx } as Instr,
          { op: "struct.get", typeIdx: declared.structTypeIdx, fieldIdx } as Instr,
        ];
        // Capture failure-path instrs by emitting into a saved body buffer.
        const savedBody = fctx.body;
        fctx.body = [];
        const message = `Cannot read private member #${expr.name.text.slice(1)} from an object whose class did not declare it`;
        emitThrowTypeError(ctx, fctx, message);
        const failureInstrs = fctx.body;
        fctx.body = savedBody;
        // Wrap in `if` returning fieldType. The `else` (failure) branch
        // ends with `throw`, which is unreachable per Wasm typing, so the
        // block's result type is satisfied by the `then` arm only.
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: fieldType },
          then: successInstrs,
          else: failureInstrs,
        } as Instr);
        releaseTempLocal(fctx, tmpAny);
        return fieldType;
      }
    }
    // #1680 — Brand check for private *accessor* (getter) and *method*
    // reads. The field path above only fires for struct-backed private
    // fields; a `get #m()` / `#m() {}` member is registered in
    // classAccessorSet / classMethodSet, not structFields, so `declared`
    // is undefined (or fieldIdx < 0) and the field path is skipped.
    //
    // Per ES2022 §15.7 PrivateFieldGet step 4 (PrivateBrandCheck): reading
    // `o.#m` when `o` lacks the brand of the declaring class throws a
    // TypeError. Without this, the generic getter dispatch below calls the
    // getter with a wrong-brand receiver and silently misbehaves (test262
    // private-{getter,method}-brand-check cases).
    //
    // We emit the same ref.test guard as the field path, then on success
    // dispatch the getter call (accessor) or return the brand-checked
    // receiver as a value (method-as-value). Skipped when the receiver is
    // `this` inside the declaring class body — TS guarantees the brand.
    const cls = classifyPrivateMember(ctx, expr.name);
    if (
      cls &&
      (cls.kind === "method" || cls.kind === "accessor" || cls.kind === "accessor-readonly") &&
      expr.expression.kind !== ts.SyntaxKind.ThisKeyword
    ) {
      const structTypeIdx = ctx.structMap.get(cls.className);
      const getterName = `${cls.className}_get_${cls.fieldName}`;
      const canEmit =
        structTypeIdx !== undefined && (cls.kind === "method" || ctx.funcMap.has(classMemberFuncKey(ctx, getterName)));
      if (canEmit) {
        const objResult = compileExpression(ctx, fctx, expr.expression);
        const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
        if (objResult?.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" } as Instr);
        }
        fctx.body.push({ op: "local.set", index: tmpAny });
        emitPrivateBrandPredicate(ctx, fctx, tmpAny, cls.className, structTypeIdx!);

        // Build the failure (throw) branch FIRST. emitThrowTypeError may
        // register late imports, which shift every funcMap index (the
        // getter's included). Settling those shifts before we read the
        // getter funcIdx keeps the `call` target correct — the same reason
        // the field path above only emits struct.get (immune to shifts).
        const savedBody = fctx.body;
        fctx.body = [];
        const message = `Cannot read private member #${expr.name.text.slice(1)} from an object whose class did not declare it`;
        emitThrowTypeError(ctx, fctx, message);
        const failureInstrs = fctx.body;
        fctx.body = savedBody;

        // Success path: cast to the declaring struct, then either call the
        // getter (accessor) or return the receiver itself (method value).
        const successInstrs: Instr[] = [
          { op: "local.get", index: tmpAny } as Instr,
          { op: "ref.cast", typeIdx: structTypeIdx! } as Instr,
        ];
        let resultKind: ValType;
        if (cls.kind === "method") {
          // Reading a private method as a value: the brand-checked receiver
          // is returned as an externref view. The spec only mandates the
          // brand check throws on a wrong receiver here; `o.#m()` call sites
          // go through calls.ts, not this read path.
          successInstrs.push({ op: "extern.convert_any" } as Instr);
          resultKind = { kind: "externref" };
        } else {
          // Resolve the getter funcIdx AFTER the throw branch settled imports.
          const getterIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName))!;
          successInstrs.push({ op: "call", funcIdx: getterIdx });
          const funcDef = ctx.mod.functions[getterIdx - ctx.numImportFuncs];
          const typeDef = funcDef ? ctx.mod.types[funcDef.typeIdx] : undefined;
          resultKind =
            typeDef && typeDef.kind === "func" && typeDef.results.length > 0
              ? typeDef.results[0]!
              : { kind: "externref" };
        }

        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: resultKind },
          then: successInstrs,
          else: failureInstrs,
        } as Instr);
        releaseTempLocal(fctx, tmpAny);
        return resultKind;
      }
    }
    // Resolver failure (no enclosing class declares this private name).
    // Fall through to the generic path; it will throw via the existing
    // alternate / __extern_get fallbacks. This shouldn't happen for
    // well-formed source code.
  }

  // Handle super.prop — access parent class property/getter on current `this`
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return compileSuperPropertyAccess(ctx, fctx, expr, propName);
  }

  // Handle import.meta.url and other import.meta properties
  if (
    ts.isMetaProperty(expr.expression) &&
    expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expr.expression.name.text === "meta"
  ) {
    if (propName === "url") {
      // #1494 — Bind to the host's `import.meta.url` (passed by the generated
      // loader via deps.importMetaUrl). Falls back to undefined when no
      // loader is present.
      const funcIdx = ensureLateImport(ctx, "__get_import_meta_url", [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      // Fallback when the host import couldn't be registered.
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    // For any other import.meta property, return undefined
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle globalThis.prop — compile as __extern_get(__get_globalThis(), key)
  // globalThis is a genuine JS object (externref), not a WasmGC struct.
  // Without this handler, the TS type `typeof globalThis` resolves to a struct
  // type and struct.get on a real JS object traps with null deref.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "globalThis") {
    const gtFuncIdx = ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
    // Ensure __extern_get import exists
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);

    if (gtFuncIdx === undefined || getIdx === undefined) {
      // Fallback: return null externref if imports couldn't be registered
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Emit: __extern_get(__get_globalThis(), key) -> externref
    fctx.body.push({ op: "call", funcIdx: gtFuncIdx });
    addStringConstantGlobal(ctx, propName);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
    if (getIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: getIdx });
    }

    // Coerce externref to expected type
    const accessType = ctx.checker.getTypeAtLocation(expr);
    const accessWasm = resolveWasmType(ctx, accessType);
    if (accessWasm.kind === "f64") {
      const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, fctx);
      if (unboxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: unboxIdx });
      }
      return { kind: "f64" };
    }
    if (accessWasm.kind === "i32") {
      const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, fctx);
      if (unboxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: unboxIdx });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      return { kind: "i32" };
    }
    return { kind: "externref" };
  }

  // (#1490) Non-WASI Node.js host mode: process.argv / process.env / process.platform.
  // These are JS host imports that read from the live Node process at runtime.
  // The local `process` identifier must not be shadowed by a local variable.
  // In WASI mode, `process.env` is handled separately via WASI environ (#1482),
  // so this path is gated on !ctx.wasi.
  if (!ctx.wasi && ts.isIdentifier(expr.expression) && expr.expression.text === "process") {
    const isShadowed = fctx.localMap.has("process") || (fctx.boxedCaptures?.has("process") ?? false);
    if (!isShadowed) {
      const procProp = propName;
      let hostImport: string | undefined;
      if (procProp === "argv") hostImport = "__get_process_argv";
      else if (procProp === "env") hostImport = "__get_process_env";
      else if (procProp === "platform") hostImport = "__get_process_platform";
      else if (procProp === "arch") hostImport = "__get_process_arch";
      if (hostImport !== undefined) {
        const idx = ensureLateImport(ctx, hostImport, [], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (idx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: idx });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        return { kind: "externref" };
      }
    }
  }

  // Handle BuiltIn.prop where BuiltIn is a known global constructor/namespace (String, Number,
  // Boolean, Math, Object, Array, etc.) that would otherwise compile to ref.null.extern.
  // Examples: String.prototype, Number.prototype, Boolean.prototype, Math.abs, Array.isArray.
  // Use __get_builtin(name) to get the real JS object, then __extern_get(ref, prop).
  // Skip if the name is shadowed by a local variable.
  if (ts.isIdentifier(expr.expression)) {
    const builtinName = expr.expression.text;
    const isShadowed = fctx.localMap.has(builtinName) || (fctx.boxedCaptures?.has(builtinName) ?? false);
    // (#1888 S6-c) Under --target standalone, `__get_builtin` refuses-loud (the
    // open-object runtime does not expose it). For builtin constant reads that
    // already have a pure-Wasm fall-through emitter below (Math.PI →
    // `f64.const`, Number.MAX_SAFE_INTEGER → `f64.const`, Symbol.iterator →
    // `i32.const`), this shortcut would pre-empt that native lowering and turn a
    // compilable program into a hard refusal. Skip it for those (builtin, prop)
    // pairs so control reaches the constant emitter. gc/host is unaffected
    // (`__get_builtin` is a real host import there and the early shortcut +
    // the later constant handler are observationally identical for these reads).
    const deferToNativeConstant = ctx.standalone && hasNativeBuiltinConstantHandler(builtinName, propName);
    if (ctx.standalone && BUILTIN_CTOR_NAMES.has(builtinName) && !isShadowed && !deferToNativeConstant) {
      // (#2175 S1) `<Builtin>.prototype` as a value → the native `$NativeProto`
      // object (host-free), for builtins with a registered brand. This is the
      // inner read every reflective form (`RegExp.prototype.test`,
      // `.flags`-getter via descriptor, `[Symbol.match]`) chains off of — it
      // refused at this exact site pre-#2175. Reaches `emitLazyNativeProtoGet`
      // instead of the refusal.
      if (propName === "prototype") {
        const protoBrand = tryEnsureNativeProtoBrand(ctx, builtinName);
        if (protoBrand !== undefined && emitLazyNativeProtoGet(ctx, fctx, protoBrand)) {
          return { kind: "externref" };
        }
      }
      const closure = ensureStandaloneBuiltinStaticMethodClosure(ctx, builtinName, propName, expr);
      if (closure) {
        fctx.body.push({ op: "ref.func", funcIdx: closure.funcIdx });
        fctx.body.push({ op: "struct.new", typeIdx: closure.type.typeIdx });
        return closure.type;
      }
      reportUnsupportedStandaloneBuiltinValueRead(ctx, builtinName, propName);
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    if (BUILTIN_CTOR_NAMES.has(builtinName) && !isShadowed && !deferToNativeConstant) {
      const getBuiltinIdx = ensureLateImport(ctx, "__get_builtin", [{ kind: "externref" }], [{ kind: "externref" }]);
      const getIdx = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (getBuiltinIdx !== undefined && getIdx !== undefined) {
        // Push builtin name string, call __get_builtin to get the real JS object
        addStringConstantGlobal(ctx, builtinName);
        fctx.body.push(...stringConstantExternrefInstrs(ctx, builtinName));
        fctx.body.push({ op: "call", funcIdx: getBuiltinIdx });
        // Push property name string, call __extern_get to read the property
        addStringConstantGlobal(ctx, propName);
        fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
        fctx.body.push({ op: "call", funcIdx: getIdx });
        return { kind: "externref" };
      }
    }
  }

  // Check for enum member access: EnumName.Member
  if (ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    const enumKey = `${objName}.${propName}`;
    const enumVal = ctx.enumValues.get(enumKey);
    if (enumVal !== undefined) {
      fctx.body.push({ op: "f64.const", value: enumVal });
      return { kind: "f64" };
    }
    // Check for string enum member access
    const enumStrVal = ctx.enumStringValues.get(enumKey);
    if (enumStrVal !== undefined) {
      return compileStringLiteral(ctx, fctx, enumStrVal);
    }

    // (#1639) `g.prototype` where `g` is a generator-function declaration must
    // return `%GeneratorPrototype%` (the object whose `next`/`return`/`throw`
    // carry the brand check). The compiled closure backing a `function*` is
    // opaque to the host, so resolve the member access statically here by
    // routing to a dedicated runtime import. Tests reach
    // `%AsyncIteratorPrototype%` via `getPrototypeOf(getPrototypeOf(g.prototype))`.
    if (propName === "prototype" && ctx.generatorFunctions.has(objName)) {
      const sym = ctx.checker.getSymbolAtLocation(expr.expression);
      const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
      const isAsyncGen =
        !!decl &&
        (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl)) &&
        decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
      const helperName = isAsyncGen ? "__get_async_generator_prototype" : "__get_generator_prototype";
      const helperIdx = ensureLateImport(ctx, helperName, [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (helperIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: helperIdx });
        return { kind: "externref" };
      }
      // Standalone mode (no host): fall through to legacy path.
    }
  }

  // Check for static property access via 'this' in a static method context.
  // In a static method, 'this' refers to the class constructor (no local 'this' param).
  // e.g., `this.#m` in `static fieldAccess()` where `#m` is a static private field.
  //
  // (#1681) Also fire inside a closure spawned from a static context: an arrow
  // function or inner function declared in a static method captures `this` as a
  // local, so `localMap.get("this")` is defined — but `this` still denotes the
  // class constructor, not a per-instance struct. Without the static-context
  // escape hatch the generic struct path below tries to cast the captured
  // externref `this` to the class struct and emits an invalid
  // `extern.convert_any` / re-enters the accessor trampoline (#1681 RUNFAIL
  // bucket). `fctx.isStaticContext` is propagated through closure spawning, so
  // it identifies exactly this case.
  // #2027: `(this as any).a` / `(this).a` in a static initializer must reach
  // this static-`this` arm too. The receiver is wrapped in an AsExpression /
  // ParenthesizedExpression, so match on the unwrapped form rather than the
  // literal `ThisKeyword` node kind. Plain `this.a` already matched.
  if (
    skipTransparentExpressions(expr.expression).kind === ts.SyntaxKind.ThisKeyword &&
    (fctx.localMap.get("this") === undefined || fctx.isStaticContext)
  ) {
    // Resolve the enclosing class name from context.
    // Try enclosingClassName first (set for closures), then scan the function name
    // for a class name prefix by checking each underscore-delimited prefix against classSet.
    // This handles both simple names ("C_method") and names like "__anonClass_0_method".
    let enclosingClass: string | undefined = fctx.enclosingClassName;
    if (!enclosingClass) {
      const fname = fctx.name;
      let pos = -1;
      while (!enclosingClass) {
        pos = fname.indexOf("_", pos + 1);
        if (pos < 0) break;
        const candidate = fname.substring(0, pos);
        if (candidate && ctx.classSet.has(candidate)) enclosingClass = candidate;
      }
    }
    if (enclosingClass) {
      const fullName = `${enclosingClass}_${propName}`;
      const globalIdx = ctx.staticProps.get(fullName);
      if (globalIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: globalIdx });
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        return globalDef?.type ?? { kind: "externref" };
      }
      // Static getter access: `this.#f` or `this.g` where the property is a
      // static accessor. Invoke the getter with a dummy `this` — static
      // getters don't read `this` since the backing store is a module global.
      // Without this handler the generic path below compiles `this` →
      // emitUndefined → externref and tries to cast to the class struct,
      // which traps uncatchably (PR #203 follow-up for class/elements TRAP
      // bucket).
      const accessorKey = `${enclosingClass}_${propName}`;
      if (ctx.staticAccessorSet.has(accessorKey)) {
        const getterName = `${enclosingClass}_get_${propName}`;
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName));
        if (funcIdx !== undefined) {
          const retType = emitGetterCallWithDummy(ctx, fctx, enclosingClass, getterName, funcIdx);
          if (retType) return retType;
        }
      }
      // Static method accessed as value: `this.#m` or `this.m` where `m` is a
      // static method. Return `ref.null.extern` as a non-callable placeholder
      // (same as ClassName.method path at line 992) — avoids generic
      // fallthrough cast of undefined.
      if (ctx.staticMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
    }
  }

  // Check for static property access: ClassName.staticProp
  // #2020: unwrap outer expressions so `(B as any).count` / `(B).count` still
  // resolve the receiver to the class identifier `B`. A cast to `any` otherwise
  // hides the Identifier and the static-field lookup (incl. the inherited-field
  // parent walk below) is skipped, falling through to the dynamic any path.
  const staticReceiver = skipTransparentExpressions(expr.expression);
  if (ts.isIdentifier(staticReceiver)) {
    const objName = staticReceiver.text;

    // (#1639) `genFn.prototype` where `genFn` is a `function*` / `async function*`
    // declaration must return the intrinsic `%GeneratorPrototype%` /
    // `%AsyncGeneratorPrototype%` (= `%GeneratorFunction.prototype%.prototype`).
    // The compiled closure backing the generator is opaque to the host, so we
    // route the member access through a dedicated runtime import — mirroring the
    // `Object.getPrototypeOf(genFn)` handling in calls.ts. Tests rely on the
    // resulting chain: `Object.getPrototypeOf(Object.getPrototypeOf(g.prototype))`
    // === `%(Async)IteratorPrototype%`.
    if (propName === "prototype" && ctx.generatorFunctions.has(objName)) {
      let isAsyncGen = false;
      const sym = ctx.checker.getSymbolAtLocation(expr.expression);
      const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
      if (decl && (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl))) {
        isAsyncGen = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
      }
      const helperName = isAsyncGen ? "__get_async_generator_prototype" : "__get_generator_prototype";
      const helperIdx = ensureLateImport(ctx, helperName, [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (helperIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: helperIdx });
        return { kind: "externref" };
      }
      // Standalone mode (no host import): fall through to legacy handling.
    }

    // Resolve class expressions (var C = class {}) through the expr-name map
    const resolvedClass = ctx.classExprNameMap.get(objName) ?? objName;
    if (ctx.classSet.has(resolvedClass)) {
      const fullName = `${resolvedClass}_${propName}`;
      // #2020: static fields are inherited. `class B extends A {}; B.count`
      // resolves to A's `A_count` global. The own-class lookup misses, so walk
      // the parent chain (classParentMap) retrying `<Ancestor>_<prop>` — own
      // statics still shadow because the own lookup runs first.
      const globalIdx = ctx.staticProps.get(fullName) ?? resolveInheritedStaticProp(ctx, resolvedClass, propName);
      if (globalIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: globalIdx });
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        return globalDef?.type ?? { kind: "f64" };
      }
      // ClassName.prototype — return a singleton prototype global (externref)
      // so that Object.getPrototypeOf(instance) === ClassName.prototype holds.
      if (propName === "prototype") {
        if (emitLazyProtoGet(ctx, fctx, resolvedClass)) {
          return { kind: "externref" };
        }
        // Fallback: return null externref
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      // ClassName.constructor — return the constructor function reference
      if (propName === "constructor") {
        const ctorName = `${resolvedClass}_constructor`;
        const funcIdx = ctx.funcMap.get(ctorName);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "ref.func", funcIdx });
          fctx.body.push({ op: "extern.convert_any" });
          return { kind: "externref" };
        }
        // Fallback: return null externref
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      // ClassName.staticMethod — return a callable closure-struct externref.
      //
      // (#1388) Previously emitted `ref.null.extern` because funcref isn't a
      // subtype of anyref. Now we wrap the static method in a closure struct
      // (struct.new with a funcref field) via `emitFuncRefAsClosure`, then
      // convert the struct ref to externref with `extern.convert_any`.
      //
      // The call site (calls.ts:5380) sees a callable variable, casts the
      // externref back to the matching closure struct type, and dispatches
      // via `call_ref` through a trampoline. This makes the detached pattern
      // `const gen = C.staticMethod; gen()` actually invoke the method,
      // unblocking 273 test262 cases for class async-generator yield-star
      // tests that follow this exact extraction pattern.
      if (ctx.staticMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
        if (funcIdx !== undefined) {
          const closureRef = emitFuncRefAsClosure(ctx, fctx, fullName, funcIdx);
          if (closureRef) {
            fctx.body.push({ op: "extern.convert_any" });
            return { kind: "externref" };
          }
          // Fallback if closure construction fails for any reason
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
      // Instance method accessed as `ClassName.method` (without prototype) —
      // unusual; keep the legacy null placeholder to preserve existing behavior.
      if (ctx.classMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
      // ClassName.accessor — invoke static getter (#848)
      const accessorKey = `${resolvedClass}_${propName}`;
      if (ctx.classAccessorSet.has(accessorKey)) {
        const getterName = `${resolvedClass}_get_${propName}`;
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName));
        if (funcIdx !== undefined) {
          const retType = emitGetterCallWithDummy(ctx, fctx, resolvedClass, getterName, funcIdx);
          return retType ?? { kind: "externref" };
        }
      }
    }
  }

  // (#1394) `ClassName.prototype.<method>` — emit a cached singleton
  // closure-struct externref. The previous PR #294 emitted a fresh
  // closure on every access, breaking the `c.m === C.prototype.m`
  // identity assertion that 478 class/elements tests verify. The cache
  // (one externref global per `${className}_${methodName}`, lazily
  // initialised on first access) gives stable identity AND restores
  // the +120 wins on instance-method-via-prototype yield-star
  // extractions that PR #305's revert lost.
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.name.text === "prototype"
  ) {
    const rawName = expr.expression.expression.text;
    const className = ctx.classExprNameMap.get(rawName) ?? rawName;
    if (ctx.classSet.has(className)) {
      const fullName = `${className}_${propName}`;
      // Only intercept actual instance methods. Skip static methods
      // (they live on the constructor, not the prototype) and
      // accessors (handled by the existing accessor path below).
      if (ctx.classMethodSet.has(fullName) && !ctx.staticMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
        const structTypeIdx = ctx.structMap.get(className);
        if (funcIdx !== undefined && structTypeIdx !== undefined) {
          if (emitCachedMethodClosureAccess(ctx, fctx, fullName, funcIdx, structTypeIdx)) {
            return { kind: "externref" };
          }
        }
      }
    }
  }

  // Handle Math.<method>.length — static function arity
  if (
    propName === "length" &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Math"
  ) {
    const mathMethodArity: Record<string, number> = {
      abs: 1,
      ceil: 1,
      floor: 1,
      round: 1,
      trunc: 1,
      sign: 1,
      sqrt: 1,
      cbrt: 1,
      clz32: 1,
      fround: 1,
      exp: 1,
      expm1: 1,
      log: 1,
      log2: 1,
      log10: 1,
      log1p: 1,
      sin: 1,
      cos: 1,
      tan: 1,
      asin: 1,
      acos: 1,
      atan: 1,
      sinh: 1,
      cosh: 1,
      tanh: 1,
      asinh: 1,
      acosh: 1,
      atanh: 1,
      min: 2,
      max: 2,
      pow: 2,
      atan2: 2,
      imul: 2,
      hypot: 2,
      random: 0,
    };
    const method = expr.expression.name.text;
    if (method in mathMethodArity) {
      fctx.body.push({ op: "f64.const", value: mathMethodArity[method]! });
      return { kind: "f64" };
    }
  }

  // Handle Function.length — return the number of formal parameters
  if (propName === "length") {
    // (#1632a) `.length` on the result of `.bind(...)` must NOT be statically
    // resolved to the target's param count — per spec it's
    // `max(0, target.length - boundArgs.length)`. Fall through to the
    // externref / __extern_get path so the host-bound function's actual
    // `.length` is read.
    const isBindResult = isBindResultExpr(ctx, expr.expression);
    const callSigs = objType.getCallSignatures?.();
    const constructSigs2 = objType.getConstructSignatures?.();
    const lengthSigs =
      callSigs && callSigs.length > 0 ? callSigs : constructSigs2 && constructSigs2.length > 0 ? constructSigs2 : null;
    if (!isBindResult && lengthSigs && lengthSigs.length > 0) {
      // For library/ambient functions, TS's param count can disagree with the
      // runtime Function.length — the ES spec pins .length for methods like
      // Array.prototype.toSorted to 1 even though the lib d.ts declares
      // compareFn as optional ("?"). Defer to __extern_get("length") so the
      // runtime value wins — but only when the root identifier of the chain
      // is a known reachable global (BUILTIN_CTOR_NAMES / globalThis). Bare
      // lib identifiers like `encodeURIComponent` or `DisposableStack` don't
      // have a runtime externref binding, so __extern_get would throw.
      const isLibrarySig = lengthSigs.some((s) => {
        const decl = s.getDeclaration?.();
        return decl?.getSourceFile().isDeclarationFile === true;
      });
      const BUILTIN_GLOBAL_ROOTS = new Set([
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
        "globalThis",
      ]);
      let rootNode: ts.Expression = expr.expression;
      while (ts.isPropertyAccessExpression(rootNode) || ts.isElementAccessExpression(rootNode)) {
        rootNode = rootNode.expression;
      }
      const rootIsReachableBuiltin =
        ts.isIdentifier(rootNode) &&
        BUILTIN_GLOBAL_ROOTS.has(rootNode.text) &&
        !fctx.localMap.has(rootNode.text) &&
        !(fctx.boxedCaptures?.has(rootNode.text) ?? false);
      if (!isLibrarySig || !rootIsReachableBuiltin) {
        // ES spec: Function.length = number of required params before first
        // optional/default/rest. TS forbids required-after-optional, so filtering
        // out optional/default/rest is equivalent to iterating until the first one.
        const sig = lengthSigs[0]!;
        const paramCount = sig.parameters.filter((p: any) => {
          const decl = p.valueDeclaration;
          if (!decl || !ts.isParameter(decl)) return true;
          return !decl.dotDotDotToken && !decl.questionToken && !decl.initializer;
        }).length;
        fctx.body.push({ op: "f64.const", value: paramCount });
        return { kind: "f64" };
      }
      // Library signature rooted at a reachable builtin → fall through to
      // externref / __extern_get path below.
    }
  }

  // Handle Function.name — return the function name as a string
  if (propName === "name") {
    // (#1632a) `.name` on the result of `.bind(...)` must NOT be statically
    // resolved to the target's symbol name — per spec it's `"bound " +
    // target.name`. Fall through to the runtime __extern_get path so the
    // host-bound function's actual `.name` property is read.
    if (isBindResultExpr(ctx, expr.expression)) {
      // Skip the static peephole entirely; fall through to the externref
      // property-access path below. Covers both `fn.bind(...).name` and the
      // deferred `const g = fn.bind(...); g.name` form (#1337).
    } else {
      const callSigs = objType.getCallSignatures?.();
      const constructSigs = objType.getConstructSignatures?.();
      const hasFuncSig = (callSigs && callSigs.length > 0) || (constructSigs && constructSigs.length > 0);
      // (#1450) Even when the static type lacks call/construct signatures
      // (catch parameter `any`, destructuring assignment target widened to
      // contextual type, etc.), spec NamedEvaluation still applies if the
      // identifier's binding declaration has an anonymous-fn / named-fn /
      // class initializer. Pre-resolve here so destructuring patterns like
      //   try {} catch ([fn = function(){}]) { fn.name }
      // fold to the binding identifier text instead of the externref miss.
      if (!hasFuncSig && ts.isIdentifier(expr.expression)) {
        const sym = ctx.checker.getSymbolAtLocation(expr.expression);
        const decl = sym?.valueDeclaration;
        if (decl && (ts.isBindingElement(decl) || ts.isVariableDeclaration(decl)) && decl.initializer) {
          let initExpr: ts.Expression = decl.initializer;
          while (ts.isParenthesizedExpression(initExpr)) initExpr = initExpr.expression;
          let resolvedName: string | undefined;
          if (isAnonymousFunctionDefinition(decl.initializer)) {
            // SingleNameBinding NamedEvaluation: anonymous fn/class inherits
            // the binding identifier's text as its .name.
            resolvedName = expr.expression.text;
          } else if (ts.isFunctionExpression(initExpr) && initExpr.name) {
            // Named function expression keeps its own name (the binding
            // identifier is ignored per spec).
            resolvedName = initExpr.name.text;
          } else if (ts.isClassExpression(initExpr) && initExpr.name) {
            resolvedName = initExpr.name.text;
          }
          if (resolvedName !== undefined) {
            addStringConstantGlobal(ctx, resolvedName);
            return compileStringLiteral(ctx, fctx, resolvedName);
          }
        }
      }
      if (hasFuncSig) {
        // Resolve the function name from the type symbol or the expression
        let funcName = objType.getSymbol()?.name ?? "";
        // __type, __function, __class, __object are anonymous type names from TS checker
        if (funcName === "__type" || funcName === "__function" || funcName === "__class" || funcName === "__object")
          funcName = "";
        // Built-in globals declared as `declare var X: XConstructor` expose the
        // interface name ("ArrayConstructor") as the type symbol, but the JS
        // runtime `.name` is the declared identifier ("Array"). Strip the
        // "Constructor" suffix when it matches the identifier text.
        if (
          funcName.endsWith("Constructor") &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text + "Constructor" === funcName
        ) {
          funcName = expr.expression.text;
        }
        // If the symbol name is empty (anonymous function), infer from context:
        if (funcName === "") {
          if (ts.isIdentifier(expr.expression)) {
            // Direct variable access: f.name => infer "f"
            // BUT: per ES spec (NamedEvaluation / IsAnonymousFunctionDefinition),
            // if the binding initializer is a "covered" form like `(0, function(){})`
            // (comma expression, call, etc.), the function's .name is NOT set to
            // the binding name. Only direct FunctionExpression/ArrowFunction/
            // ClassExpression (optionally parenthesized) qualifies. (#1049)
            const sym = ctx.checker.getSymbolAtLocation(expr.expression);
            const decl = sym?.valueDeclaration;
            let initExpr: ts.Expression | undefined;
            if (decl && (ts.isBindingElement(decl) || ts.isVariableDeclaration(decl)) && decl.initializer) {
              initExpr = decl.initializer;
            }
            if (initExpr !== undefined && !isAnonymousFunctionDefinition(initExpr)) {
              // Covered form — .name is "" (or whatever the inner fn already has)
              addStringConstantGlobal(ctx, "");
              return compileStringLiteral(ctx, fctx, "");
            }
            funcName = expr.expression.text;
          } else if (ts.isPropertyAccessExpression(expr.expression)) {
            // Property access: obj.method.name => infer "method"
            funcName = expr.expression.name.text;
          } else if (
            ts.isElementAccessExpression(expr.expression) &&
            ts.isStringLiteral(expr.expression.argumentExpression)
          ) {
            // Element access: obj["method"].name => infer "method"
            funcName = expr.expression.argumentExpression.text;
          }
        }
        // Ensure the string constant is registered before compiling
        addStringConstantGlobal(ctx, funcName);
        return compileStringLiteral(ctx, fctx, funcName);
      }
    } // close `else` branch of the #1632a bind-result guard
  }

  // Handle array.length (vec struct: field 0 is the logical length)
  if (propName === "length") {
    // (#1742) `this.length` where `this` is the host-supplied `__current_this`
    // externref but may carry a compiled vec at runtime (a closure body dispatched
    // via `__call_fn_method_N`). The override `this` is typically `any` → externref,
    // so the vec fast paths below never fire; without this guard the read falls
    // through to `__extern_length`, which returns 0 for an externref-wrapped vec.
    // Runtime `ref.test` against the registered vec types reads field 0 on a hit,
    // `__extern_length` for a genuine host receiver. No-op otherwise.
    {
      // Only vec types are valid `.length` receivers (length at struct field 0);
      // a non-vec static struct must NOT be read as a vec here.
      const allTargets = thisReceiverGuardTargets(ctx, fctx, expr.expression, "element");
      const targets = allTargets?.filter((idx) => {
        const def = ctx.mod.types[idx];
        return def?.kind === "struct" && def.fields[0]?.name === "length" && def.fields[1]?.name === "data";
      });
      if (targets !== undefined && targets.length > 0) {
        const lenType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
        compileExpression(ctx, fctx, expr.expression); // → externref `this`
        emitThisReceiverGuardConvert(
          ctx,
          fctx,
          targets,
          lenType,
          (concreteType) => {
            // [(ref $vec)] → length (vec struct field 0). Every registered vec
            // type has `length` at field 0, so the matched concrete type works.
            const vecIdx = (concreteType as { typeIdx: number }).typeIdx;
            fctx.body.push({ op: "struct.get", typeIdx: vecIdx, fieldIdx: 0 } as Instr);
            if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
          },
          () => {
            // [externref] → __extern_length (genuine host receiver / real JS array)
            const lengthFuncIdx = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
            flushLateImportShifts(ctx, fctx);
            if (lengthFuncIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: lengthFuncIdx } as Instr);
              if (ctx.fast) fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
            } else {
              fctx.body.push({ op: "drop" } as Instr);
              fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: 0 } as Instr);
            }
          },
        );
        return lenType;
      }
    }
    // Shape-inferred array-like: obj.length → struct.get vec field 0
    if (ts.isIdentifier(expr.expression)) {
      const shapeInfo = ctx.shapeMap.get(expr.expression.text);
      if (shapeInfo) {
        compileExpression(ctx, fctx, expr.expression);
        fctx.body.push({ op: "struct.get", typeIdx: shapeInfo.vecTypeIdx, fieldIdx: 0 });
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
    // Check the actual local type (may differ from TS type, e.g. arguments vec struct)
    if (ts.isIdentifier(expr.expression)) {
      const localIdx = fctx.localMap.get(expr.expression.text);
      if (localIdx !== undefined) {
        const localType =
          localIdx < fctx.params.length
            ? fctx.params[localIdx]!.type
            : fctx.locals[localIdx - fctx.params.length]?.type;
        // Vec struct ref local (e.g. `arguments` object) — struct.get field 0 (length)
        // Note: for externref locals (e.g. `obj: any` in filter callbacks), we fall through
        // to the generic externref path below (line ~1731) which uses multi-struct dispatch
        // (ref.test → ref.cast → struct.get) to read the WasmGC struct field directly.
        // Calling __extern_length on an externref-wrapped WasmGC struct returns 0 because
        // obj.length is undefined on opaque externref objects in V8.
        if ((localType?.kind === "ref" || localType?.kind === "ref_null") && localType.typeIdx !== undefined) {
          const vecTypeIdx = (localType as { typeIdx: number }).typeIdx;
          const typeDef = ctx.mod.types[vecTypeIdx];
          if (
            typeDef?.kind === "struct" &&
            typeDef.fields[0]?.name === "length" &&
            typeDef.fields[1]?.name === "data"
          ) {
            fctx.body.push({ op: "local.get", index: localIdx });
            fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
            if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
            return ctx.fast ? { kind: "i32" } : { kind: "f64" };
          }
        }
      }
    }
    const objWasmType = resolveWasmType(ctx, objType);
    if (objWasmType.kind === "ref" || objWasmType.kind === "ref_null") {
      const vecTypeIdx = (objWasmType as { typeIdx: number }).typeIdx;
      const typeDef = ctx.mod.types[vecTypeIdx];
      if (typeDef?.kind === "struct" && typeDef.fields[1]?.name === "data") {
        const exprResult = compileExpression(ctx, fctx, expr.expression);
        // If the compiled expression returned externref (e.g. `x as any[]`), the TS type
        // annotation doesn't guarantee the runtime struct type. Use multi-struct dispatch:
        // try ref.test for the expected vec type first (struct.get field 0 gives the length),
        // falling back to __extern_length for genuine host objects (real JS arrays).
        // This avoids: (1) unguarded struct.get on externref (Wasm validation error), and
        // (2) __extern_length returning 0 for WasmGC structs (obj.length is undefined on
        // externref-wrapped WasmGC objects in V8).
        if (exprResult?.kind === "externref") {
          const extTmpIdx = allocLocal(fctx, `__len_ext_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: extTmpIdx });
          const anyTmpIdx = allocLocal(fctx, `__len_any_${fctx.locals.length}`, { kind: "anyref" });
          fctx.body.push({ op: "local.get", index: extTmpIdx });
          fctx.body.push({ op: "any.convert_extern" } as Instr);
          fctx.body.push({ op: "local.set", index: anyTmpIdx });
          const lenType = ctx.fast ? { kind: "i32" as const } : { kind: "f64" as const };
          const lenTmp2 = allocLocal(fctx, `__len_val_${fctx.locals.length}`, lenType);
          const lengthFuncIdx = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
          flushLateImportShifts(ctx, fctx);
          const fallbackInstrs2: Instr[] =
            lengthFuncIdx !== undefined
              ? [
                  { op: "local.get", index: extTmpIdx } as Instr,
                  { op: "call", funcIdx: lengthFuncIdx } as Instr,
                  ...(ctx.fast ? [{ op: "i32.trunc_sat_f64_s" } as Instr] : []),
                  { op: "local.set", index: lenTmp2 } as Instr,
                ]
              : [
                  { op: ctx.fast ? "i32.const" : "f64.const", value: 0 } as Instr,
                  { op: "local.set", index: lenTmp2 } as Instr,
                ];
          fctx.body.push({ op: "local.get", index: anyTmpIdx });
          fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: anyTmpIdx } as Instr,
              { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
              { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
              ...(ctx.fast ? [] : [{ op: "f64.convert_i32_s" } as Instr]),
              { op: "local.set", index: lenTmp2 } as Instr,
            ],
            else: fallbackInstrs2,
          });
          fctx.body.push({ op: "local.get", index: lenTmp2 });
          return lenType;
        }
        // Guard: the TS type might not match the runtime struct type.
        // If the compiled expression returned a different ref type, use ref.test
        // to verify before struct.get, falling back to 0.
        if (
          exprResult &&
          (exprResult.kind === "ref" || exprResult.kind === "ref_null") &&
          (exprResult as any).typeIdx !== vecTypeIdx
        ) {
          const lenTmp = allocLocal(fctx, `__len_tmp_${fctx.locals.length}`, { kind: "anyref" });
          fctx.body.push({ op: "local.set", index: lenTmp });
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
          const lenResult = ctx.fast ? { kind: "i32" as const } : { kind: "f64" as const };
          fctx.body.push({
            op: "if",
            blockType: { kind: "val" as const, type: lenResult },
            then: [
              { op: "local.get", index: lenTmp } as Instr,
              { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
              { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
              ...(ctx.fast ? [] : [{ op: "f64.convert_i32_s" } as Instr]),
            ],
            else: [{ op: ctx.fast ? "i32.const" : "f64.const", value: 0 } as Instr],
          });
          return lenResult;
        }
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // get length from vec
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
    // Fallback: compile the expression and check the actual wasm return type
    // This handles cases like strings.raw.length where TS doesn't know the type
    {
      const savedLen = fctx.body.length;
      const exprType = compileExpression(ctx, fctx, expr.expression);
      if (
        exprType &&
        (exprType.kind === "ref" || exprType.kind === "ref_null") &&
        (exprType as { typeIdx: number }).typeIdx !== undefined
      ) {
        const vecTypeIdx = (exprType as { typeIdx: number }).typeIdx;
        const typeDef = ctx.mod.types[vecTypeIdx];
        if (typeDef?.kind === "struct" && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data") {
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
          if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
          return ctx.fast ? { kind: "i32" } : { kind: "f64" };
        }
      }
      // Undo the compiled expression if it didn't match
      fctx.body.length = savedLen;
    }
    // #1472 Phase B Blocker B Slice 2 — standalone `.length` on an `any`/unknown
    // receiver. None of the vec fast-paths matched, so the receiver is an opaque
    // externref at runtime (e.g. the $ObjVec result of `Object.keys(o)` stored
    // in an `any`). In standalone, `__extern_length` is the native $ObjVec
    // reader (Blocker B Slice 1), so routing here keeps `.length` host-free and
    // correct instead of falling through to `__extern_get("length")` (which the
    // native `__extern_get` would mis-handle by casting "length" → key lookup,
    // yielding 0). JS-host mode is unchanged (this gate is standalone-only; the
    // host path's generic `__extern_get("length")` already works there).
    if (ctx.standalone) {
      const isAnyOrUnknown = (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      if (isAnyOrUnknown) {
        const exprResult = compileExpression(ctx, fctx, expr.expression);
        if (exprResult) {
          if (exprResult.kind !== "externref") {
            coerceType(ctx, fctx, exprResult, { kind: "externref" });
          }
          const lenFn = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
          flushLateImportShifts(ctx, fctx);
          if (lenFn !== undefined) {
            fctx.body.push({ op: "call", funcIdx: lenFn } as Instr);
            if (ctx.fast) fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
            return ctx.fast ? { kind: "i32" } : { kind: "f64" };
          }
          // No helper available — drop and yield 0.
          fctx.body.push({ op: "drop" } as Instr);
          fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: 0 } as Instr);
          return ctx.fast ? { kind: "i32" } : { kind: "f64" };
        }
      }
    }
  }

  // Handle .raw on tagged template strings arrays (template vec struct)
  // The strings parameter is typed as a base vec, but at runtime it's a
  // template vec (subtype with an extra raw field). We ref.cast to the
  // template vec type and then struct.get field 2.
  if (propName === "raw" && ctx.templateVecTypeIdx >= 0) {
    const templateVecTypeIdx = ctx.templateVecTypeIdx;
    // Check if the object is a vec-like type (base vec or template vec)
    let isVecLike = false;
    if (ts.isIdentifier(expr.expression)) {
      const localIdx = fctx.localMap.get(expr.expression.text);
      if (localIdx !== undefined) {
        const localType =
          localIdx < fctx.params.length
            ? fctx.params[localIdx]!.type
            : fctx.locals[localIdx - fctx.params.length]?.type;
        if ((localType?.kind === "ref" || localType?.kind === "ref_null") && localType.typeIdx !== undefined) {
          const typeIdx = (localType as { typeIdx: number }).typeIdx;
          const typeDef = ctx.mod.types[typeIdx];
          if (
            typeDef?.kind === "struct" &&
            typeDef.fields[0]?.name === "length" &&
            typeDef.fields[1]?.name === "data"
          ) {
            isVecLike = true;
          }
        }
      }
    }
    if (!isVecLike) {
      const objWasmType = resolveWasmType(ctx, objType);
      if (objWasmType.kind === "ref" || objWasmType.kind === "ref_null") {
        const typeIdx = (objWasmType as { typeIdx: number }).typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        if (typeDef?.kind === "struct" && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data") {
          isVecLike = true;
        }
      }
    }
    if (isVecLike) {
      // Compile the object expression, cast to template vec, and get raw field
      // Guard with ref.test to avoid illegal cast trap if the runtime type
      // is a base vec (not a template vec with the extra raw field).
      compileExpression(ctx, fctx, expr.expression);
      const baseVecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
      const rawTmp = allocLocal(fctx, `__raw_tmp_${fctx.locals.length}`, { kind: "ref_null", typeIdx: baseVecTypeIdx });
      const rawObj = allocLocal(fctx, `__raw_obj_${fctx.locals.length}`, { kind: "anyref" });
      fctx.body.push({ op: "local.set", index: rawObj });
      fctx.body.push({ op: "local.get", index: rawObj });
      fctx.body.push({ op: "ref.test", typeIdx: templateVecTypeIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: rawObj } as Instr,
          { op: "ref.cast", typeIdx: templateVecTypeIdx } as Instr,
          { op: "struct.get", typeIdx: templateVecTypeIdx, fieldIdx: 2 } as Instr,
          { op: "local.set", index: rawTmp } as Instr,
        ],
        else: [
          // Not a template vec — return null (no raw field available)
          { op: "ref.null", typeIdx: baseVecTypeIdx } as Instr,
          { op: "local.set", index: rawTmp } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: rawTmp });
      return { kind: "ref_null", typeIdx: baseVecTypeIdx };
    }
  }

  // Handle Math constants
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Math") {
    const mathConstants: Record<string, number> = {
      PI: Math.PI,
      E: Math.E,
      LN2: Math.LN2,
      LN10: Math.LN10,
      SQRT2: Math.SQRT2,
      SQRT1_2: Math.SQRT1_2,
      LOG2E: Math.LOG2E,
      LOG10E: Math.LOG10E,
    };
    if (propName in mathConstants) {
      fctx.body.push({ op: "f64.const", value: mathConstants[propName]! });
      return { kind: "f64" };
    }
  }

  // Handle Number constants
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Number") {
    const numberConstants: Record<string, number> = {
      EPSILON: Number.EPSILON,
      MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
      MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
      MAX_VALUE: Number.MAX_VALUE,
      MIN_VALUE: Number.MIN_VALUE,
      POSITIVE_INFINITY: Infinity,
      NEGATIVE_INFINITY: -Infinity,
      NaN: NaN,
    };
    if (propName in numberConstants) {
      fctx.body.push({ op: "f64.const", value: numberConstants[propName]! });
      return { kind: "f64" };
    }
  }

  // Handle Symbol.iterator, Symbol.hasInstance, etc. → constant i32
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Symbol") {
    const symId = getWellKnownSymbolId(propName);
    if (symId !== undefined) {
      fctx.body.push({ op: "i32.const", value: symId });
      return { kind: "i32" };
    }
  }

  // (#1467) `sym.description` — Symbol.prototype.description accessor.
  // When the LHS is a Symbol primitive (or Symbol-wrapper object), read the
  // host's Symbol.prototype.description accessor via `__symbol_description`.
  // This handles three test262 buckets:
  //   • Symbol('x').description === 'x'
  //   • Symbol().description === undefined
  //   • Symbol.prototype.description.call(wrapperObj) → unwraps the wrapper
  // Generic __extern_get works for plain JS hosts but bypasses the spec
  // accessor (which V8 implements specially), so we route directly.
  if (propName === "description" && (objType.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
    // (#2163) No-JS-host mode: the symbol is a bare i32 id and there is no host
    // accessor — read the description from the native id→string side table
    // (populated by `compileSymbolCall`). A null slot / out-of-range id reads as
    // `undefined`, matching `Symbol().description === undefined`.
    if (noJsHost(ctx)) {
      const recvType = compileExpression(ctx, fctx, expr.expression, { kind: "i32" });
      if (recvType && recvType.kind !== "i32") {
        coerceType(ctx, fctx, recvType, { kind: "i32" });
      }
      emitSymbolDescLoad(ctx, fctx);
      // Result is `ref_null $AnyString` — a native string (or null⇒undefined).
      return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
    }
    const symDescIdx = ensureLateImport(ctx, "__symbol_description", [{ kind: "externref" }], [{ kind: "externref" }]);
    if (symDescIdx !== undefined) {
      const recvType = compileExpression(ctx, fctx, expr.expression, { kind: "externref" });
      if (recvType && recvType.kind !== "externref") {
        coerceType(ctx, fctx, recvType, { kind: "externref" });
      }
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "call", funcIdx: symDescIdx });
      return { kind: "externref" };
    }
  }

  // Handle string.length
  if (isStringType(objType) && propName === "length") {
    const recvType = compileExpression(ctx, fctx, expr.expression);
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
      // The receiver must be a `$AnyString` ref before reading its `len`
      // field. Some string producers (e.g. the native Error `.name`/`.message`
      // reader, #1104/#1797) hand back an `externref`; coerce it to the GC
      // string ref first, otherwise `struct.get $AnyString` validates against
      // an externref operand → invalid Wasm (#1797).
      if (recvType && recvType.kind === "externref") {
        coerceType(ctx, fctx, recvType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
      }
      // len is field 0 of $AnyString — works for both FlatString and ConsString
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
      return { kind: "i32" };
    }
    const funcIdx = ctx.jsStringImports.get("length");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i32" };
    }
  }

  // Handle IteratorResult property access: .value and .done
  if (isIteratorResultType(objType) || isGeneratorIteratorResultLike(ctx, objType, propName)) {
    const nativeResult = tryCompileNativeGeneratorResultProperty(ctx, fctx, expr.expression, propName);
    if (nativeResult !== undefined) return nativeResult;
    if (propName === "value") {
      compileExpression(ctx, fctx, expr.expression);
      // Check the expected value type from the IteratorResult<T>. NOTE (#2030):
      // an exhausted result's `.value` is `undefined`; the f64 fast path below
      // runs `Number(undefined)` → NaN, so a string context of the
      // value-after-done prints "NaN". Making that survive as "undefined"
      // requires the value-buffer representation work tracked by #2035 and is
      // intentionally NOT changed here — routing `.value` through externref
      // breaks numeric consumers (illegal cast on the raw-f64 iteration path).
      const valueType = getIteratorResultValueType(ctx, objType);
      if (valueType && valueType.kind === "f64") {
        const funcIdx = ctx.funcMap.get("__gen_result_value_f64");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "f64" };
        }
      }
      const funcIdx = ctx.funcMap.get("__gen_result_value");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    if (propName === "done") {
      compileExpression(ctx, fctx, expr.expression);
      const funcIdx = ctx.funcMap.get("__gen_result_done");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        // #2030: `.done` is a boolean — brand it so string contexts render
        // "true"/"false" rather than the raw i32 "1"/"0".
        return { kind: "i32", boolean: true };
      }
    }
  }

  // Handle externref property access
  if (isExternalDeclaredClass(objType, ctx.checker)) {
    const externResult = compileExternPropertyGet(ctx, fctx, expr, objType, propName);
    if (externResult !== null) return externResult;
    // Fall through to dynamic fallback if import is missing
  }

  // Handle getter accessor on user-defined classes
  const typeName = resolveStructNameForExpr(ctx, fctx, expr.expression);
  if (typeName) {
    const accessorKey = `${typeName}_${propName}`;
    // (#1888 S5c / C3) Migrated struct accessor → route through the host-free
    // closure (per-(struct,prop) global + shared S5b __call_accessor_get driver)
    // so a getter that closes over outer scope observes its captures. The
    // receiver is boxed to externref → threaded as `this` via __current_this.
    // Result externref (boxed getter return); the caller coerces to the static
    // member type. Class accessors are NOT migrated (no structAccessorClosure
    // entry) so they keep the bare-fn path below.
    const closureAccGet =
      S5C_STRUCT_ACCESSOR_CLOSURE && ctx.standalone ? ctx.structAccessorClosure.get(accessorKey)?.getGlobal : undefined;
    if (closureAccGet !== undefined) {
      const recvType = compileExpression(ctx, fctx, expr.expression);
      if (recvType && recvType.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" } as Instr);
      }
      fctx.body.push({ op: "global.get", index: closureAccGet });
      const driverIdx = reserveAccessorGetDriver(ctx);
      fctx.body.push({ op: "call", funcIdx: driverIdx });
      return { kind: "externref" };
    }
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${typeName}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName));
      if (funcIdx !== undefined) {
        compileExpression(ctx, fctx, expr.expression);
        fctx.body.push({ op: "call", funcIdx });
        // Use actual Wasm return type of the getter function — TS checker
        // may report 'any' (externref) for Object.defineProperty accessors
        // while the getter actually returns f64/i32/ref.
        const getterLocalIdx = funcIdx - ctx.numImportFuncs;
        const getterDef = getterLocalIdx >= 0 ? ctx.mod.functions[getterLocalIdx] : undefined;
        if (getterDef) {
          const getterType = ctx.mod.types[getterDef.typeIdx];
          if (getterType?.kind === "func" && getterType.results.length > 0) {
            return getterType.results[0]!;
          }
        }
        const propType = ctx.checker.getTypeAtLocation(expr);
        return resolveWasmType(ctx, propType);
      }
    }

    if (runtimeAccessorDescriptorKey(ctx, expr.expression, propName) !== undefined) {
      const runtimeResult = emitRuntimeDescriptorGet(ctx, fctx, expr.expression, propName, expr);
      if (runtimeResult !== null) return runtimeResult;
    }

    // Handle instance method accessed as value (not call): obj.method (#820, #1149)
    // For OBJECT LITERAL struct types, the method's struct field now holds a
    // proper closure-ref (#1118 — `compileObjectLiteralForStruct` calls
    // `emitObjectMethodAsClosure`), so we read the field to get a callable
    // value. For CLASS instances the field doesn't exist; fall through to the
    // legacy null-externref placeholder.
    {
      // (#1394) Walk the class-parent chain to the TOPMOST class that owns
      // the same method funcIdx. When `class D extends C { }` inherits `m`
      // from C, the codegen registers `D_m` in `classMethodSet` with the
      // same `funcIdx` as `C_m` (class-bodies.ts:519–523). Two distinct
      // names → two distinct cache globals (`__method_closure_D_m` and
      // `__method_closure_C_m`) → two lazily-allocated closures with
      // different identity. Spec'd behaviour: identity follows the owning
      // class, so `(new D()).m === C.prototype.m`. Walk the chain until
      // either no parent or the parent's funcIdx differs (override).
      const ownerNameForChain = (start: string): string => {
        const startFull = `${start}_${propName}`;
        const startIdx = ctx.funcMap.get(startFull);
        if (startIdx === undefined) return start; // not a method we know
        let bestOwner = start;
        let cls: string | undefined = ctx.classParentMap.get(start);
        const seen = new Set<string>([start]);
        while (cls && !seen.has(cls)) {
          seen.add(cls);
          const full = `${cls}_${propName}`;
          const parentIdx = ctx.funcMap.get(full);
          if (parentIdx === undefined) break; // parent doesn't have this method
          if (parentIdx === startIdx) {
            // Inherited (same funcIdx) — keep walking up.
            bestOwner = cls;
            cls = ctx.classParentMap.get(cls);
            continue;
          }
          // Parent has a DIFFERENT funcIdx → start overrides the method.
          // Identity must use start's cache, not the parent's.
          break;
        }
        return bestOwner;
      };
      const owner = ownerNameForChain(typeName);
      const methodFullName = `${owner}_${propName}`;
      if (ctx.classMethodSet.has(methodFullName) || ctx.staticMethodSet.has(methodFullName)) {
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, methodFullName));
        if (funcIdx !== undefined) {
          // #1118: Object literal — read the struct field which holds the closure.
          // Detected by: typeName is a registered struct AND the struct has a
          // matching field. classSet.has(typeName) excludes class instances.
          const structFields = ctx.structFields.get(typeName);
          const fieldIdx = structFields ? structFields.findIndex((f) => f.name === propName) : -1;
          const structTypeIdx = ctx.structMap.get(typeName);
          if (!ctx.classSet.has(typeName) && structFields && fieldIdx >= 0 && structTypeIdx !== undefined) {
            // Compile the object → struct ref on stack → struct.get the field.
            const objResult = compileExpression(ctx, fctx, expr.expression);
            if (objResult) {
              fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
              const fType = structFields[fieldIdx]!.type;
              return fType;
            }
          }
          // (#1394) For CLASS instances, return the SAME cached singleton
          // closure as `C.prototype.<method>` so the identity invariant
          // `c.m === C.prototype.m` holds. Spec'd in
          // verifyProperty(C.prototype, "m", { value: m }) across 478
          // class/elements tests.
          //
          // Both paths use `methodFullName = ${typeName}_${propName}` where
          // `typeName` is canonicalised to the synthetic class name in
          // declarations.ts (#1394 dual-registration bridge): the proto
          // handler resolves `C.prototype.m`'s identifier "C" via
          // classExprNameMap to `__anonClass_N`, the instance path resolves
          // `c`'s TS type via resolveStructName(...) → `__anonClass_N`, so
          // both arrive at the same cache key.
          if (ctx.classSet.has(typeName) && ctx.classMethodSet.has(methodFullName)) {
            // (#1394 inherited-method fix) Use the OWNER class's struct
            // type, not the receiver's. The trampoline's `this` param is
            // typed against the method's owning class, so the receiver
            // type must match for validation.
            const fullStructTypeIdx = ctx.structMap.get(owner) ?? ctx.structMap.get(typeName);
            if (fullStructTypeIdx !== undefined) {
              // Compile + drop the object expression for side effects;
              // the cached closure carries no per-instance binding (JS
              // strict mode `var fn = c.m; fn();` calls with `this =
              // undefined`, so the lost-binding semantics match spec).
              const objResult = compileExpression(ctx, fctx, expr.expression);
              if (objResult) {
                fctx.body.push({ op: "drop" });
              }
              if (emitCachedMethodClosureAccess(ctx, fctx, methodFullName, funcIdx, fullStructTypeIdx)) {
                return { kind: "externref" };
              }
            }
          }
          // Legacy fallback for class methods or unresolved cases:
          // compile + drop the object, return null externref placeholder.
          const objResult = compileExpression(ctx, fctx, expr.expression);
          if (objResult) {
            fctx.body.push({ op: "drop" });
          }
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
    }

    // Handle .constructor on class instances — return the class VALUE.
    //
    // (#2158 P1) `new A().constructor` must be reference-identical to the
    // class identifier `A` so that `new A().constructor === A` holds. The
    // class identifier resolves to the `__class_<Name>` singleton via
    // `emitLazyClassObjectGet` (identifiers.ts:620). Routing `.constructor`
    // through the SAME singleton makes both sides of the `===` the same
    // externref — host-free, so it fixes the identity in standalone mode
    // too (the previous `ref.func` + `extern.convert_any` produced a
    // funcref-as-externref that never compared equal to the class object).
    if (propName === "constructor" && ctx.classSet.has(typeName)) {
      // Compile and drop the object expression (for side effects)
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult) {
        fctx.body.push({ op: "drop" });
      }
      if (emitLazyClassObjectGet(ctx, fctx, typeName)) {
        return { kind: "externref" };
      }
      // No class-object singleton (e.g. externref-backed builtin subclass):
      // fall back to the constructor funcref so callable identity is at least
      // stable across reads of the same class.
      const ctorName = `${typeName}_constructor`;
      const funcIdx = ctx.funcMap.get(ctorName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "ref.func", funcIdx });
        fctx.body.push({ op: "extern.convert_any" });
        return { kind: "externref" };
      }
      // No named constructor found — return null externref
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle .prototype on class instances — return prototype singleton
    if (propName === "prototype" && ctx.classSet.has(typeName)) {
      // Compile and drop the object expression
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult) {
        fctx.body.push({ op: "drop" });
      }
      if (emitLazyProtoGet(ctx, fctx, typeName)) {
        return { kind: "externref" };
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle struct field access (named or anonymous)
    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        const objResult = compileExpression(ctx, fctx, expr.expression);
        const fieldType = fields[fieldIdx]!.type;
        // Null-guard: if the object ref could be null (ref_null), prevent trap
        // Skip null guard when expression is provably non-null (#800)
        const exprNonNull = isProvablyNonNull(expr.expression, ctx.checker);
        if (objResult && objResult.kind === "ref_null") {
          // Always use multi-struct dispatch (even when provably non-null) to avoid
          // illegal cast traps when runtime struct type differs from compile-time type (#778).
          emitNullGuardedStructGet(ctx, fctx, objResult, fieldType, structTypeIdx, fieldIdx, propName);
          if (fieldType.kind === "ref") {
            return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
          }
          return fieldType;
        } else if (objResult && objResult.kind === "externref") {
          // The expression returned externref but we need a struct ref for struct.get.
          // Cast externref → anyref → (ref null $StructType), with __extern_get fallback.
          emitExternrefToStructGet(ctx, fctx, fieldType, structTypeIdx, fieldIdx, propName, true /* throwOnNull */);
          if (fieldType.kind === "ref") {
            return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
          }
          return fieldType;
        } else if (objResult && objResult.kind === "ref") {
          // Always use multi-struct dispatch to avoid illegal cast traps (#778).
          // Even for provably-non-null, runtime struct type may differ from compile-time type.
          const nullableObj: ValType = { kind: "ref_null", typeIdx: (objResult as any).typeIdx ?? structTypeIdx };
          emitNullGuardedStructGet(ctx, fctx, nullableObj, fieldType, structTypeIdx, fieldIdx, propName);
          if (fieldType.kind === "ref") {
            return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
          }
          return fieldType;
        } else {
          fctx.body.push({
            op: "struct.get",
            typeIdx: structTypeIdx,
            fieldIdx,
          });
        }
        return fieldType;
      }

      // ── Prototype chain walk (#799b) ──────────────────────────────
      // Field not found on this struct at compile time. Walk the __proto__
      // chain: get the __proto__ externref field, and if non-null, use
      // __extern_get(proto, propName) to look up the property dynamically.
      const protoFieldIdx = fields.findIndex((f) => f.name === "__proto__");
      if (protoFieldIdx !== -1) {
        const protoAccessType = ctx.checker.getTypeAtLocation(expr);
        const protoResultWasm = resolveWasmType(ctx, protoAccessType);
        const effectiveResult: ValType =
          protoResultWasm.kind === "f64" || protoResultWasm.kind === "i32" ? protoResultWasm : { kind: "externref" };

        const getIdx = ensureLateImport(
          ctx,
          "__extern_get",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        let unboxIdx: number | undefined;
        if (effectiveResult.kind === "f64" || effectiveResult.kind === "i32") {
          unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
        }
        flushLateImportShifts(ctx, fctx);

        if (getIdx !== undefined) {
          const objResult = compileExpression(ctx, fctx, expr.expression);

          // Store in anyref for null-check + struct type dispatch
          const objLocal = allocLocal(fctx, `__pobj_${fctx.locals.length}`, { kind: "anyref" });
          // If the expression returned externref, convert to anyref first
          if (objResult && objResult.kind === "externref") {
            fctx.body.push({ op: "any.convert_extern" } as Instr);
          }
          fctx.body.push({ op: "local.set", index: objLocal });

          const protoLocal = allocLocal(fctx, `__proto_${fctx.locals.length}`, { kind: "externref" });

          // Null check the object
          fctx.body.push({ op: "local.get", index: objLocal });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // Null object → null proto
              { op: "ref.null.extern" } as Instr,
              { op: "local.set", index: protoLocal } as Instr,
            ],
            else: [
              // Try to cast to expected struct type and get __proto__
              { op: "local.get", index: objLocal } as Instr,
              { op: "ref.test", typeIdx: structTypeIdx } as Instr,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: objLocal } as Instr,
                  { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
                  { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: protoFieldIdx } as Instr,
                  { op: "local.set", index: protoLocal } as Instr,
                ],
                else: [
                  // Wrong struct type — try alternate structs that have __proto__
                  { op: "ref.null.extern" } as Instr,
                  { op: "local.set", index: protoLocal } as Instr,
                ],
              } as Instr,
            ],
          });

          // If proto is non-null, call __extern_get(proto, propName)
          addStringConstantGlobal(ctx, propName);

          fctx.body.push({ op: "local.get", index: protoLocal });
          fctx.body.push({ op: "ref.is_null" });
          const protoDefaultInstrs = defaultValueInstrs(effectiveResult);
          fctx.body.push({
            op: "if",
            blockType: { kind: "val" as const, type: effectiveResult },
            then: protoDefaultInstrs,
            else: [
              { op: "local.get", index: protoLocal } as Instr,
              ...stringConstantExternrefInstrs(ctx, propName),
              { op: "call", funcIdx: getIdx } as Instr,
              ...(effectiveResult.kind === "f64" && unboxIdx !== undefined
                ? [{ op: "call", funcIdx: unboxIdx } as Instr]
                : effectiveResult.kind === "i32" && unboxIdx !== undefined
                  ? [{ op: "call", funcIdx: unboxIdx } as Instr, { op: "i32.trunc_sat_f64_s" } as Instr]
                  : []),
            ],
          });

          return effectiveResult;
        }
      }

      // (#799 WI4) Property not found on struct and no __proto__ field.
      // For known class types, fall back to __extern_get via host import.
      // This handles prototype chain lookups delegated to the JS host.
      if (ctx.classSet.has(typeName)) {
        const getIdx = ensureLateImport(
          ctx,
          "__extern_get",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        if (getIdx !== undefined) {
          // #1623: receiver may already be externref (e.g. `this` in a static
          // method = the class object global, typed externref). Blindly emitting
          // extern.convert_any on an externref source produces invalid Wasm
          // (`expected anyref, found ... of type externref`). Coerce only when
          // necessary.
          const recvType = compileExpression(ctx, fctx, expr.expression);
          if (recvType && recvType.kind !== "externref") {
            coerceType(ctx, fctx, recvType, { kind: "externref" });
          }
          addStringConstantGlobal(ctx, propName);
          fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
          fctx.body.push({ op: "call", funcIdx: getIdx });

          // Unbox if the expected type is numeric
          const protoAccessType = ctx.checker.getTypeAtLocation(expr);
          const expectedWasm = resolveWasmType(ctx, protoAccessType);
          if (expectedWasm.kind === "f64") {
            const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
            flushLateImportShifts(ctx, fctx);
            if (unboxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: unboxIdx });
            }
            return { kind: "f64" };
          }
          if (expectedWasm.kind === "i32") {
            const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
            flushLateImportShifts(ctx, fctx);
            if (unboxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: unboxIdx });
              fctx.body.push({ op: "i32.trunc_sat_f64_s" });
            }
            return { kind: "i32" };
          }
          return { kind: "externref" };
        }
      }
    }
  }

  // Dynamic property access fallback: instead of erroring, emit a default value.
  // This handles cases where TypeScript cannot resolve the property statically
  // (e.g., properties on Object, {}, undefined, or dynamically-typed values).
  // Determine the expected result type from the TS checker at the access site.
  const accessType = ctx.checker.getTypeAtLocation(expr);
  const accessWasm = resolveWasmType(ctx, accessType);

  // For struct types with the property, try to compile the object and do struct.get
  // but NEVER for class struct types — their fields are fixed at collection time
  if (typeName && !ctx.classSet.has(typeName)) {
    // typeName was already resolved above but field was not found;
    // try auto-registering the property from the TS type
    const props = objType.getProperties?.();
    if (props) {
      const tsProp = props.find((p) => p.name === propName);
      if (tsProp) {
        const propTsType = ctx.checker.getTypeOfSymbolAtLocation(tsProp, expr);
        const propWasmType = resolveWasmType(ctx, propTsType);
        // Try to add the field to the struct dynamically
        const structTypeIdx = ctx.structMap.get(typeName);
        const fields = ctx.structFields.get(typeName);
        if (structTypeIdx !== undefined && fields) {
          const typeDef = ctx.mod.types[structTypeIdx];
          if (typeDef?.kind === "struct") {
            // Add the missing field (widen ref to ref_null for default initialization)
            const fieldType =
              propWasmType.kind === "ref"
                ? { kind: "ref_null" as const, typeIdx: (propWasmType as { typeIdx: number }).typeIdx }
                : propWasmType;
            const newField: FieldDef = { name: propName, type: fieldType, mutable: true };
            fields.push(newField);
            // fields === typeDef.fields (same array ref from structFields map)
            patchStructNewForAddedField(ctx, fctx, structTypeIdx, propWasmType);
            const fieldIdx = fields.length - 1;
            if (fieldIdx !== -1) {
              const fieldType = fields[fieldIdx]!.type;
              const objResult = compileExpression(ctx, fctx, expr.expression);
              const exprNonNull2 = isProvablyNonNull(expr.expression, ctx.checker);
              if (objResult && objResult.kind === "ref_null") {
                // Always use multi-struct dispatch to avoid illegal cast traps (#778)
                emitNullGuardedStructGet(ctx, fctx, objResult, fieldType, structTypeIdx, fieldIdx, propName);
                if (fieldType.kind === "ref") {
                  return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
                }
                return fieldType;
              } else if (objResult && objResult.kind === "externref") {
                emitExternrefToStructGet(
                  ctx,
                  fctx,
                  fieldType,
                  structTypeIdx,
                  fieldIdx,
                  propName,
                  true /* throwOnNull */,
                );
              } else if (objResult && objResult.kind === "ref") {
                // Always use multi-struct dispatch to avoid illegal cast traps (#778)
                const nullableObj: ValType = { kind: "ref_null", typeIdx: (objResult as any).typeIdx ?? structTypeIdx };
                emitNullGuardedStructGet(ctx, fctx, nullableObj, fieldType, structTypeIdx, fieldIdx, propName);
                if (fieldType.kind === "ref") {
                  return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
                }
              } else {
                fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
              }
              return fieldType;
            }
          }
        }
      }
    }
  } // close if (typeName && !ctx.classSet.has(typeName))

  // For externref objects (e.g. results of host calls like RegExp.exec()),
  // use __extern_get(obj, key) to dynamically read the property at runtime.
  {
    const objWasmType = resolveWasmType(ctx, objType);
    const isExternObj =
      objWasmType.kind === "externref" ||
      (ts.isIdentifier(expr.expression) &&
        (() => {
          const localIdx = fctx.localMap.get(expr.expression.text);
          if (localIdx === undefined) return false;
          const localType =
            localIdx < fctx.params.length
              ? fctx.params[localIdx]!.type
              : fctx.locals[localIdx - fctx.params.length]?.type;
          return localType?.kind === "externref";
        })());
    if (isExternObj) {
      const getIdx = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      let unboxIdx: number | undefined;
      if (accessWasm.kind === "f64" || accessWasm.kind === "i32") {
        unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      }
      flushLateImportShifts(ctx, fctx);
      if (getIdx !== undefined) {
        const objExprType = compileExpression(ctx, fctx, expr.expression);
        // If the expression produced a ref/ref_null (struct), convert to externref
        // so that __extern_get (which expects externref) can be used.
        if (objExprType && (objExprType.kind === "ref" || objExprType.kind === "ref_null")) {
          fctx.body.push({ op: "extern.convert_any" });
        }
        // If the expression produced f64, box it to externref
        if (objExprType && objExprType.kind === "f64") {
          addUnionImports(ctx);
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
        }
        // If the expression produced i32, convert to externref via f64 + box
        if (objExprType && objExprType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          addUnionImports(ctx);
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
        }
        // Null check: throw TypeError for property access on null/undefined
        const objTmp = allocLocal(fctx, `__nullchk_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.tee", index: objTmp });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: typeErrorThrowInstrs(ctx, expr),
          else: [],
        });
        // Multi-struct dispatch: the externref may actually be a WasmGC struct
        // (converted via extern.convert_any).  JS __extern_get cannot read GC
        // struct fields, so try struct.get first for all struct types that
        // have a field matching propName.  Only fall back to __extern_get for
        // genuine host-provided externref objects.
        const structCandidates = findAlternateStructsForField(ctx, propName, -1);
        if (structCandidates.length > 0) {
          // Convert externref -> anyref for struct type testing
          const tmpAnyExt = allocLocal(fctx, `__sd_any_${fctx.locals.length}`, { kind: "anyref" });
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "any.convert_extern" } as Instr);
          fctx.body.push({ op: "local.set", index: tmpAnyExt });

          // Phase 3 (#1269): consumer-side specialization. When
          // `accessWasm` is externref (TS `any`-typed receiver) but
          // every struct candidate has the same Phase-1-inferred
          // primitive field type, narrow the dispatch result to that
          // primitive. The struct-then arm reads the field directly
          // (no `__box_number`); the extern_get-else arm calls
          // `__unbox_number` once. This eliminates the box→unbox
          // roundtrip that previously fired on `const p: any =
          // createPoint(...); p.x + p.y` style code, where Phase 1+2
          // had already typed the struct's field but Phase 3 had not
          // taught the consumer-side dispatch to use the typed read.
          let resultWasm: ValType =
            accessWasm.kind === "f64" || accessWasm.kind === "i32" ? accessWasm : ({ kind: "externref" } as const);
          if (resultWasm.kind === "externref") {
            const fieldKinds = new Set(structCandidates.map((c) => c.fieldType.kind));
            if (fieldKinds.size === 1) {
              const k = [...fieldKinds][0];
              if (k === "f64" || k === "i32") {
                resultWasm = { kind: k } as ValType;
                if (unboxIdx === undefined) {
                  unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
                  flushLateImportShifts(ctx, fctx);
                }
              }
            }
          }
          const resultLocal = allocLocal(fctx, `__sd_res_${fctx.locals.length}`, resultWasm);

          // Build the __extern_get fallback instructions
          const externGetFallback: Instr[] = [{ op: "local.get", index: objTmp } as Instr];
          addStringConstantGlobal(ctx, propName);
          externGetFallback.push(...stringConstantExternrefInstrs(ctx, propName));
          externGetFallback.push({ op: "call", funcIdx: getIdx } as Instr);
          if (resultWasm.kind === "f64" && unboxIdx !== undefined) {
            externGetFallback.push({ op: "call", funcIdx: unboxIdx } as Instr);
          } else if (resultWasm.kind === "i32" && unboxIdx !== undefined) {
            externGetFallback.push({ op: "call", funcIdx: unboxIdx } as Instr);
            externGetFallback.push({ op: "i32.trunc_sat_f64_s" });
          }
          externGetFallback.push({ op: "local.set", index: resultLocal } as Instr);

          // Build nested if/else chain for struct candidates
          const buildStructDispatch = (idx: number): Instr[] => {
            if (idx >= structCandidates.length) {
              return externGetFallback;
            }
            const cand = structCandidates[idx]!;
            const getFieldInstrs: Instr[] = [
              { op: "local.get", index: tmpAnyExt } as Instr,
              { op: "ref.cast", typeIdx: cand.structTypeIdx } as Instr,
              { op: "struct.get", typeIdx: cand.structTypeIdx, fieldIdx: cand.fieldIdx } as Instr,
            ];
            const coerce = coercionInstrs(ctx, cand.fieldType, resultWasm, fctx);
            getFieldInstrs.push(...coerce);
            getFieldInstrs.push({ op: "local.set", index: resultLocal } as Instr);

            return [
              { op: "local.get", index: tmpAnyExt } as Instr,
              { op: "ref.test", typeIdx: cand.structTypeIdx } as Instr,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: getFieldInstrs,
                else: buildStructDispatch(idx + 1),
              } as Instr,
            ];
          };

          fctx.body.push(...buildStructDispatch(0));
          fctx.body.push({ op: "local.get", index: resultLocal });
          // Phase 3 (#1269): when we narrowed `resultWasm` to the
          // candidates' shared primitive type, return that — caller
          // sees f64/i32 directly, no enclosing unbox needed. Falls
          // back to the legacy accessWasm-based return when no
          // narrowing was possible.
          if (resultWasm.kind === "f64") return { kind: "f64" };
          if (resultWasm.kind === "i32") return { kind: "i32" };
          if (accessWasm.kind === "f64") return { kind: "f64" };
          if (accessWasm.kind === "i32") return { kind: "i32" };
          return { kind: "externref" };
        }

        // No struct candidates — use __extern_get directly
        fctx.body.push({ op: "local.get", index: objTmp });
        addStringConstantGlobal(ctx, propName);
        compileStringLiteral(ctx, fctx, propName);
        fctx.body.push({ op: "call", funcIdx: getIdx });
        if (accessWasm.kind === "f64") {
          if (unboxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: unboxIdx });
          }
          return { kind: "f64" };
        }
        if (accessWasm.kind === "i32") {
          if (unboxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: unboxIdx });
          }
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          return { kind: "i32" };
        }
        return { kind: "externref" };
      }
    }
  }

  // Any WasmGC struct (arrays, Date, user objects) can have named properties added via
  // Object.defineProperty, stored in a sidecar WeakMap at runtime. When a named property
  // is accessed on a struct-typed object that wasn't handled by any earlier path, check
  // the sidecar via __extern_get (extern.convert_any converts the struct to externref).
  // Covers: var arr = []; Object.defineProperty(arr,"prop",...); arr.prop; and Date objects.
  // Does NOT apply to class instances (ctx.classSet) to avoid disrupting typed field access (#856).
  {
    const structObjType = resolveWasmType(ctx, objType);
    const isWasmStruct =
      (structObjType.kind === "ref" || structObjType.kind === "ref_null") &&
      (structObjType as { typeIdx: number }).typeIdx !== undefined &&
      !typeName; // typeName is set for user-class structs handled above; skip those
    if (isWasmStruct) {
      const getIdx856 = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      let unboxIdx856: number | undefined;
      if (accessWasm.kind === "f64" || accessWasm.kind === "i32") {
        unboxIdx856 = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      }
      flushLateImportShifts(ctx, fctx);
      if (getIdx856 !== undefined) {
        const structExprType = compileExpression(ctx, fctx, expr.expression);
        if (structExprType && (structExprType.kind === "ref" || structExprType.kind === "ref_null")) {
          fctx.body.push({ op: "extern.convert_any" });
        }
        addStringConstantGlobal(ctx, propName);
        fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
        fctx.body.push({ op: "call", funcIdx: getIdx856 });
        if (accessWasm.kind === "f64") {
          if (unboxIdx856 !== undefined) fctx.body.push({ op: "call", funcIdx: unboxIdx856 });
          return { kind: "f64" };
        }
        if (accessWasm.kind === "i32") {
          if (unboxIdx856 !== undefined) {
            fctx.body.push({ op: "call", funcIdx: unboxIdx856 });
            fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          }
          return { kind: "i32" };
        }
        return { kind: "externref" };
      }
    }
  }

  // Fallback: emit default values for unresolvable property accesses.
  if (accessWasm.kind === "f64" || accessWasm.kind === "i32") {
    fctx.body.push({ op: accessWasm.kind === "f64" ? "f64.const" : "i32.const", value: 0 });
    return accessWasm;
  }
  if (accessWasm.kind === "externref") {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  if (accessWasm.kind === "ref" || accessWasm.kind === "ref_null") {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Last resort: emit null externref as safe default instead of trapping.
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

function compileExternPropertyGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  objType: ts.Type,
  propName: string,
): ValType | null {
  const className = objType.getSymbol()?.name;
  if (!className) return null;

  // (#1103a) Native Map `.size` accessor in standalone / nativeStrings mode →
  // `__map_size` instead of the `Map_get_size` host import. Mirrors the method
  // interception in expressions/extern.ts.
  if (className === "Map" && propName === "size" && ctx.nativeStrings) {
    addUnionImports(ctx);
    const sizeResult = tryCompileNativeMapSizeGet(ctx, fctx, expr.expression);
    if (sizeResult !== undefined) return sizeResult as ValType;
  }

  // (#2162) Native Set `.size` accessor in standalone / nativeStrings mode →
  // `__map_size` (the Set reuses the Map backing store) instead of the
  // `Set_get_size` host import.
  if (className === "Set" && propName === "size" && ctx.nativeStrings) {
    addUnionImports(ctx);
    const sizeResult = tryCompileNativeSetSizeGet(ctx, fctx, expr.expression);
    if (sizeResult !== undefined) return sizeResult as ValType;
  }

  // Walk inheritance chain to find the class that declares the property
  const resolvedInfo = findExternInfoForMember(ctx, className, propName, "property");
  const propOwner = resolvedInfo ?? ctx.externClasses.get(className);
  if (!propOwner) return null;

  const importName = `${propOwner.importPrefix}_get_${propName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) {
    // Import not found — return null silently to let the caller's fallback handle it.
    // Do NOT compile the object expression here to avoid dangling stack values.
    return null;
  }

  // Push the object and call the getter
  compileExpression(ctx, fctx, expr.expression);
  fctx.body.push({ op: "call", funcIdx });

  const propInfo = propOwner.properties.get(propName);
  return propInfo?.type ?? { kind: "externref" };
}

// ── Bounds-checked array access ──────────────────────────────────────

/**
 * Emit a bounds-checked array.get.  Stack must contain [arrayref, i32 index].
 * If the index is out of bounds (< 0 or >= array.len), a default value for the
 * element type is produced instead of trapping.
 */
export function emitBoundsGuardedArraySet(
  fctx: FunctionContext,
  vecLocal: number,
  vecTypeIdx: number,
  idxLocal: number,
  valLocal: number,
  arrTypeIdx: number,
): void {
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_u" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" as const },
    then: [
      { op: "local.get", index: vecLocal } as Instr,
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
      { op: "local.get", index: idxLocal } as Instr,
      { op: "local.get", index: valLocal } as Instr,
      { op: "array.set", typeIdx: arrTypeIdx } as Instr,
    ],
    else: [],
  } as Instr);
}

/**
 * Check if an element access expression matches a safe bounds-check-eliminated
 * pattern from a for-loop (e.g., arr[i] inside `for (...; i < arr.length; ...)`).
 */
export function isSafeBoundsEliminated(fctx: FunctionContext, expr: ts.ElementAccessExpression): boolean {
  if (!fctx.safeIndexedArrays || fctx.safeIndexedArrays.size === 0) return false;
  // Both the array and the index must be simple identifiers
  if (!ts.isIdentifier(expr.expression) || !ts.isIdentifier(expr.argumentExpression)) return false;
  const arrayVar = expr.expression.text;
  const indexVar = expr.argumentExpression.text;
  return fctx.safeIndexedArrays.has(arrayVar + ":" + indexVar);
}

// ── Element access ───────────────────────────────────────────────────

/**
 * (#1742) Read-site guard-convert for a `this`-receiver that lowered to an
 * externref but, at runtime, may carry a compiled WasmGC value (a `$vec` array
 * or a named struct).
 *
 * When a closure body reads `this[i]` / `this.length` / `this.member` and `this`
 * resolves to the `__current_this` module global (host-dispatched via
 * `__call_fn_method_N`, #1636-S1), the resolved value is a literal **externref**.
 * The realistic override `Array.prototype[Symbol.iterator] = function*(){…this[0]…}`
 * has no `this:` annotation, so TS infers `this: any` → externref; a static-type
 * gate NEVER fires (CPR_DEBUG-confirmed). The discriminator MUST therefore be a
 * **runtime `ref.test`**, not the static type.
 *
 * Emits `any.convert_extern` then, for each candidate `targetTypeIdx`, a
 * `ref.test`-guarded branch: on the FIRST hit the value is `ref.cast` to that
 * concrete ref and `thenEmit(concreteType)` runs the vec/struct read; if NONE
 * match the value is a genuine host externref and `elseEmit()` runs the host read
 * path. Both arms must leave a single value of `resultType` (read-site-guard
 * steer, NOT resolve-at-source — a real host `this` passes through unchanged).
 * Generic over receiver shape — consumed by #1719 (vec) and #1629 (struct getters).
 *
 * Stack: [externref] -> [resultType].
 */
export function emitThisReceiverGuardConvert(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetTypeIdxs: number[],
  resultType: ValType,
  thenEmit: (concreteType: ValType) => void,
  elseEmit: () => void,
): void {
  const externrefTmp = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: externrefTmp });
  fctx.body.push({ op: "any.convert_extern" } as Instr);
  const anyTmp = allocTempLocal(fctx, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyTmp });

  // Build the test/cast chain inside-out: the innermost else is the host path.
  const buildArm = (i: number): Instr[] => {
    if (i >= targetTypeIdxs.length) {
      // No compiled type matched → genuine host externref. Run the host path.
      const hostBody: Instr[] = [];
      const saved = fctx.body;
      fctx.body = hostBody;
      fctx.body.push({ op: "local.get", index: externrefTmp } as Instr);
      elseEmit();
      fctx.body = saved;
      return hostBody;
    }
    const tIdx = targetTypeIdxs[i]!;
    const thenBody: Instr[] = [];
    const saved = fctx.body;
    fctx.body = thenBody;
    fctx.body.push({ op: "local.get", index: anyTmp } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: tIdx } as Instr);
    thenEmit({ kind: "ref", typeIdx: tIdx });
    fctx.body = saved;
    return [
      { op: "local.get", index: anyTmp } as Instr,
      { op: "ref.test", typeIdx: tIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: thenBody,
        else: buildArm(i + 1),
      } as unknown as Instr,
    ];
  };

  for (const instr of buildArm(0)) fctx.body.push(instr);
  releaseTempLocal(fctx, anyTmp);
  releaseTempLocal(fctx, externrefTmp);
}

/**
 * (#1742) Candidate WasmGC vec/struct types to `ref.test` a `this`-receiver
 * externref against, or `undefined` when the guard does not apply (normal path
 * unchanged — byte-identical).
 *
 * Fires only for a `this` (`ThisKeyword`) member access in a host-dispatchable
 * closure body (`readsCurrentThis`, no local `this` binding). Because the
 * realistic override `this` is `any` → externref, the gate does NOT require a
 * static vec/struct type. It returns the candidate concrete types to test at
 * runtime:
 *   - the static `this` type when it already names a compiled vec/struct (covers
 *     `this: T[]` / `this: Point` annotations — tested first);
 *   - for an element access (`this[i]`), the registered numeric/externref `$vec`
 *     types (covers the untyped override `this` over a compiled array);
 *   - for a `.member` access, the registered vec types are NOT added (a bare
 *     `this.member` on an untyped receiver stays on the host path).
 */
function thisReceiverGuardTargets(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objExpr: ts.Expression,
  kind: "element" | "lengthOrProperty",
): number[] | undefined {
  if (objExpr.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  if (!fctx.readsCurrentThis || ctx.currentThisGlobalIdx < 0) return undefined;
  // A local `this` binding (struct method / constructor) is NOT the
  // __current_this externref path — it already carries the concrete ref.
  if (fctx.localMap.has("this")) return undefined;

  const targets: number[] = [];
  const seen = new Set<number>();
  const add = (idx: number | undefined): void => {
    if (idx === undefined || idx < 0 || seen.has(idx)) return;
    const def = ctx.mod.types[idx];
    if (def?.kind === "struct" || def?.kind === "array") {
      seen.add(idx);
      targets.push(idx);
    }
  };

  // 1. Static `this` type, when it already names a compiled vec/struct.
  const thisType = ctx.checker.getNonNullableType(ctx.checker.getTypeAtLocation(objExpr));
  const wasmType = resolveWasmType(ctx, thisType);
  if (wasmType.kind === "ref" || wasmType.kind === "ref_null") {
    add((wasmType as { typeIdx: number }).typeIdx);
  }

  // 2. For element access on an untyped `this`, the registered vec types — the
  //    representation an overridden `@@iterator` `this` (a compiled array) carries.
  if (kind === "element") {
    for (const vecIdx of ctx.vecTypeMap.values()) add(vecIdx);
  }

  return targets.length > 0 ? targets : undefined;
}

/**
 * (#1742) The `this`-receiver element-access guard recompiles the index
 * expression in both branch arms, so it is only safe for side-effect-free index
 * expressions. Covers the literal / identifier / simple member shapes that the
 * overridden-iterator and `this[i]` cases use.
 */
function isThisGuardIndexSafe(arg: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(arg) ||
    ts.isStringLiteral(arg) ||
    ts.isIdentifier(arg) ||
    arg.kind === ts.SyntaxKind.ThisKeyword ||
    (ts.isPropertyAccessExpression(arg) && isThisGuardIndexSafe(arg.expression))
  );
}

/**
 * Optional element access `a?.[i]` (#2050). On a nullish base the index
 * expression — and any side effects in it — must NOT evaluate, and the result
 * is undefined-equivalent (§13.3.9 Optional Chains). Sibling of
 * compileOptionalPropertyAccess: tee the base into a local, branch on
 * `ref.is_null`, and emit the index + read only in the non-null arm.
 */
export function compileOptionalElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  // Compile the base receiver.
  const objType = compileExpression(ctx, fctx, expr.expression);
  if (!objType) return null;

  // Result type = the TS type of the whole `a?.[i]` expression. Ref types use
  // externref as the block type to avoid null-subtyping mismatches.
  const tsResultType = ctx.checker.getTypeAtLocation(expr);
  let resultType: ValType = resolveWasmType(ctx, tsResultType);
  if (resultType.kind === "ref" || resultType.kind === "ref_null") {
    resultType = { kind: "externref" };
  }

  // A non-reference base is the compiler's representation of `undefined`/`null`
  // (e.g. a `const a = null` stored as an i32 global). Such a base always
  // short-circuits: drop it and emit the default result, never touching the
  // index expression.
  if (objType.kind !== "ref" && objType.kind !== "ref_null" && objType.kind !== "externref") {
    fctx.body.push({ op: "drop" });
    if (resultType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (resultType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return resultType;
  }

  const tmp = allocLocal(fctx, `__optelem_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  const savedBody = fctx.body;
  fctx.savedBodies.push(savedBody);

  // then branch (null path): the short-circuit default.
  let thenInstrs: Instr[];
  if (resultType.kind === "f64") {
    thenInstrs = [{ op: "f64.const", value: 0 }];
  } else if (resultType.kind === "i32") {
    thenInstrs = [{ op: "i32.const", value: 0 }];
  } else {
    thenInstrs = [{ op: "ref.null.extern" }];
  }

  // else branch (non-null path): push the now-known-non-null base, then run
  // the ordinary element-access read (which compiles the index expression).
  fctx.body = [];
  fctx.body.push({ op: "local.get", index: tmp });
  const nonNullObjType: ValType =
    objType.kind === "ref_null" ? { kind: "ref", typeIdx: (objType as any).typeIdx } : objType;
  let elseResultType = compileElementAccessBody(ctx, fctx, expr, nonNullObjType);
  if (elseResultType === null) {
    // Read could not resolve to a concrete value — coerce the base ref to the
    // block result type so the `if` typechecks rather than leaking a mismatch.
    elseResultType = objType;
  }
  if (!valTypesMatch(elseResultType, resultType)) {
    coerceType(ctx, fctx, elseResultType, resultType);
  }
  const elseInstrs = fctx.body;

  popBody(fctx, savedBody);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });

  return resultType;
}

export function compileElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  // Optional chaining: a?.[i] (#2050). Short-circuits on a nullish base — the
  // index expression must NOT evaluate and the result must be undefined-
  // equivalent (§13.3.9 Optional Chains). Mirrors compileOptionalPropertyAccess.
  if (expr.questionDotToken) {
    return compileOptionalElementAccess(ctx, fctx, expr);
  }

  const jsonParseElementType = tryEmitJsonParseElementAccess(ctx, fctx, expr);
  if (jsonParseElementType !== undefined) return jsonParseElementType;

  // #1886 Slice B: linear-backed Uint8Array read `buf[i]` → i32.load8_u(ptr+i).
  // Only fires when `buf` is a registered linear-safe buffer in this function;
  // every other receiver falls through to the GC element-access path unchanged.
  const linU8Get = tryEmitLinearU8ElementGet(ctx, fctx, expr);
  if (linU8Get !== null) return linU8Get;

  // Handle super[expr] — access parent class property via computed key on `this`
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return compileSuperElementAccess(ctx, fctx, expr);
  }

  // #1482 — `process.env[<expr>]` under `--target wasi`. Mirrors the
  // PropertyAccess short-circuit but the key is a runtime expression, so we
  // compile it inline rather than using compileStringLiteral. The key must be
  // a string; we let the type checker enforce that and emit a coercion to
  // externref before the host-import call.
  if (
    ctx.wasi &&
    ctx.wasiEnvGetStrIdx >= 0 &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "process" &&
    expr.expression.name.text === "env"
  ) {
    const keyType = compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
    if (keyType && keyType.kind !== "externref") {
      coerceType(ctx, fctx, keyType, { kind: "externref" });
    }
    fctx.body.push({ op: "call", funcIdx: ctx.wasiEnvGetStrIdx });
    return { kind: "externref" };
  }

  // Handle ClassName[key] for static accessors and static properties (#848)
  // Must intercept before compiling the object expression, since the class
  // identifier doesn't compile to a useful runtime value for struct access.
  if (ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    // Resolve class expressions (var C = class {}) through the expr-name map
    const resolvedClass = ctx.classExprNameMap.get(objName) ?? objName;
    if (ctx.classSet.has(resolvedClass)) {
      const key = resolveComputedKeyExpression(ctx, expr.argumentExpression);
      if (key !== undefined) {
        // Check static accessor first
        const accessorKey = `${resolvedClass}_${key}`;
        if (ctx.classAccessorSet.has(accessorKey)) {
          const getterName = `${resolvedClass}_get_${key}`;
          const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName));
          if (funcIdx !== undefined) {
            const retType = emitGetterCallWithDummy(ctx, fctx, resolvedClass, getterName, funcIdx);
            return retType ?? { kind: "externref" };
          }
        }
        // Check static property global
        const fullName = `${resolvedClass}_${key}`;
        const globalIdx = ctx.staticProps.get(fullName);
        if (globalIdx !== undefined) {
          fctx.body.push({ op: "global.get", index: globalIdx });
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
          return globalDef?.type ?? { kind: "f64" };
        }
        // (#1388) Static method via element access: `ClassName['method']`.
        // Mirror the property-access path — emit a callable closure-struct
        // externref instead of the legacy `ref.null.extern` so that
        // `const f = C['method']; f()` actually invokes the method.
        if (ctx.staticMethodSet.has(fullName)) {
          const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
          if (funcIdx !== undefined) {
            const closureRef = emitFuncRefAsClosure(ctx, fctx, fullName, funcIdx);
            if (closureRef) {
              fctx.body.push({ op: "extern.convert_any" });
              return { kind: "externref" };
            }
            fctx.body.push({ op: "ref.null.extern" });
            return { kind: "externref" };
          }
        }
        if (ctx.classMethodSet.has(fullName)) {
          const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "ref.null.extern" });
            return { kind: "externref" };
          }
        }
      }
    }
  }

  // Handle ClassName.prototype[key] for instance accessors (#848)
  // C.prototype[key] should invoke the instance getter with a dummy this.
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.name.text === "prototype"
  ) {
    const rawName = expr.expression.expression.text;
    // Resolve class expressions (var C = class {}) through the expr-name map
    const className = ctx.classExprNameMap.get(rawName) ?? rawName;
    if (ctx.classSet.has(className)) {
      const key = resolveComputedKeyExpression(ctx, expr.argumentExpression);
      if (key !== undefined) {
        const accessorKey = `${className}_${key}`;
        if (ctx.classAccessorSet.has(accessorKey) && !ctx.staticAccessorSet.has(accessorKey)) {
          const getterName = `${className}_get_${key}`;
          const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName));
          if (funcIdx !== undefined) {
            const retType = emitGetterCallWithDummy(ctx, fctx, className, getterName, funcIdx);
            return retType ?? { kind: "externref" };
          }
        }
        // (#1394) ClassName.prototype[key] cached singleton — must reuse the
        // same cache global as the dot-form `ClassName.prototype.key`, so
        // `C.prototype['m'] === C.prototype.m` holds. Sibling of the
        // dot-access path at property-access.ts:1361–1383.
        const methodFullName = `${className}_${key}`;
        if (ctx.classMethodSet.has(methodFullName) && !ctx.staticMethodSet.has(methodFullName)) {
          const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, methodFullName));
          const structTypeIdx = ctx.structMap.get(className);
          if (funcIdx !== undefined && structTypeIdx !== undefined) {
            if (emitCachedMethodClosureAccess(ctx, fctx, methodFullName, funcIdx, structTypeIdx)) {
              return { kind: "externref" };
            }
          }
        }
      }
    }
  }

  const objType = compileExpression(ctx, fctx, expr.expression);
  if (!objType) return null;

  // (#1742) `this[i]` where `this` is the host-supplied `__current_this`
  // externref but may carry a compiled vec at runtime (a closure body dispatched
  // via `__call_fn_method_N`). The override `this` is typically `any` → externref,
  // so the discriminator is a RUNTIME `ref.test` against the registered vec types,
  // NOT the static type. On a hit we read the backing store; on a miss the value
  // is a genuine host receiver and we keep the host `__extern_get` path. The index
  // expression is recompiled in each arm, so the guard only fires for a
  // side-effect-free index. No-op for every other receiver — byte-identical.
  if (objType.kind === "externref") {
    const targets = isThisGuardIndexSafe(expr.argumentExpression)
      ? thisReceiverGuardTargets(ctx, fctx, expr.expression, "element")
      : undefined;
    if (targets !== undefined) {
      const resultType: ValType = { kind: "externref" };
      emitThisReceiverGuardConvert(
        ctx,
        fctx,
        targets,
        resultType,
        (concreteType) => {
          const elemResult = compileElementAccessBody(ctx, fctx, expr, concreteType);
          if (elemResult && elemResult.kind !== "externref") {
            coerceType(ctx, fctx, elemResult, resultType);
          } else if (!elemResult) {
            fctx.body.push({ op: "ref.null.extern" } as Instr);
          }
        },
        () => {
          const hostResult = compileElementAccessBody(ctx, fctx, expr, { kind: "externref" });
          if (hostResult && hostResult.kind !== "externref") {
            coerceType(ctx, fctx, hostResult, resultType);
          } else if (!hostResult) {
            fctx.body.push({ op: "ref.null.extern" } as Instr);
          }
        },
      );
      return resultType;
    }
  }

  // Null-guard for ref_null: throw TypeError on null, narrow to ref after check
  // In JS, null[x] and undefined[x] throw TypeError
  if (objType.kind === "ref_null") {
    if (!isProvablyNonNull(expr.expression, ctx.checker)) {
      // Emit null check that throws TypeError (#775)
      emitNullCheckThrow(ctx, fctx, objType, expr);
    }
    // After the null check (or provably non-null), the value is guaranteed non-null
    const nonNullObjType: ValType = { kind: "ref", typeIdx: (objType as any).typeIdx };
    return compileElementAccessBody(ctx, fctx, expr, nonNullObjType);
  }

  // Null-guard for externref: null[x] and undefined[x] throw TypeError (#775)
  if (objType.kind === "externref") {
    if (!isProvablyNonNull(expr.expression, ctx.checker)) {
      emitNullCheckThrow(ctx, fctx, objType, expr);
    }
  }

  return compileElementAccessBody(ctx, fctx, expr, objType);
}

/** Inner element access logic — assumes objType is on the stack and non-null */
export function compileElementAccessBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
  objType: ValType,
): ValType | null {
  // Externref element access: obj[key] → host import __extern_get(obj, externref) → externref
  if (objType.kind === "externref") {
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
    // Lazily register __extern_get if not already registered
    const funcIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    return null;
  }

  if (objType.kind !== "ref" && objType.kind !== "ref_null") {
    // Primitive types (f64, i32): box to externref and use __extern_get
    if (objType.kind === "f64") {
      // Box f64 to externref via __box_number
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else if (objType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else {
      reportError(ctx, expr, "Element access on non-array value");
      return null;
    }
    // Compile key as externref and call __extern_get
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
    const funcIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    return null;
  }

  const typeIdx = (objType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle tuple struct — element access with literal index → struct.get
  if (typeDef?.kind === "struct") {
    const isVecStructAccess =
      typeDef.fields[0]?.name === "length" &&
      typeDef.fields[1]?.name === "data" &&
      (typeDef.fields.length === 2 ||
        (typeDef.fields.length === 3 && typeDef.fields[2]?.name === "raw") ||
        // #1914 — $__regexp_match_vec: the vec subtype carrying the spec
        // exec/match result fields. Indexed reads use the same {length, data}
        // prefix; index/input are property reads, not elements.
        (typeDef.fields.length === 4 && typeDef.fields[2]?.name === "index" && typeDef.fields[3]?.name === "input"));

    if (!isVecStructAccess) {
      // Check if this is a tuple struct (registered in tupleTypeMap)
      const isTuple = Array.from(ctx.tupleTypeMap.values()).includes(typeIdx);
      if (isTuple) {
        // Tuple element access requires a literal numeric index
        if (!ts.isNumericLiteral(expr.argumentExpression)) {
          reportError(ctx, expr, "Tuple element access requires a numeric literal index");
          return null;
        }
        const fieldIdx = Number(expr.argumentExpression.text);
        if (fieldIdx < 0 || fieldIdx >= typeDef.fields.length) {
          reportError(ctx, expr, `Tuple index ${fieldIdx} out of bounds (tuple has ${typeDef.fields.length} elements)`);
          return null;
        }
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
        return typeDef.fields[fieldIdx]!.type;
      }
      // String/numeric literal index on a plain struct → resolve to struct.get by field name
      let fieldName: string | undefined;
      if (ts.isStringLiteral(expr.argumentExpression)) {
        fieldName = expr.argumentExpression.text;
      } else if (ts.isNumericLiteral(expr.argumentExpression)) {
        fieldName = expr.argumentExpression.text;
      } else if (ts.isIdentifier(expr.argumentExpression)) {
        // Const variable reference: const key = "x"; obj[key]
        const sym = ctx.checker.getSymbolAtLocation(expr.argumentExpression);
        if (sym) {
          const decl = sym.valueDeclaration;
          if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
            const declList = decl.parent;
            if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
              if (ts.isStringLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              } else if (ts.isNumericLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              }
            }
          }
        }
      }
      // Also handle computed key expressions (well-known symbols, enums, binary exprs)
      if (fieldName === undefined) {
        fieldName = resolveComputedKeyExpression(ctx, expr.argumentExpression);
      }
      if (fieldName !== undefined) {
        // Check for getter accessor first
        const objTsType = ctx.checker.getTypeAtLocation(expr.expression);
        const sName = resolveStructName(ctx, objTsType);
        if (sName) {
          const accessorKey = `${sName}_${fieldName}`;
          if (ctx.classAccessorSet.has(accessorKey)) {
            const getterName = `${sName}_get_${fieldName}`;
            const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName));
            if (funcIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx });
              // Use actual Wasm return type of the getter
              const elGetterLocalIdx = funcIdx - ctx.numImportFuncs;
              const elGetterDef = elGetterLocalIdx >= 0 ? ctx.mod.functions[elGetterLocalIdx] : undefined;
              if (elGetterDef) {
                const elGetterType = ctx.mod.types[elGetterDef.typeIdx];
                if (elGetterType?.kind === "func" && elGetterType.results.length > 0) {
                  return elGetterType.results[0]!;
                }
              }
              const propType = ctx.checker.getTypeAtLocation(expr);
              return resolveWasmType(ctx, propType);
            }
          }
        }

        if (runtimeAccessorDescriptorKey(ctx, expr.expression, fieldName) !== undefined) {
          const runtimeResult = emitRuntimeDescriptorGet(ctx, fctx, expr.expression, fieldName, expr);
          if (runtimeResult !== null) return runtimeResult;
        }

        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx >= 0) {
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          return typeDef.fields[fieldIdx]!.type;
        }
      }
      // Non-vec, non-tuple struct: fallback to externref conversion + __extern_get
      // Convert struct ref (already on stack) to externref
      fctx.body.push({ op: "extern.convert_any" });
      // Compile the key as externref
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
      // Call __extern_get(externref, externref) → externref
      {
        const funcIdx = ensureLateImport(
          ctx,
          "__extern_get",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
      return null;
    }

    // Handle vec struct (array wrapped in {length, data})
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      reportErrorNoNode(ctx, "Element access: vec data is not array");
      return null;
    }
    // Unwrap: struct.get data field, then index into backing array
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data from vec
    // #1179: hint i32 directly for the index. compileExpression will produce
    // i32 cleanly for i32 locals / integer literals (no f64 round-trip), and
    // the existing coerceType(f64→i32) path handles non-i32 results via
    // trunc_sat — same as the legacy explicit cast below.
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "i32" });
    const valueType: ValType =
      arrDef.element.kind === "i8" || arrDef.element.kind === "i16" ? { kind: "i32" } : arrDef.element;
    if (isSafeBoundsEliminated(fctx, expr)) {
      // Bounds check elided: loop guard guarantees index < array.length
      const getOp =
        arrDef.element.kind === "i8" ? "array.get_u" : arrDef.element.kind === "i16" ? "array.get_s" : "array.get";
      fctx.body.push({ op: getOp, typeIdx: arrTypeIdx } as Instr);
    } else {
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, arrDef.element);
    }
    return valueType;
  }

  if (!typeDef || typeDef.kind !== "array") {
    reportError(ctx, expr, "Element access on non-array type");
    return null;
  }

  // Compile index and convert to i32 (#1179: hint i32 directly to skip the
  // f64.convert_i32_s + i32.trunc_sat_f64_s round-trip when the index is
  // already an i32 local or integer literal).
  compileExpression(ctx, fctx, expr.argumentExpression, { kind: "i32" });
  const valueType: ValType =
    typeDef.element.kind === "i8" || typeDef.element.kind === "i16" ? { kind: "i32" } : typeDef.element;

  if (isSafeBoundsEliminated(fctx, expr)) {
    // Bounds check elided: loop guard guarantees index < array.length
    const getOp =
      typeDef.element.kind === "i8" ? "array.get_u" : typeDef.element.kind === "i16" ? "array.get_s" : "array.get";
    fctx.body.push({ op: getOp, typeIdx } as Instr);
  } else {
    emitBoundsCheckedArrayGet(fctx, typeIdx, typeDef.element);
  }
  return valueType;
}
