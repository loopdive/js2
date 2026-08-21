// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Built-in static-method call dispatch extracted from the property-access arm of
// the ~13k-line compileCallExpression (#742, Wave B mega-function decomposition,
// slice 2). The single exported entry `compileBuiltinStaticCall` handles static
// method calls on the built-in value-type namespaces — Math, BigInt, Number,
// Array, String, and Object (`Math.max`, `Number.isInteger`, `Array.from`,
// `String.fromCharCode`, `Object.keys`, …). It returns `undefined` when the
// callee is not one of these, so the caller in calls.ts continues its dispatch
// chain. Moved verbatim: the emitted Wasm is byte-identical.
import { ts } from "../../ts-api.js";
import { isBooleanType, isNumberType, isStringType } from "../../checker/type-mapper.js";
import { ensureIntegrityPredicate } from "../object-integrity-carrier.js"; // (#4032)
import { emitToInt32 } from "../binary-ops.js";
import { integrityVarKey, widenedVarKeyFromDecl } from "../widened-var-key.js";
import type { Instr, ValType } from "../../ir/types.js";
import { isPristineEs5IntrinsicIsFrozenCall } from "../../ir/object-integrity.js";
import { resolveArrayInfo } from "../array-methods.js";
import { numberIsPredicateOps } from "../number-is-predicate-ops.js";
import { sameValueNumberOps } from "../same-value-number-ops.js";
import {
  emitArrayIteratorPrototypeSingleton,
  emitFunctionPrototypeObjectSingleton,
  emitGeneratorFunctionPrototypeSingleton,
  emitGeneratorPrototypeSingleton,
  emitTypedArrayIntrinsicCtorObject,
  isWiredTypedArrayViewName,
} from "../array-object-proto.js";
import { undefinedExternInstrs } from "../any-helpers.js";
import { BUILTIN_STATIC_METHOD_ARITY, pushBuiltinFnSingletonValueInstrs } from "../builtin-fn-meta.js";
import {
  ensureFunctionPrototypeCallHelper,
  tryEmitNonCallableNamespaceInvokerThrow,
} from "../function-prototype-callable.js";
import {
  allocJoinFoldLocals,
  emitStringJoinFold,
  emitVariadicStringConcat,
  nativeStringRepr,
} from "../builtin-scaffold.js";
import { emitThrowRangeError } from "../js-errors.js";
import {
  isSymbolSpeciesKeyExpression,
  resolveBuiltinProtoGopdReceiver,
  resolveBuiltinReceiverName,
  tryEmitStandaloneBuiltinSpeciesGopd,
  tryEmitStandaloneBuiltinStaticGopd,
  tryEmitStandaloneStructGopdKeyDispatch,
} from "../builtin-static-gopd.js";
import { tryEmitBuiltinProtoConstructorDescriptor } from "../builtin-proto-constructor.js";
import { compileArrowAsClosure } from "../closures.js";
import { popBody, pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import { rollbackSpeculative, snapshotSpeculative } from "../context/speculative.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitGlobalThisGopdFold } from "../dyn-read.js";
import { dynamicProtoRootFor, dynamicProtoFieldIdx, reserveDynprotoNorm } from "../dynamic-proto.js"; // (#802)
import { emitNativeGeneratorToVec, nativeGeneratorInfoForForOfSubject } from "../generators-native.js";
import {
  addStringConstantGlobal,
  addStringImports,
  addUnionImports,
  getArrTypeIdxFromVec,
  getOrRegisterVecType,
  nativeStringType,
  resolveWasmType,
  TYPED_ARRAY_NAMES,
  typedArrayVecStorage,
} from "../index.js";
import { ensureNativeArrayFromMapped, ensureNativeIteratorRuntime } from "../iterator-native.js";
import { ensureUint8FromBase64, ensureUint8FromHex } from "../uint8-codec.js";
import {
  compileArrayConstructorCall,
  compileArrayLiteral,
  compileObjectLiteralAsExternref,
  materializeStructAsDynamicObject,
} from "../literals.js";
import { emitCollectionIteratorVec, ensureMapGroupBy } from "../map-runtime.js";
import {
  emitBrandCheckTypeError,
  emitLazyNativeProtoGet,
  ensureStandaloneNativeMethodClosure,
  getNativeProtoBuiltinGlue,
} from "../native-proto.js";
import {
  ensureNativeStringExternBridge,
  ensureNativeStringHelpers,
  ensureStrToCharVecHelper,
  nativeStringLiteralInstrs,
  stringConstantExternrefInstrs,
} from "../native-strings.js";
import {
  compileObjectDefineProperties,
  compileObjectDefineProperty,
  compileObjectKeysOrValues,
} from "../object-ops.js";
import {
  ensureNativeProxyRuntime,
  ensureObjVecBuilders,
  ensureObjectGroupBy,
  ensureObjectRuntime,
} from "../object-runtime.js";
import { isArrayCarrierValType } from "../array-carrier-brand.js"; // (#4556)
import {
  BUILTIN_CTOR_NAMES,
  emitArrayIsArrayExternrefPredicate,
  tryEnsureNativeProtoBrand,
} from "../property-access.js";
import { isGlobalRegExpIdentifier, isStaticallyUndefinedExpr } from "../regexp-standalone.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, valTypesMatch, VOID_RESULT } from "../shared.js";
import { compileStringLiteral } from "../string-ops.js";
import { ensureStringRawHelper } from "../string-raw.js";
import { defaultValueInstrs, pushDefaultValue } from "../type-coercion.js";
import { compileMathCall } from "./builtins.js";
import { tryCompileObjectCreateStaticPrototype } from "./call-object-builtins.js";
import { emitLazyProtoGet } from "./extern.js";
import { buildThrowJsErrorInstrs, emitThrowTypeError, noJsHost } from "./helpers.js";
import { mayStaticallyExpandCreateDescriptor, staticDescriptorTypeError } from "../descriptor-shape.js";
import { emitUndefined, ensureGetUndefined, ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { resolveStructName } from "./misc.js";
import { tryCompileEs5GetPrototypeOfEarly, tryCompileEs5GetPrototypeOfValue } from "./object-get-prototype-of.js";
import { tryCompileFnctorInstanceGetPrototypeOf } from "../fnctor-instance-prototype.js";
import {
  BUILTIN_CLASS_NAMES,
  compileCallExpression,
  compileFromCharCodeFamily,
  compileNumberIsPredicate,
  compileObjectAssignArg,
  compileProtoArg,
  isGlobalBuiltinIdentifier,
  staticToBoolean,
  tracesToTypedArrayIntrinsicProto,
} from "./calls.js";

/**
 * Reified builtin method closures are ordinary function objects whose
 * [[Prototype]] is %Function.prototype%. Preserve their exact metadata subtype
 * long enough to route around the generic `$Object`-only prototype helper.
 */
function tryEmitBuiltinFunctionPrototype(ctx: CodegenContext, fctx: FunctionContext, argType: ValType): boolean {
  if (
    (!ctx.standalone && !ctx.wasi) ||
    (argType.kind !== "ref" && argType.kind !== "ref_null") ||
    !ctx.builtinFnMetaByTypeIdx?.has(argType.typeIdx)
  ) {
    return false;
  }

  fctx.body.push({ op: "drop" });
  const functionBrand = tryEnsureNativeProtoBrand(ctx, "Function");
  if (functionBrand !== undefined && emitLazyNativeProtoGet(ctx, fctx, functionBrand)) {
    return true;
  }
  fctx.body.push({ op: "ref.null.extern" });
  return true;
}

function emitBuiltinGetPrototypeOfFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
): InnerResult {
  const argType = compileExpression(ctx, fctx, arg);
  if (!argType) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  if (tryEmitBuiltinFunctionPrototype(ctx, fctx, argType)) {
    return { kind: "externref" };
  }
  if (argType.kind !== "externref") {
    coerceType(ctx, fctx, argType, { kind: "externref" });
  }
  const getPrototypeIdx = ensureLateImport(ctx, "__getPrototypeOf", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (getPrototypeIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: getPrototypeIdx });
  } else {
    fctx.body.push({ op: "drop" }, { op: "ref.null.extern" });
  }
  return { kind: "externref" };
}

/**
 * (#742 slice 2) Built-in static-method call dispatch — extracted verbatim from
 * the property-access arm of compileCallExpression. Handles static method calls
 * on the built-in value-type namespaces whose callee is `Namespace.method(...)`:
 * Math, BigInt, Number, Array, String, and Object (e.g. `Math.max`,
 * `Number.isInteger`, `Array.from`, `String.fromCharCode`, `Object.keys`, …).
 *
 * `propAccess` is the already-narrowed `expr.expression`. Returns an InnerResult
 * when it handled the call, or `undefined` when the callee is not one of these
 * built-in static cases — the caller then continues its dispatch chain (Symbol,
 * Reflect, Promise, JSON, Date, then receiver-type method dispatch). Moved
 * unchanged so the emitted Wasm is byte-identical.
 */
/**
 * (#4047) `Object.create(proto, undefined)` — §20.1.2.2 step 3 is CONDITIONAL:
 * "If properties is **not undefined**, return ? ObjectDefineProperties(obj,
 * properties)". So it defines nothing and is NOT a ToObject error. The generic
 * two-argument arm handed `undefined` straight to `__defineProperties`, whose
 * own §20.1.2.3.1 step 1 `ToObject(undefined)` correctly throws a TypeError.
 * Two different spec steps, one of which does not apply here.
 *
 * Only the STATIC spelling is folded away (`undefined` / `void 0`). A
 * runtime-valued `properties` that happens to hold `undefined` still reaches
 * the helper and throws; folding that needs an is-undefined test at the
 * externref boundary and is left to the receiver work in #4010.
 *
 * The created object is already on the stack. The properties argument is still
 * compiled and dropped — `void sideEffect()` is a legal spelling of a
 * statically-undefined expression.
 */
function emitObjectCreateWithUndefinedProperties(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propertiesArg: ts.Expression,
): void {
  const objLocal = allocLocal(fctx, `__ocreate_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });
  const propsType = compileExpression(ctx, fctx, propertiesArg);
  if (propsType) fctx.body.push({ op: "drop" });
  fctx.body.push({ op: "local.get", index: objLocal });
}

/**
 * `Object.create(proto, properties)` where `properties` is not an object
 * literal — delegate to `__defineProperties` (a defined native under
 * standalone, the host import otherwise). The created object is on the stack.
 *
 * (#4047) Dispatches the statically-undefined spelling away first; see
 * {@link emitObjectCreateWithUndefinedProperties} for why that is a different
 * spec step and not merely an optimisation.
 */
function emitObjectCreateDynamicProperties(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propertiesArg: ts.Expression,
): void {
  if (isStaticallyUndefinedExpr(propertiesArg)) {
    emitObjectCreateWithUndefinedProperties(ctx, fctx, propertiesArg);
    return;
  }
  const objLocal = allocLocal(fctx, `__ocreate_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  const dpIdx = ensureLateImport(
    ctx,
    "__defineProperties",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);

  if (dpIdx === undefined) {
    // No host import available — just return obj without descriptors.
    fctx.body.push({ op: "local.get", index: objLocal });
    return;
  }
  fctx.body.push({ op: "local.get", index: objLocal });
  const descType = compileExpression(ctx, fctx, propertiesArg);
  if (!descType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (descType.kind !== "externref") {
    // (#3394) Use coerceType, not a bare extern.convert_any: a PRIMITIVE
    // descriptors arg (e.g. `Object.create(o, 5n)` — a bigint, which is a
    // TypeError at runtime but must still COMPILE to valid Wasm) is i64/i32/f64
    // on the stack, and extern.convert_any is illegal on a non-ref value
    // ("extern.convert_any expected anyref, found i64"). coerceType routes
    // i64-bigint → __box_bigint, i32/f64 → __box_*, ref → extern.convert_any.
    coerceType(ctx, fctx, descType, { kind: "externref" });
  }
  fctx.body.push({ op: "call", funcIdx: dpIdx });
}

export function compileBuiltinStaticCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  // #4385 — ES5 §15.3.4: `%Function.prototype%` is itself callable, ignores
  // its arguments, and returns undefined. The generic `Namespace.member()`
  // path otherwise asks `__get_builtin` for a dynamic property and hard-refuses
  // in standalone. Keep this exact to the ambient `Function` binding: a local
  // object named Function must retain ordinary member-call semantics.
  if (
    noJsHost(ctx) &&
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Function" &&
    propAccess.name.text === "prototype" &&
    isGlobalBuiltinIdentifier(ctx, fctx, propAccess.expression)
  ) {
    for (const argument of expr.arguments) {
      const argumentType = compileExpression(ctx, fctx, argument);
      if (argumentType) fctx.body.push({ op: "drop" });
    }
    const helperIdx = ensureFunctionPrototypeCallHelper(ctx);
    if (helperIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      return { kind: "externref" };
    }
  }

  // (§20.2.3.1-.3) `JSON.bind()` and friends — a non-callable builtin namespace
  // receiving `bind`/`call`/`apply`: catchable TypeError, not a `__get_builtin`
  // hard refusal. Rationale + scope live with the helper.
  if (
    noJsHost(ctx) &&
    ts.isIdentifier(propAccess.expression) &&
    isGlobalBuiltinIdentifier(ctx, fctx, propAccess.expression) &&
    tryEmitNonCallableNamespaceInvokerThrow(ctx, fctx, propAccess)
  ) {
    return { kind: "externref" };
  }

  if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Math") {
    const mathResult = compileMathCall(ctx, fctx, propAccess.name.text, expr);
    if (mathResult !== undefined) return mathResult;
    // Unknown Math method — fall through to generic call handling
    // (e.g. Array.prototype.every.call(Math, ...) rewritten as Math.every(...))
  }

  // (#3145) `Atomics.<method>(...)` in a host-free target (--target
  // standalone / wasi). Host-free mode has no `SharedArrayBuffer` (it is on
  // the skip list) and no shared-memory atomics backend, so EVERY Atomics
  // operation runs on a necessarily non-shared view — which the ES spec
  // rejects: `ValidateIntegerTypedArray` throws a TypeError for float/clamped
  // views and for the non-`Int32Array`/`BigInt64Array` views the waitable ops
  // (`wait`/`waitAsync`/`notify`) require, and a detached buffer is likewise a
  // TypeError. Rather than leak the dynamic `env::__get_builtin` host import
  // (the #1472 Phase B refusal that hard-CEs these ~29 error-path tests),
  // degrade the CALL to a catchable TypeError. This is exactly the behaviour
  // #2984 Phase 3 already reifies for the first-class Atomics method VALUE
  // (`const f = Atomics.add; f(v,0,1)` throws when invoked); routing the
  // direct call here keeps the two paths observationally identical. The throw
  // fires BEFORE any argument coercion, matching the spec ordering that the
  // `notify(view, {valueOf(){throw}}, …)` "should not evaluate" tests assert.
  // Real atomic semantics stay gated on SharedArrayBuffer (out of scope).
  if (
    noJsHost(ctx) &&
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Atomics" &&
    isGlobalBuiltinIdentifier(ctx, fctx, propAccess.expression) &&
    BUILTIN_STATIC_METHOD_ARITY.Atomics?.[propAccess.name.text] !== undefined
  ) {
    emitThrowTypeError(
      ctx,
      fctx,
      `Atomics.${propAccess.name.text} requires a shared integer TypedArray, which is unsupported in --target standalone`,
    );
    // The throw is stack-polymorphic; return the nominal (any-boundary) type.
    return { kind: "externref" };
  }

  // (#3148) Standalone/WASI-native BigInt.asIntN(bits, bigint) /
  // BigInt.asUintN(bits, bigint) — §21.2.2.1 / §21.2.2.2. The generic
  // member-call path routes `BigInt.*` through the dynamic-shape
  // `env::__get_builtin` host import, which refuses-loud under standalone
  // (#1472 Phase B) → 20 hard CEs under built-ins/BigInt/{asIntN,asUintN}/.
  // Here the modular wrap is lowered to pure i64 ops over the #1644 i64-brand
  // BigInt rep (`{kind:"i64", bigint:true}`), with NO JS host import. Host
  // (gc) mode keeps the `__get_builtin` path (which produces a real JS
  // BigInt), so this arm is gated on no-JS-host.
  //
  // Representability note: the i64-brand rep holds only the low 64 bits of a
  // BigInt, which is exactly what asIntN/asUintN of `bits <= 64` observes, so
  // those are computed correctly even for source literals wider than 64 bits.
  // For `bits > 64` we return the value unchanged: asIntN is exact, and
  // asUintN is exact for non-negative values (a negative value with bits>=64
  // is inherently not representable in i64 — documented out of scope).
  if (
    (ctx.standalone === true || ctx.wasi === true) &&
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "BigInt" &&
    (propAccess.name.text === "asIntN" || propAccess.name.text === "asUintN")
  ) {
    const isIntN = propAccess.name.text === "asIntN";
    const bitsArg = expr.arguments[0];
    const valArg = expr.arguments[1];

    // Step 1 — bits = ? ToIndex(bits). ToNumber → truncate toward zero →
    // RangeError when < 0 or > 2^53-1. A missing bits argument is
    // `undefined` ⇒ ToNumber(undefined) = NaN ⇒ ToIntegerOrInfinity = 0.
    // ToIndex(bits) runs BEFORE ToBigInt(value) (order-of-steps.js): the
    // bits argument (and its valueOf) is fully evaluated here first.
    const bitsF64Idx = allocLocal(fctx, `__asN_bits_${fctx.locals.length}`, { kind: "f64" });
    if (bitsArg !== undefined) {
      compileExpression(ctx, fctx, bitsArg, { kind: "f64" });
    } else {
      fctx.body.push({ op: "f64.const", value: NaN });
    }
    // ToIntegerOrInfinity: truncate toward zero (NaN stays NaN; mapped to 0
    // by the RangeError-free trunc_sat below).
    fctx.body.push({ op: "f64.trunc" } as Instr);
    fctx.body.push({ op: "local.tee", index: bitsF64Idx });
    // RangeError guard: bits < 0 OR bits > 2^53-1. NaN fails both comparisons
    // (no throw) and is later mapped to 0. ±Infinity is caught (−∞ < 0,
    // +∞ > 2^53-1).
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.lt" } as Instr);
    fctx.body.push({ op: "local.get", index: bitsF64Idx });
    fctx.body.push({ op: "f64.const", value: 9007199254740991 }); // 2^53 - 1
    fctx.body.push({ op: "f64.gt" } as Instr);
    fctx.body.push({ op: "i32.or" });
    {
      const throwInstrs = buildThrowJsErrorInstrs(
        ctx,
        "RangeError",
        `RangeError: bits must be in the range 0 to 2^53-1 in BigInt.as${isIntN ? "IntN" : "UintN"}`,
        { flush: fctx },
      );
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: [] } as Instr);
    }
    // bits as an i64 count in [0, 2^53-1]. Signed trunc_sat is exact for this
    // range and maps NaN→0 (spec: ToIntegerOrInfinity(NaN) = 0).
    const bitsI64Idx = allocLocal(fctx, `__asN_bitsI_${fctx.locals.length}`, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: bitsF64Idx });
    fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
    fctx.body.push({ op: "local.set", index: bitsI64Idx });

    // Step 2 — value = ? ToBigInt(value). A missing value argument is
    // `undefined`, and ToBigInt(undefined) is a TypeError (§7.1.13).
    if (valArg === undefined) {
      emitThrowTypeError(ctx, fctx, "TypeError: Cannot convert undefined to a BigInt");
      // The throw is stack-polymorphic; return the nominal bigint result type.
      return { kind: "i64", bigint: true };
    }
    const valI64Idx = allocLocal(fctx, `__asN_val_${fctx.locals.length}`, { kind: "i64", bigint: true });
    // Expected-type `{kind:"i64", bigint:true}` drives the ToBigInt coercion:
    // identity on a bigint, `__to_bigint` on an any/string/boolean/object
    // carrier (which throws TypeError on undefined/null/symbol/number).
    compileExpression(ctx, fctx, valArg, { kind: "i64", bigint: true });
    fctx.body.push({ op: "local.set", index: valI64Idx });

    // Step 3 — modular wrap in i64. The shift/mask forms below are valid only
    // for 1 <= bits <= 63; bits==0 ⇒ 0n and bits>=64 ⇒ value are special-cased
    // (Wasm shift counts are taken mod 64, so a raw 64-bits shift would alias
    // to 0 and mis-handle the boundary).
    const resultIdx = allocLocal(fctx, `__asN_res_${fctx.locals.length}`, { kind: "i64", bigint: true });
    const innerElse: Instr[] = isIntN
      ? [
          // asIntN: sign-extend bit (bits-1) via (v << (64-bits)) >>_s (64-bits).
          { op: "local.get", index: valI64Idx },
          { op: "i64.const", value: 64n },
          { op: "local.get", index: bitsI64Idx },
          { op: "i64.sub" } as Instr,
          { op: "i64.shl" } as Instr,
          { op: "i64.const", value: 64n },
          { op: "local.get", index: bitsI64Idx },
          { op: "i64.sub" } as Instr,
          { op: "i64.shr_s" } as Instr,
          { op: "local.set", index: resultIdx },
        ]
      : [
          // asUintN: mask the low `bits` bits via v & ((1 << bits) - 1).
          { op: "local.get", index: valI64Idx },
          { op: "i64.const", value: 1n },
          { op: "local.get", index: bitsI64Idx },
          { op: "i64.shl" } as Instr,
          { op: "i64.const", value: 1n },
          { op: "i64.sub" } as Instr,
          { op: "i64.and" } as Instr,
          { op: "local.set", index: resultIdx },
        ];
    const geq64Branch: Instr[] = [
      { op: "local.get", index: bitsI64Idx },
      { op: "i64.const", value: 64n },
      { op: "i64.ge_u" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: valI64Idx },
          { op: "local.set", index: resultIdx },
        ],
        else: innerElse,
      } as Instr,
    ];
    fctx.body.push({ op: "local.get", index: bitsI64Idx });
    fctx.body.push({ op: "i64.eqz" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i64.const", value: 0n },
        { op: "local.set", index: resultIdx },
      ],
      else: geq64Branch,
    } as Instr);
    fctx.body.push({ op: "local.get", index: resultIdx });
    return { kind: "i64", bigint: true };
  }

  // #2590 — RegExp.escape(s) (ES2025, §22.2.5). A pure string transform that
  // escapes regex-syntax-significant code points. Standalone-only: routing it
  // through the native `__regex_escape` helper avoids leaking the dynamic
  // `env::__get_builtin` host import (which would otherwise refuse / fail to
  // instantiate). Placed before the generic builtin-member fallthrough.
  if (
    ctx.standalone &&
    ts.isIdentifier(propAccess.expression) &&
    isGlobalRegExpIdentifier(ctx, propAccess.expression) &&
    propAccess.name.text === "escape" &&
    ctx.nativeStrings
  ) {
    const arg = expr.arguments[0];
    const argTsType = arg ? ctx.checker.getTypeAtLocation(arg) : undefined;
    const argFlags = argTsType?.flags ?? 0;
    const isStringArg = arg !== undefined && (isStringType(argTsType!) || (argFlags & ts.TypeFlags.StringLike) !== 0);
    const isUnresolvedArg = (argFlags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    if (isStringArg) {
      ensureNativeStringHelpers(ctx);
      const escapeIdx = ctx.nativeStrHelpers.get("__regex_escape");
      if (escapeIdx !== undefined) {
        compileExpression(ctx, fctx, arg!, nativeStringType(ctx));
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: ctx.nativeStrHelpers.get("__regex_escape")! });
        return nativeStringType(ctx);
      }
    } else if (arg !== undefined && !isUnresolvedArg) {
      // §22.2.5 step 1: a statically non-String argument is a TypeError.
      // (number / object / array / null / undefined literals — the
      // non-string-inputs.js test exercises exactly these.)
      emitBrandCheckTypeError(ctx, fctx.body, "RegExp.escape called on a non-string value");
      fctx.body.push({ op: "unreachable" });
      return nativeStringType(ctx);
    }
    // `any`/`unknown` arg → narrow-refuse (fall through to the generic path).
  }

  // Handle Number.isNaN(n) and Number.isInteger(n)
  if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Number") {
    const method = propAccess.name.text;
    // #2034: `Number.is*` predicates must NOT coerce their argument — a
    // non-Number value is `false` (ES §21.1.2.x). compileNumberIsPredicate
    // guards an any-typed argument with `__typeof_number` before applying the
    // numeric test; a static number keeps the direct f64 fast path.
    // No argument ⇒ the argument is `undefined`, whose Type is not Number, so
    // every `Number.is*` predicate returns `false` (ES §21.1.2.x). Without this
    // the `arguments.length >= 1` guards below fall through to the generic
    // member-call path and mis-handle the bare call.
    // (test262 Number/{isInteger,isFinite,isNaN,isSafeInteger}/arg-is-not-number.js.)
    if (
      expr.arguments.length === 0 &&
      (method === "isNaN" || method === "isInteger" || method === "isFinite" || method === "isSafeInteger")
    ) {
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }
    if (method === "isNaN" && expr.arguments.length >= 1) {
      // NaN !== NaN is true; for any other number it's false.
      return compileNumberIsPredicate(ctx, fctx, expr.arguments[0]!, (v) => numberIsPredicateOps("isNaN", v));
    }
    if (method === "isInteger" && expr.arguments.length >= 1) {
      // n === trunc(n) && isFinite(n)
      return compileNumberIsPredicate(ctx, fctx, expr.arguments[0]!, (v) => numberIsPredicateOps("isInteger", v));
    }
    if (method === "isFinite" && expr.arguments.length >= 1) {
      // isFinite(n) → n - n === 0.0
      return compileNumberIsPredicate(ctx, fctx, expr.arguments[0]!, (v) => numberIsPredicateOps("isFinite", v));
    }
    if (method === "isSafeInteger" && expr.arguments.length >= 1) {
      // isSafeInteger(n) = isInteger(n) && abs(n) <= MAX_SAFE_INTEGER
      return compileNumberIsPredicate(ctx, fctx, expr.arguments[0]!, (v) => numberIsPredicateOps("isSafeInteger", v));
    }
    if ((method === "parseFloat" || method === "parseInt") && expr.arguments.length >= 1) {
      // Delegate to the global parseInt / parseFloat host import
      const funcIdx = ctx.funcMap.get(method === "parseFloat" ? "parseFloat" : "parseInt");
      if (funcIdx !== undefined) {
        compileExpression(ctx, fctx, expr.arguments[0]!, {
          kind: "externref",
        });
        if (method === "parseInt") {
          if (expr.arguments.length >= 2) {
            compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
          } else {
            // No radix supplied — push NaN sentinel so runtime treats it as undefined
            fctx.body.push({ op: "f64.const", value: NaN });
          }
        }
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "f64" };
      }
    }
  }

  // (#1467) Error.isError(v) — ES2025 static method.
  // Returns true for any value with an [[ErrorData]] internal slot. Host
  // import returns i32 (0/1); coerce to f64 / leave as i32 depending on
  // caller context — we return i32 so callers can use it as a boolean.
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Error" &&
    propAccess.name.text === "isError" &&
    expr.arguments.length >= 1
  ) {
    const isErrorIdx = ensureLateImport(ctx, "__error_isError", [{ kind: "externref" }], [{ kind: "i32" }]);
    if (isErrorIdx !== undefined) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (argType && argType.kind !== "externref") {
        if (argType.kind === "ref" || argType.kind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        } else {
          // Numbers, bools, etc. aren't errors — drop and push 0.
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: 0 });
          return { kind: "i32" };
        }
      }
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "call", funcIdx: isErrorIdx });
      return { kind: "i32" };
    }
  }

  // Handle Array.isArray(x) — compile-time type check
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Array" &&
    propAccess.name.text === "isArray" &&
    expr.arguments.length >= 1
  ) {
    const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!); // compile-time arg type
    const argWasmType = resolveWasmType(ctx, argTsType);
    // externref args carry values whose array-ness can't be decided
    // statically. Two runtime cases must both be handled:
    //   (#1678) a compiled native array materialised into the externref slot
    //     (e.g. a rest/array binding default whose value is `any`-typed
    //     becomes a __vec_externref) — detected via `ref.test` against every
    //     registered vec struct type. Pure Wasm, works in standalone/WASI.
    //   (#1328) a genuine host JS value (e.g. a RegExp match result) — these
    //     are not WasmGC vec structs, so fall back to the host predicate
    //     `__extern_is_array` when a JS host is present.
    // We OR the two checks so neither case regresses; in standalone mode the
    // host predicate is simply absent and only the `ref.test` path runs.
    if (argWasmType.kind === "externref") {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (argType && argType.kind !== "externref") {
        // Non-externref values (numbers, bools) are never arrays.
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      emitArrayIsArrayExternrefPredicate(ctx, fctx);
      return { kind: "i32" };
    }
    // (#4556) A ref to a real array CARRIER — ref-ness alone is NOT array-ness.
    const isArr = isArrayCarrierValType(ctx, argWasmType);
    // Still compile the argument for side effects, then drop it
    const argSideType = compileExpression(ctx, fctx, expr.arguments[0]!);
    if (argSideType) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: isArr ? 1 : 0 });
    return { kind: "i32" };
  }

  // Handle String.fromCharCode(code) — native helper (nativeStrings) or host import
  // (#2875 slice 5) No `arguments.length >= 1` gate: zero-arg
  // `String.fromCharCode()` is spec-valid (§22.1.2.1 — empty codeUnits list
  // → "") and folds through the same family lowering
  // (`emitVariadicStringConcat` returns the empty-string literal for zero
  // parts). The old gate dropped it to the generic member-call path, which
  // is a `__get_builtin` Phase-B refusal → CE in standalone (S15.5.3.2_A2).
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "String" &&
    propAccess.name.text === "fromCharCode"
  ) {
    // #1598: nativeStrings mode (forced on for --target wasi / standalone) uses
    // a pure-Wasm __str_fromCharCode helper — no env.String_fromCharCode import.
    // #2088: the variadic concat fold is shared via compileFromCharCodeFamily.
    if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
      const helperIdx = ctx.nativeStrHelpers.get("__str_fromCharCode");
      if (helperIdx !== undefined) {
        const r = compileFromCharCodeFamily(ctx, fctx, expr, { native: true, helperIdx });
        if (r !== null) return r;
      }
    }
    const funcIdx = ctx.funcMap.get("String_fromCharCode");
    if (funcIdx !== undefined) {
      // #2122: fromCharCode is variadic (ES §22.1.2.1). The host import is
      // 1-arg, so each code unit produces a 1-char string joined via the
      // js-string `concat` import — register it before the shared fold so the
      // host repr can resolve it.
      if (expr.arguments.length > 1) addStringImports(ctx);
      const r = compileFromCharCodeFamily(ctx, fctx, expr, { native: false, helperIdx: funcIdx });
      if (r === null) return r;
      // In fast mode, marshal externref string to native string.
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        ensureNativeStringExternBridge(ctx);
        flushLateImportShifts(ctx, fctx);
        const fromExternIdx = ctx.nativeStrHelpers.get("__str_from_extern");
        if (fromExternIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: fromExternIdx });
        }
        return nativeStringType(ctx);
      }
      return { kind: "externref" };
    }
  }

  // Handle String.fromCodePoint(code) — native helper (nativeStrings) or host import
  // (#2875 slice 5) No arity gate — zero-arg → "" (§22.1.2.2), same
  // empty-parts fold as fromCharCode above.
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "String" &&
    propAccess.name.text === "fromCodePoint"
  ) {
    // Native strings mode: use pure-Wasm __str_fromCodePoint (no host import).
    // #2088: shares the variadic concat fold via compileFromCharCodeFamily.
    if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
      const helperIdx = ctx.nativeStrHelpers.get("__str_fromCodePoint");
      if (helperIdx !== undefined) {
        const r = compileFromCharCodeFamily(ctx, fctx, expr, { native: true, helperIdx, isFromCodePoint: true });
        if (r !== null) return r;
      }
    }
    // Host import path (non-nativeStrings mode)
    const funcIdx = ctx.funcMap.get("String_fromCodePoint");
    if (funcIdx !== undefined) {
      // #2122: variadic — each code point produces a string joined via the
      // js-string `concat` import; register it before the shared fold.
      if (expr.arguments.length > 1) addStringImports(ctx);
      const r = compileFromCharCodeFamily(ctx, fctx, expr, {
        native: false,
        helperIdx: funcIdx,
        isFromCodePoint: true,
      });
      if (r === null) return r;
      return { kind: "externref" };
    }
  }

  // (#3147/#4397) Native `String.raw(template, ...substitutions)` — the
  // ordinary FUNCTION-CALL form (§22.1.2.4). The tagged-template form
  // `String.raw\`...\`` is a TaggedTemplateExpression and never reaches this
  // CallExpression path (#2008/#2510). Without this arm the call falls to the
  // generic member-call path → `__get_builtin` → #1472 Phase B refusal
  // (22 hard CEs under built-ins/String/raw/). Compatibility host-assisted
  // mode is untouched; native-first selects this in-module provider even when
  // JavaScript supplies boundary/capability adapters. A
  // spread argument (`String.raw(...args)`) keeps today's refusal — the
  // substitution list must be statically enumerable to build the $ObjVec.
  if (
    (ctx.standalone || ctx.targetProfile.semanticProviders === "native-first") &&
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "String" &&
    propAccess.name.text === "raw" &&
    !expr.arguments.some((a) => ts.isSpreadElement(a))
  ) {
    // Register the helper (and the $ObjVec builders) BEFORE lowering the
    // args — append-only, no funcidx shift of this in-flight function; same
    // discipline as the Object.groupBy arm below.
    const stringRawIdx = ensureStringRawHelper(ctx);
    const { newIdx: vecNewIdx, pushIdx: vecPushIdx } = ensureObjVecBuilders(ctx);
    // template — evaluated first (argument order). Missing → ToObject(
    // undefined) throws; the null externref is the nullish carrier the
    // helper's TypeError check reads.
    if (expr.arguments.length >= 1) {
      const template = expr.arguments[0]!;
      // The helper performs dynamic Get(template, "raw"), so a direct typed
      // object literal must use the open `$Object` representation rather than
      // a closed anonymous struct that `__extern_get` cannot inspect. A typed
      // struct value is materialized into that same in-module representation;
      // this is an internal semantic adapter, not a JS-boundary copy.
      const tType = ts.isObjectLiteralExpression(template)
        ? compileObjectLiteralAsExternref(ctx, fctx, template)
        : compileExpression(ctx, fctx, template);
      if (tType === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (
        (tType.kind !== "ref" && tType.kind !== "ref_null") ||
        !materializeStructAsDynamicObject(ctx, fctx, tType.typeIdx, { skipInternalFields: true })
      ) {
        if (tType.kind !== "externref") coerceType(ctx, fctx, tType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // substitutions — each evaluated exactly once, in order, into an $ObjVec.
    const subsLocal = allocLocal(fctx, `__strraw_subs_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "call", funcIdx: vecNewIdx });
    fctx.body.push({ op: "local.set", index: subsLocal });
    for (let ai = 1; ai < expr.arguments.length; ai++) {
      fctx.body.push({ op: "local.get", index: subsLocal });
      const aType = compileExpression(ctx, fctx, expr.arguments[ai]!, { kind: "externref" });
      if (aType === null) fctx.body.push({ op: "ref.null.extern" });
      else if (aType.kind !== "externref") coerceType(ctx, fctx, aType, { kind: "externref" });
      fctx.body.push({ op: "call", funcIdx: vecPushIdx });
    }
    fctx.body.push({ op: "local.get", index: subsLocal });
    fctx.body.push({ op: "call", funcIdx: stringRawIdx });
    return nativeStringType(ctx);
  }

  // Handle Array.fromAsync(items, mapFn?, thisArg?) — ES2024 (#1517)
  // Delegates to host import which implements the spec algorithm using
  // native `for await...of` over async iterables, sync iterables (awaiting
  // each value), and array-likes. Returns a Promise externref; the outer
  // `await` unwraps it via the standard async/await machinery.
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Array" &&
    propAccess.name.text === "fromAsync"
  ) {
    // items
    if (expr.arguments.length >= 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // mapFn
    if (expr.arguments.length >= 2) {
      const mapType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
      if (mapType && mapType.kind !== "externref") coerceType(ctx, fctx, mapType, { kind: "externref" });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // thisArg
    if (expr.arguments.length >= 3) {
      const thisType = compileExpression(ctx, fctx, expr.arguments[2]!, { kind: "externref" });
      if (thisType && thisType.kind !== "externref") coerceType(ctx, fctx, thisType, { kind: "externref" });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const fromAsyncIdx = ensureLateImport(
      ctx,
      "__array_from_async",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (fromAsyncIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: fromAsyncIdx });
      return { kind: "externref" };
    }
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // (#3150) Standalone-native `Uint8Array.fromHex(string)` — decode a hex string
  // to a fresh packed-`i8` Uint8Array vec (the same backing `new Uint8Array` /
  // `Uint8Array.of` produce standalone). Only a STRING-typed argument routes here
  // — per spec `fromHex(arg)` throws a TypeError WITHOUT ToString coercion for a
  // non-string, so a non-string arg falls through to the existing refusal (no
  // silent wrong coercion, no regression). Options / `fromBase64` / instance
  // `toHex`/`setFromHex` are follow-ups; this slice is the hex static factory.
  if (
    noJsHost(ctx) &&
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Uint8Array" &&
    propAccess.name.text === "fromHex" &&
    expr.arguments.length === 1 &&
    !ts.isSpreadElement(expr.arguments[0]!)
  ) {
    // Route the "is the argument statically a String" question through the
    // oracle (#1930/#3273 ratchet) rather than the raw TS checker. Per spec
    // `fromHex` accepts a String only (TypeError, no ToString, otherwise), so a
    // non-string arg falls through to the existing refusal.
    if (ctx.oracle.staticJsTypeOf(expr.arguments[0]!) === "string") {
      const strVt = nativeStringType(ctx);
      const at = compileExpression(ctx, fctx, expr.arguments[0]!, strVt);
      if (at) {
        if (!valTypesMatch(at, strVt)) coerceType(ctx, fctx, at, strVt);
        const fromHexIdx = ensureUint8FromHex(ctx);
        if (fromHexIdx >= 0) {
          fctx.body.push({ op: "call", funcIdx: fromHexIdx });
          const vecTypeIdx = getOrRegisterVecType(ctx, "i8_byte", { kind: "i8" });
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }
      }
    }
  }

  // (#3150) Standalone-native `Uint8Array.fromBase64(string)` — decode a
  // standard-alphabet base64 string (default options: `alphabet: "base64"`,
  // `lastChunkHandling: "loose"`) to a fresh packed-`i8` Uint8Array vec, the same
  // backing `new Uint8Array` / `Uint8Array.of` / `fromHex` produce. Only a bare
  // STRING-typed argument routes here — a call carrying the options object (the
  // `alphabet` / `lastChunkHandling` variants) has arguments.length > 1 and falls
  // through to the existing dynamic-shape refusal, so no wrong default is silently
  // applied. Whitespace is skipped, `=` padding is validated, and malformed input
  // throws the spec's SyntaxError.
  if (
    noJsHost(ctx) &&
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Uint8Array" &&
    propAccess.name.text === "fromBase64" &&
    expr.arguments.length === 1 &&
    !ts.isSpreadElement(expr.arguments[0]!)
  ) {
    if (ctx.oracle.staticJsTypeOf(expr.arguments[0]!) === "string") {
      const strVt = nativeStringType(ctx);
      const at = compileExpression(ctx, fctx, expr.arguments[0]!, strVt);
      if (at) {
        if (!valTypesMatch(at, strVt)) coerceType(ctx, fctx, at, strVt);
        const fromB64Idx = ensureUint8FromBase64(ctx);
        if (fromB64Idx >= 0) {
          fctx.body.push({ op: "call", funcIdx: fromB64Idx });
          const vecTypeIdx = getOrRegisterVecType(ctx, "i8_byte", { kind: "i8" });
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }
      }
    }
  }

  // (#2592) Standalone-native TypedArray static factories — `TA.of(...)` and
  // `TA.from(src)`. The receiver identifier is `Int32Array` / `Uint8Array` /
  // … ∈ TYPED_ARRAY_NAMES, so it never reaches the `Array.of` / `Array.from`
  // arms below (keyed on `"Array"`) and otherwise falls through to the
  // dynamic-shape `__get_builtin` path — rejected standalone (#1472 Phase B).
  // The element vec representation is fixed by the constructor NAME via
  // `typedArrayVecStorage` (i8_byte for standalone Uint8Array, f64 otherwise),
  // matching today's `new TA([...])` so the result is assignment-compatible.
  // Integer element-width wrapping (Uint8Array.of(300) → 44) is deferred to
  // #2593 — this slice matches `new TA([...])` element fidelity (length/order).
  if (
    ts.isIdentifier(propAccess.expression) &&
    TYPED_ARRAY_NAMES.has(propAccess.expression.text) &&
    (propAccess.name.text === "of" || (noJsHost(ctx) && propAccess.name.text === "from"))
  ) {
    const taName = propAccess.expression.text;
    const factory = propAccess.name.text;
    const storage = typedArrayVecStorage(ctx, taName);
    const elemWasm = storage.type; // {kind:"f64"} or {kind:"i8"}
    const taVecTypeIdx = getOrRegisterVecType(ctx, storage.key, elemWasm);
    const taArrTypeIdx = getArrTypeIdxFromVec(ctx, taVecTypeIdx);
    // The store ValType for an i8 packed array is i32 on the operand stack.
    const storeWasm: ValType = elemWasm.kind === "i8" ? { kind: "i32" } : elemWasm;

    if (taArrTypeIdx >= 0) {
      // --- TA.of(a, b, c) — every arg is an element (§23.2.2.2). ---
      if (factory === "of") {
        const hasSpreadArg = expr.arguments.some((a) => ts.isSpreadElement(a));
        if (!hasSpreadArg) {
          if (expr.arguments.length === 0) {
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "array.new_default", typeIdx: taArrTypeIdx });
            fctx.body.push({ op: "struct.new", typeIdx: taVecTypeIdx });
            return { kind: "ref_null", typeIdx: taVecTypeIdx };
          }
          for (const arg of expr.arguments) {
            const at = compileExpression(ctx, fctx, arg, storeWasm);
            if (at && !valTypesMatch(at, storeWasm)) coerceType(ctx, fctx, at, storeWasm);
            // Host/gc keeps Uint8Array elements in an f64 vec, so the packed
            // array store cannot perform the view's ToUint8 conversion for us.
            // Apply it at the factory boundary just like an indexed
            // Uint8Array write: ToInt32, mask to the low byte, widen back to
            // the f64 carrier. This matters for signed shift results such as
            // SHA-1's `H[0] >> 24`, and is the ordinary Uint8Array.of contract
            // for every caller rather than a UUID-specific rewrite.
            if (taName === "Uint8Array" && elemWasm.kind === "f64") {
              emitToInt32(fctx);
              fctx.body.push({ op: "i32.const", value: 0xff });
              fctx.body.push({ op: "i32.and" });
              fctx.body.push({ op: "f64.convert_i32_u" });
            }
          }
          fctx.body.push({ op: "array.new_fixed", typeIdx: taArrTypeIdx, length: expr.arguments.length });
          const ofData = allocLocal(fctx, `__taof_data_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: taArrTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: ofData });
          fctx.body.push({ op: "i32.const", value: expr.arguments.length });
          fctx.body.push({ op: "local.get", index: ofData });
          fctx.body.push({ op: "struct.new", typeIdx: taVecTypeIdx });
          return { kind: "ref_null", typeIdx: taVecTypeIdx };
        }
        // A spread-bearing `TA.of(a, ...xs)` has the same dense element list as
        // the synthetic array literal `[a, ...xs]`. Reuse the array literal's
        // runtime spread loop while forcing the typed-array storage type, so a
        // vec spread contributes each element instead of being passed as one
        // opaque argument (uuid builds its 16-byte v1 fixture this way).
        const synthetic = ts.factory.createArrayLiteralExpression(expr.arguments);
        (synthetic as unknown as { parent: ts.Node }).parent = expr.parent;
        const spreadResult = compileArrayLiteral(ctx, fctx, synthetic, storeWasm);
        if (spreadResult !== null) return spreadResult;
      }

      // --- TA.from(src [, mapFn]) — array-like / vec source (§23.2.2.1). ---
      // Phase 1: array-like sources (array literal / typed/number[] vec) with
      // NO mapFn. The source vec's element type may differ from the dest
      // (e.g. number[] f64 → Int32Array f64, or → Uint8Array i8), so copy
      // element-by-element with re-coercion rather than a raw array.copy.
      // mapFn and non-array iterables fall through to the existing path.
      if (factory === "from" && expr.arguments.length === 1) {
        const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
        const argWasm = resolveWasmType(ctx, argTsType);
        if (argWasm.kind === "ref" || argWasm.kind === "ref_null") {
          const srcInfo = resolveArrayInfo(ctx, argTsType);
          if (srcInfo) {
            // #1919 — transactional try-lower; roll back if the source doesn't
            // genuinely lower to its vec (keeps the fall-through paths clean).
            const snap = snapshotSpeculative(ctx, fctx);
            const { vecTypeIdx: srcVecIdx, arrTypeIdx: srcArrIdx, elemType: srcElem } = srcInfo;
            const srcT = compileExpression(ctx, fctx, expr.arguments[0]!);
            if (srcT && (srcT.kind === "ref" || srcT.kind === "ref_null")) {
              const srcVec = allocLocal(fctx, `__tafrom_src_${fctx.locals.length}`, {
                kind: "ref_null",
                typeIdx: srcVecIdx,
              });
              const srcData = allocLocal(fctx, `__tafrom_sdata_${fctx.locals.length}`, {
                kind: "ref_null",
                typeIdx: srcArrIdx,
              });
              const lenTmp = allocLocal(fctx, `__tafrom_len_${fctx.locals.length}`, { kind: "i32" });
              const dstData = allocLocal(fctx, `__tafrom_ddata_${fctx.locals.length}`, {
                kind: "ref",
                typeIdx: taArrTypeIdx,
              });
              const iTmp = allocLocal(fctx, `__tafrom_i_${fctx.locals.length}`, { kind: "i32" });

              // src vec ref → field0 (len), field1 (data)
              if (srcT.kind === "ref_null") fctx.body.push({ op: "ref.cast", typeIdx: srcVecIdx });
              fctx.body.push({ op: "local.set", index: srcVec });
              fctx.body.push({ op: "local.get", index: srcVec });
              fctx.body.push({ op: "struct.get", typeIdx: srcVecIdx, fieldIdx: 0 });
              fctx.body.push({ op: "local.set", index: lenTmp });
              fctx.body.push({ op: "local.get", index: srcVec });
              fctx.body.push({ op: "struct.get", typeIdx: srcVecIdx, fieldIdx: 1 });
              fctx.body.push({ op: "local.set", index: srcData });
              // dst data array of len (default-filled)
              for (const ins of defaultValueInstrs(elemWasm)) fctx.body.push(ins);
              fctx.body.push({ op: "local.get", index: lenTmp });
              fctx.body.push({ op: "array.new", typeIdx: taArrTypeIdx });
              fctx.body.push({ op: "local.set", index: dstData });
              // for (i=0; i<len; i++) dst[i] = coerce(src[i]) — canonical
              // block{loop{ if i>=len br 1; body; i++; br 0 }} form. Build the
              // loop body via pushBody/popBody so the `coerceType` element
              // conversion (which emits into `fctx.body`) lands INSIDE the loop
              // rather than leaking before the block.
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.set", index: iTmp });
              const srcElemIsSigned = srcElem.kind === "i8" || srcElem.kind === "i16";
              const srcElemIsPacked = srcElem.kind === "i8" || srcElem.kind === "i16";
              const srcStore: ValType = srcElemIsPacked ? { kind: "i32" } : srcElem;
              const savedLoopBody = pushBody(fctx);
              // if (i >= len) break
              fctx.body.push({ op: "local.get", index: iTmp });
              fctx.body.push({ op: "local.get", index: lenTmp });
              fctx.body.push({ op: "i32.ge_s" });
              fctx.body.push({ op: "br_if", depth: 1 });
              // dst[i] = coerce(src[i])
              fctx.body.push({ op: "local.get", index: dstData });
              fctx.body.push({ op: "local.get", index: iTmp });
              fctx.body.push({ op: "local.get", index: srcData });
              fctx.body.push({ op: "local.get", index: iTmp });
              if (srcElemIsPacked) {
                fctx.body.push({
                  op: srcElemIsSigned ? "array.get_s" : "array.get_u",
                  typeIdx: srcArrIdx,
                });
              } else {
                fctx.body.push({ op: "array.get", typeIdx: srcArrIdx });
              }
              if (!valTypesMatch(srcStore, storeWasm)) coerceType(ctx, fctx, srcStore, storeWasm);
              fctx.body.push({ op: "array.set", typeIdx: taArrTypeIdx });
              // i++
              fctx.body.push({ op: "local.get", index: iTmp });
              fctx.body.push({ op: "i32.const", value: 1 });
              fctx.body.push({ op: "i32.add" });
              fctx.body.push({ op: "local.set", index: iTmp });
              // continue
              fctx.body.push({ op: "br", depth: 0 });
              const loopInner = fctx.body;
              popBody(fctx, savedLoopBody);
              fctx.body.push({
                op: "block",
                blockType: { kind: "empty" },
                body: [{ op: "loop", blockType: { kind: "empty" }, body: loopInner }],
              });
              // struct.new (len, dstData)
              fctx.body.push({ op: "local.get", index: lenTmp });
              fctx.body.push({ op: "local.get", index: dstData });
              fctx.body.push({ op: "struct.new", typeIdx: taVecTypeIdx });
              return { kind: "ref", typeIdx: taVecTypeIdx };
            }
            rollbackSpeculative(ctx, fctx, snap);
          }
        }
        // Non-array-like / mapFn / iterable source → fall through.
      }
    }
    // taArrTypeIdx unavailable or unhandled shape → fall through to the
    // existing generic path (host mode handles via host import).
  }

  // Handle Array.from(arr) — array copy
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Array" &&
    propAccess.name.text === "from" &&
    expr.arguments.length >= 1
  ) {
    const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
    const argWasmType = resolveWasmType(ctx, argTsType);
    // (#1382 Phase 2) The native fast-path applies only when there's
    // NO mapFn. With a mapFn, route to the host fallback below — the
    // runtime's `__array_from` materializes the wasm vec via
    // `__vec_len`/`__vec_get` and wraps the mapFn closure via
    // `_wrapWasmClosure`. The fast path's `array.copy` would silently
    // drop the mapFn.
    const hasMapFn = expr.arguments.length >= 2;
    // (#1470) Array.from(string) without a mapFn — the string iterable
    // yields code points (§23.1.2.1 via §22.1.5.1). In native-strings mode
    // materialize the char vec in pure Wasm. Without this the string fell
    // into the host `__array_from` fallback below, which both leaks a JS
    // host import and (post late-import shift) emitted an invalid module
    // under --target standalone. Tentatively compile and only commit when
    // the argument genuinely lowers to a native string ref (#1610 pattern).
    if (!hasMapFn && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && isStringType(argTsType)) {
      // #1919 — transactional try-lower: keep the compiled arg when it lowers
      // to a native string; otherwise roll back the body AND any locals / late
      // imports / errors so the fallback paths below start clean.
      const snap = snapshotSpeculative(ctx, fctx);
      const t = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (
        t &&
        (t.kind === "ref" || t.kind === "ref_null") &&
        (t.typeIdx === ctx.anyStrTypeIdx || t.typeIdx === ctx.nativeStrTypeIdx)
      ) {
        if (t.kind === "ref_null") {
          fctx.body.push({ op: "ref.as_non_null" });
        }
        const { funcIdx: toCharVecIdx, vecTypeIdx: nstrVecTypeIdx } = ensureStrToCharVecHelper(ctx);
        fctx.body.push({ op: "call", funcIdx: toCharVecIdx });
        return { kind: "ref", typeIdx: nstrVecTypeIdx };
      }
      // Didn't lower as a native string — roll back and use the paths below.
      rollbackSpeculative(ctx, fctx, snap);
    }
    // (#2169) Array.from(g()) over a Wasm-native generator without a mapFn.
    // The argument lowers to the generator state struct, NOT a __vec — the
    // host fallback below would convert it to externref and call __array_from
    // (an env import that doesn't exist standalone). Drain the generator into
    // an f64 vec via the native resume loop instead (shares the spread
    // helper). Tentatively compile + commit only when the arg genuinely
    // lowers to a native-generator subject (mirrors the #1470 native-string
    // probe above).
    if (!hasMapFn) {
      // #1919 — transactional try-lower: keep the compiled arg when it lowers
      // to a native-generator subject; otherwise roll back the body AND any
      // locals / late imports / errors so the fallback paths below start clean.
      const snap = snapshotSpeculative(ctx, fctx);
      const t = compileExpression(ctx, fctx, expr.arguments[0]!);
      const genInfo = t ? nativeGeneratorInfoForForOfSubject(ctx, t) : undefined;
      if (genInfo) {
        const genVecTypeIdx = getOrRegisterVecType(ctx, "f64");
        const genArrTypeIdx = getArrTypeIdxFromVec(ctx, genVecTypeIdx);
        emitNativeGeneratorToVec(ctx, fctx, genInfo, t!, genVecTypeIdx, genArrTypeIdx);
        return { kind: "ref", typeIdx: genVecTypeIdx };
      }
      // Not a native generator — roll back and use the paths below.
      rollbackSpeculative(ctx, fctx, snap);
    }
    // (#42 follow-up) Array.from(Set) — standalone native. A Set lowers to a
    // `ref $Map` whose field layout is NOT a `__vec` (field 0 is not a length,
    // field 1 is the entries bucket array), yet the purely-STRUCTURAL
    // `resolveArrayInfo` matches any struct with a `ref array` field[1] — so
    // the array-copy fast path below FALSELY treats the Set struct as a `__vec`,
    // does `struct.get 0/1` on it, then `struct.new <vecTypeIdx>` with a
    // mismatched field arity → "not enough arguments on the stack for
    // struct.new" (invalid Wasm). And the generic `__iterator` native drain
    // (#2169c) hard-casts the subject to a `__vec` → `illegal cast` trap at
    // runtime for a non-vec Set.
    //
    // Route through the SAME `emitCollectionIteratorVec` driver the `[...set]`
    // spread (#42) and `.values()` paths use: a Set yields its values
    // (§23.1.4.1 / §24.2.3). It produces a canonical externref `$Vec` — exactly
    // Array.from's result. (Array.from(Map) → `[k, v]` entry pairs needs the
    // `$ObjVec` pair-indexing path, which is not yet sound here, so Map keeps
    // the existing routing — see the WeakSet/WeakMap/Map reject below.)
    const argSymName = (argTsType.symbol ?? argTsType.aliasSymbol)?.name;
    if (!hasMapFn && ctx.nativeStrings && argSymName === "Set") {
      const matType = emitCollectionIteratorVec(ctx, fctx, expr.arguments[0]!, "values", /* isSet */ true);
      if (matType != null && matType !== VOID_RESULT && (matType.kind === "ref" || matType.kind === "ref_null")) {
        return matType;
      }
      // Driver declined (e.g. a real JS Set arriving as externref) — fall
      // through to the paths below.
    }
    // (#2586) Array.from(Map) — host-free native. A Map's default iterator
    // is its `entries()` (§24.1.3.12 → §24.1.5.3), so `Array.from(map)`
    // yields one `[key, value]` pair per live entry. The generic native
    // `__iterator` drain below is built VEC-ONLY under noJsHost and hard-casts
    // its subject to a `$Vec` (iterator-native.ts:293) → `illegal cast` on the
    // `ref $Map` struct. Route through the SAME `emitCollectionIteratorVec`
    // driver as Set above, in `"entries"` mode: it materializes a canonical
    // externref `$Vec` whose slots are 2-element `$ObjVec` `[key, value]`
    // pairs, so the consumer's `a[i][0]`/`a[i][1]` read back through the
    // native `__extern_get_idx`/`__extern_length` arm — exactly Array.from's
    // result. (WeakMap is not iterable; WeakSet/Map-with-mapFn keep the
    // existing routing.)
    //
    // Gated to `ctx.standalone` (the `--target standalone` pure-Wasm target),
    // NOT plain `nativeStrings` nor WASI. The entries-mode `$ObjVec` pair
    // materialization tickles a PRE-EXISTING substrate limitation that the
    // stricter targets surface but this slice does not own:
    //   - nativeStrings-WITH-JS-host → a late-registered object-runtime funcidx
    //     (`__defineProperty_value`) desyncs (also breaks `[...m.entries()]`
    //     there);
    //   - `--target wasi` (strict-no-host) → the same desync PLUS a
    //     `global_Array` declared-global request that the allowlist rejects.
    // Both reproduce on `main` for `[...m.entries()]` independently of this
    // change, so they are escalated as the entries-mode substrate follow-up
    // rather than half-fixed here. Under `--target standalone` the path lowers
    // to a zero-import, fully-native module (verified), so ship that.
    if (!hasMapFn && ctx.standalone && ctx.nativeStrings && argSymName === "Map") {
      const matType = emitCollectionIteratorVec(ctx, fctx, expr.arguments[0]!, "entries", /* isSet */ false);
      if (matType != null && matType !== VOID_RESULT && (matType.kind === "ref" || matType.kind === "ref_null")) {
        // The materialized vec carries 2-element `$ObjVec` `[key, value]` pairs
        // as its slots, NOT type-resolved tuple structs. Hand it back as a
        // plain externref so the consumer reads it through the dynamic
        // `__extern_get_idx`/`__extern_length` arm (`a[i][0]`/`[k, v]`
        // destructuring) — exactly the host `__array_from` contract. Returning
        // the raw `ref $Vec` instead would make a `const a: [K,V][]` binding
        // run the typed tuple-vec materialization, which can't bridge an
        // `$ObjVec` pair into a tuple struct (→ invalid `struct.new`).
        coerceType(ctx, fctx, matType, { kind: "externref" });
        return { kind: "externref" };
      }
      // Driver declined (e.g. a real JS Map arriving as externref) — fall
      // through to the paths below.
    }
    // Reject the known non-array builtin collections from the structural
    // array-copy fast path so a Set the driver above declined, or a
    // Map/WeakSet/WeakMap, cannot be mis-read as a `__vec` (the struct.new
    // arity crash above). They fall through to the native iterator drain
    // (#2169c) / host fallback instead.
    const isNonArrayBuiltinCollection =
      argSymName === "Set" || argSymName === "Map" || argSymName === "WeakSet" || argSymName === "WeakMap";
    if (!hasMapFn && !isNonArrayBuiltinCollection && (argWasmType.kind === "ref" || argWasmType.kind === "ref_null")) {
      const arrInfo = resolveArrayInfo(ctx, argTsType);
      if (arrInfo) {
        const { vecTypeIdx, arrTypeIdx, elemType } = arrInfo;
        // Compile the source array
        compileExpression(ctx, fctx, expr.arguments[0]!);
        const srcVec = allocLocal(fctx, `__arrfrom_src_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: vecTypeIdx,
        });
        const srcData = allocLocal(fctx, `__arrfrom_sdata_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: arrTypeIdx,
        });
        const lenTmp = allocLocal(fctx, `__arrfrom_len_${fctx.locals.length}`, { kind: "i32" });
        const dstData = allocLocal(fctx, `__arrfrom_ddata_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: arrTypeIdx,
        });

        fctx.body.push({ op: "local.set", index: srcVec });
        // Get length
        fctx.body.push({ op: "local.get", index: srcVec });
        fctx.body.push({
          op: "struct.get",
          typeIdx: vecTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({ op: "local.set", index: lenTmp });
        // Get source data
        fctx.body.push({ op: "local.get", index: srcVec });
        fctx.body.push({
          op: "struct.get",
          typeIdx: vecTypeIdx,
          fieldIdx: 1,
        });
        fctx.body.push({ op: "local.set", index: srcData });
        // Create new data array with default value — defaultValueInstrs
        // handles externref/ref/ref_null/i32/f64/i64 uniformly. Hand-rolling
        // `ref.null typeIdx: -1` for the externref element case produced
        // "Unknown heap type -1" wasm_compile errors (#1338).
        for (const ins of defaultValueInstrs(elemType)) fctx.body.push(ins);
        fctx.body.push({ op: "local.get", index: lenTmp });
        fctx.body.push({ op: "array.new", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "local.set", index: dstData });
        // Copy elements: array.copy dst dstOff src srcOff len
        fctx.body.push({ op: "local.get", index: dstData });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.get", index: srcData });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.get", index: lenTmp });
        fctx.body.push({
          op: "array.copy",
          dstTypeIdx: arrTypeIdx,
          srcTypeIdx: arrTypeIdx,
        });
        // Create new vec struct with copied data
        fctx.body.push({ op: "local.get", index: lenTmp });
        fctx.body.push({ op: "local.get", index: dstData });
        fctx.body.push({ op: "ref.as_non_null" });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        return { kind: "ref", typeIdx: vecTypeIdx };
      }
    }
    // (#2169c) Native standalone drain: `Array.from(iterable)` with no mapFn,
    // host-free. The native `__iterator` runtime (registered here) wraps the
    // arg into an `$IterRec`; `__iterator_rest` drains it into a canonical
    // externref `$Vec` — exactly the value the host `__array_from` returns, but
    // with zero host imports. mapFn is NOT handled natively yet (it needs
    // closure dispatch) — those fall through to the host path below.
    if (noJsHost(ctx) && expr.arguments.length < 2) {
      ensureNativeIteratorRuntime(ctx);
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
      flushLateImportShifts(ctx, fctx);
      const iterIdx = ctx.funcMap.get("__iterator");
      const restIdx = ctx.funcMap.get("__iterator_rest");
      if (iterIdx !== undefined && restIdx !== undefined) {
        // rec = __iterator(arg) ; return __iterator_rest(rec)
        fctx.body.push({ op: "call", funcIdx: iterIdx });
        fctx.body.push({ op: "call", funcIdx: restIdx });
        return { kind: "externref" };
      }
      // Native runtime unavailable — fall through to the host path with the
      // arg already on the stack (push the null mapFn it expects).
      fctx.body.push({ op: "ref.null.extern" });
      const fromNativeFallbackIdx = ensureLateImport(
        ctx,
        "__array_from",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (fromNativeFallbackIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromNativeFallbackIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // (#3206) Native standalone `Array.from(source, mapFn[, thisArg])` —
    // host-free. The 2-arg (mapper) arm otherwise fell to the host fallback
    // below, which compiles the mapFn to externref via the `__make_callback`
    // host bridge AND calls the host `__array_from` import — both
    // unsatisfiable standalone, so the module failed to instantiate. Compose
    // the native drain + native map HOF: `__array_from_mapped(source, mapFn,
    // thisArg)` = `__hof_map(__array_from_iter_n(source, -1), mapFn,
    // thisArg)`. The mapFn crosses as a raw GC CLOSURE (compileArrowAsClosure
    // for an inline arrow/function; an identifier-held closure already crosses
    // as a plain closure externref) invoked via `__apply_closure` — the exact
    // #3098 native-HOF gate rep, NOT the host callback bridge. Standalone-only
    // (the deps are standalone-gated); gc/wasi keep the host routing.
    //
    // Excludes Set/Map/WeakSet/WeakMap sources (`isNonArrayBuiltinCollection`,
    // computed above): those are native collection structs, NOT `$Vec` /
    // `$ObjVec` / `$Object {length}` / user-iterable closed structs, so
    // `__array_from_iter_n` passes them through unchanged and `__hof_map`
    // would read a wrong `__extern_length` → silent-wrong. On main they hit
    // the host fallback (leak → INST-FAIL under standalone), so keeping them
    // there is no regression; the 1-arg Set/Map arms above are their native
    // path and the mapFn variant is a follow-up.
    if (
      ctx.standalone &&
      expr.arguments.length >= 2 &&
      !isNonArrayBuiltinCollection &&
      ensureNativeArrayFromMapped(ctx) !== undefined
    ) {
      // source → externref
      const srcType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (srcType && srcType.kind !== "externref") coerceType(ctx, fctx, srcType, { kind: "externref" });
      else if (srcType === null) fctx.body.push({ op: "ref.null.extern" });
      // mapFn → raw GC closure externref (mirrors calls.ts:~13699, #3098)
      const mapArg = expr.arguments[1]!;
      if (ts.isArrowFunction(mapArg) || ts.isFunctionExpression(mapArg)) {
        const mt = compileArrowAsClosure(ctx, fctx, mapArg);
        if (mt && mt.kind !== "externref") coerceType(ctx, fctx, mt, { kind: "externref" });
        else if (mt === null) fctx.body.push({ op: "ref.null.extern" });
      } else {
        const mt = compileExpression(ctx, fctx, mapArg, { kind: "externref" });
        if (mt && mt.kind !== "externref") coerceType(ctx, fctx, mt, { kind: "externref" });
        else if (mt === null) fctx.body.push({ op: "ref.null.extern" });
      }
      // thisArg → externref | null (§23.1.2.1: optional 3rd arg is mapFn's this)
      if (expr.arguments.length >= 3) {
        const tt = compileExpression(ctx, fctx, expr.arguments[2]!, { kind: "externref" });
        if (tt && tt.kind !== "externref") coerceType(ctx, fctx, tt, { kind: "externref" });
        else if (tt === null) fctx.body.push({ op: "ref.null.extern" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      flushLateImportShifts(ctx, fctx);
      const mappedIdx = ctx.funcMap.get("__array_from_mapped");
      if (mappedIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: mappedIdx });
        return { kind: "externref" };
      }
      // Helper vanished (should not happen) — the source + mapFn + thisArg are
      // already on the stack; drop them and hand back an empty result so the
      // module stays valid rather than falling through with a corrupt stack.
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Fallback: Array.from(externref/iterable) — delegate to host (#965)
    {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
      // Optional mapFn argument
      if (expr.arguments.length >= 2) {
        const mapType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
        if (mapType && mapType.kind !== "externref") coerceType(ctx, fctx, mapType, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      const fromIdx = ensureLateImport(
        ctx,
        "__array_from",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (fromIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // Handle Array.of(...items) — creates array from arguments (#965)
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Array" &&
    propAccess.name.text === "of"
  ) {
    // (#1633 standalone slice) `Array.of(a, b, c)` ≡ `[a, b, c]` (§23.1.2.3:
    // every arg is an element; unlike `Array(n)` a single numeric arg is NOT a
    // length). In no-JS-host mode the host `__array_of` (+ `__js_array_new`/
    // `__js_array_push`) imports don't exist — the old path leaked them and
    // returned a wrong/empty array standalone. Build a native vec directly,
    // mirroring the multi-arg `Array(a,b,c)` branch of
    // `compileArrayConstructorCall` (no spread → fixed arity). Spread args keep
    // the host path (handled by the generic spread-call lowering in host mode);
    // a standalone spread of Array.of falls through to the existing path.
    const hasSpreadArg = expr.arguments.some((a) => ts.isSpreadElement(a));
    if (noJsHost(ctx) && !hasSpreadArg) {
      // Element type: contextual `Array<T>` type arg, else f64 for a numeric
      // arg set, else externref (mixed / non-numeric). Mirrors the untyped
      // dense-array default in compileArrayConstructorCall.
      const ctxType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
      const elemTsType = ctx.checker.getTypeArguments(ctxType as ts.TypeReference)?.[0];
      let elemWasm: ValType;
      if (elemTsType && (elemTsType.flags & ts.TypeFlags.Any) === 0) {
        elemWasm = resolveWasmType(ctx, elemTsType);
      } else {
        // No resolvable element type: pick f64 only when every arg is a static
        // number; otherwise box to externref so mixed/object elements survive.
        const allNumeric = expr.arguments.every((a) => {
          const t = ctx.checker.getTypeAtLocation(a);
          return (t.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !== 0;
        });
        elemWasm = expr.arguments.length > 0 && allNumeric ? { kind: "f64" } : { kind: "externref" };
      }
      const elemKey =
        elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
          ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
          : elemWasm.kind;
      const ofVecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
      const ofArrTypeIdx = getArrTypeIdxFromVec(ctx, ofVecTypeIdx);
      if (ofArrTypeIdx >= 0) {
        if (expr.arguments.length === 0) {
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "array.new_default", typeIdx: ofArrTypeIdx });
          fctx.body.push({ op: "struct.new", typeIdx: ofVecTypeIdx });
          return { kind: "ref_null", typeIdx: ofVecTypeIdx };
        }
        for (const arg of expr.arguments) {
          const at = compileExpression(ctx, fctx, arg, elemWasm);
          if (at && !valTypesMatch(at, elemWasm)) coerceType(ctx, fctx, at, elemWasm);
          else if (
            at === null &&
            (elemWasm.kind === "ref" || elemWasm.kind === "ref_null" || elemWasm.kind === "externref")
          )
            fctx.body.push({ op: "ref.null.extern" });
        }
        fctx.body.push({ op: "array.new_fixed", typeIdx: ofArrTypeIdx, length: expr.arguments.length });
        const ofDataLocal = allocLocal(fctx, `__arrof_data_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: ofArrTypeIdx,
        });
        fctx.body.push({ op: "local.set", index: ofDataLocal });
        fctx.body.push({ op: "i32.const", value: expr.arguments.length });
        fctx.body.push({ op: "local.get", index: ofDataLocal });
        fctx.body.push({ op: "struct.new", typeIdx: ofVecTypeIdx });
        return { kind: "ref_null", typeIdx: ofVecTypeIdx };
      }
      // vec type unavailable — fall through to the host path below.
    }
    // Build a JS array of the arguments and delegate to host
    const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
    const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
    const ofIdx = ensureLateImport(ctx, "__array_of", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (ofIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      const itemsLocal = allocLocal(fctx, `__arrof_items_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: itemsLocal });
      for (const arg of expr.arguments) {
        fctx.body.push({ op: "local.get", index: itemsLocal });
        const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
        fctx.body.push({ op: "call", funcIdx: arrPushIdx });
      }
      fctx.body.push({ op: "local.get", index: itemsLocal });
      fctx.body.push({ op: "call", funcIdx: ofIdx });
      return { kind: "externref" };
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle Object.keys(obj), Object.values(obj), and Object.entries(obj)
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    (propAccess.name.text === "keys" || propAccess.name.text === "values" || propAccess.name.text === "entries") &&
    expr.arguments.length === 1
  ) {
    return compileObjectKeysOrValues(ctx, fctx, propAccess.name.text, expr);
  }

  // (#2744) An object operand for the integrity methods can compile to any
  // reference kind — `externref` ($Object/any), a `ref`/`ref_null` to a typed
  // object struct or a vec (array / typed Date), `anyref`, or `eqref`. All of
  // these are OBJECTS; only the scalar kinds (f64/i32/i64/f32/v128/i8/i16/
  // funcref) are genuine primitives. The integrity SET + query codegen routes
  // every object ref through the runtime helpers (coercing to externref via
  // `extern.convert_any` first), and folds to the primitive answer ONLY for
  // true primitives. Previously any non-`externref` argType was treated as a
  // primitive, so arrays (vec ref) and typed object structs (ref) mis-folded
  // `isExtensible`→0 / `isFrozen`,`isSealed`→1 and never reached the runtime.
  const isObjectRef = (t: ValType): boolean =>
    t.kind === "ref" || t.kind === "ref_null" || t.kind === "anyref" || t.kind === "eqref" || t.kind === "externref";
  const boundaryObjectInterop =
    ctx.targetProfile.semanticProviders === "native-first" &&
    ctx.targetProfile.environment === "javascript" &&
    ctx.targetProfile.hostValueInterop !== "off" &&
    !ctx.strictNoHostImports;
  const emitIntegrityPredicateCall = (
    arg0: ts.Expression,
    argType: ValType,
    method: "isFrozen" | "isSealed" | "isExtensible",
  ): InnerResult => {
    if (argType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
    const objLocal = allocTempLocal(fctx, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: objLocal });
    if (boundaryObjectInterop) ensureObjectRuntime(ctx);
    const nativeIdx = ensureIntegrityPredicate(ctx, arg0, method);
    flushLateImportShifts(ctx, fctx);
    const boundaryIdx = boundaryObjectInterop
      ? ctx.funcMap.get(
          method === "isFrozen"
            ? "__boundary_object_is_frozen"
            : method === "isSealed"
              ? "__boundary_object_is_sealed"
              : "__boundary_object_is_extensible",
        )
      : undefined;
    if (nativeIdx !== undefined && boundaryIdx !== undefined) {
      const boundaryResultLocal = allocTempLocal(fctx, { kind: "i32" });
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "call", funcIdx: boundaryIdx });
      fctx.body.push({ op: "local.tee", index: boundaryResultLocal });
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: objLocal },
          { op: "call", funcIdx: nativeIdx },
        ],
        else: [{ op: "local.get", index: boundaryResultLocal }, { op: "i32.const", value: 1 }, { op: "i32.sub" }],
      });
      releaseTempLocal(fctx, boundaryResultLocal);
      releaseTempLocal(fctx, objLocal);
      return { kind: "i32" };
    }
    fctx.body.push({ op: "local.get", index: objLocal });
    if (nativeIdx !== undefined) fctx.body.push({ op: "call", funcIdx: nativeIdx });
    else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: method === "isExtensible" ? 1 : 0 });
    }
    releaseTempLocal(fctx, objLocal);
    return { kind: "i32" };
  };

  // Handle Object.freeze/seal/preventExtensions — compile-away strategy
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    (propAccess.name.text === "freeze" ||
      propAccess.name.text === "seal" ||
      propAccess.name.text === "preventExtensions") &&
    expr.arguments.length >= 1
  ) {
    const method = propAccess.name.text;
    const arg0 = expr.arguments[0]!;

    // Compile-time tracking: mark variable by freeze/seal/preventExtensions state.
    // Two binding shapes carry the integrity to a variable the write-path /
    // isFrozen consult (both keyed on the identifier name in ctx.frozenVars):
    //   (a) `Object.freeze(o)` — the ARGUMENT is the identifier.
    //   (b) `const o = Object.freeze({...})` (#2012) — the inline-literal arg
    //       is not an identifier, but the CALL is the initializer of a
    //       variable declaration, so mark the DECLARED variable instead.
    //       Without this, an inline-literal freeze was a complete no-op for
    //       struct receivers (no frozenVars entry → write never throws,
    //       isFrozen → false).
    const markIntegrity = (name: string): void => {
      ctx.nonExtensibleVars.add(name);
      if (method === "freeze") {
        ctx.frozenVars.add(name);
        ctx.sealedVars.add(name); // frozen implies sealed
      } else if (method === "seal") {
        ctx.sealedVars.add(name);
      }
    };
    if (ts.isIdentifier(arg0)) {
      // (#3403) per-declaration key (USE-site) so `Object.freeze(o)` in one
      // function does not mark every other function's `o` frozen.
      markIntegrity(integrityVarKey(ctx, arg0));
    } else if (
      // (#2012) `const/let o = Object.<freeze|seal|preventExtensions>(<expr>)`
      ts.isVariableDeclaration(expr.parent) &&
      ts.isIdentifier(expr.parent.name) &&
      expr.parent.initializer === expr
    ) {
      // (#3403) DECLARATION-site key (matches integrityVarKey at any later use).
      markIntegrity(widenedVarKeyFromDecl(expr.parent.name));
    }

    // Compile the argument — returns the object itself (freeze/seal return their arg)
    let argType = compileExpression(ctx, fctx, expr.arguments[0]!);
    if (!argType) return null;

    // #1472 Phase B Blocker A Half 2 — object-receiver normalization.
    // The open-object representation is a $Object wrapped to externref, but an
    // object receiver (`Object.freeze(o)` where `o: any`, a typed object
    // struct, or an array/vec) can compile to a ref/ref_null/anyref/eqref
    // rather than externref, which would fall through to the return-arg no-op
    // and never reach the native __object_freeze (the runtime WeakSet/
    // descriptor state would never be set, so a later isFrozen/isSealed/
    // isExtensible query returns the wrong answer). (#2744) Coerce ANY
    // non-externref object receiver to externref first (extern.convert_any) so
    // the runtime SET helper fires for arrays/structs/Date in ALL modes, not
    // just standalone. Use RAW `extern.convert_any` (NOT coerceType): for a vec
    // (array) receiver, coerceType appends `__make_iterable`, which materializes
    // a *fresh* JS array per call — so the runtime WeakSet/descriptor state keyed
    // on that throwaway wrapper would never match a later query's fresh wrapper
    // (`Object.freeze(arr); Object.isFrozen(arr)` → false). The bare
    // `extern.convert_any` passes the OPAQUE WasmGC ref, which is
    // identity-preserving across SET/query coercions of the same object AND is
    // recognized by `_isWasmStruct`, so arrays track integrity exactly like
    // plain structs. The compile-time `markIntegrity` var-marking remains as an
    // additional fast-path for the strict-mode write-throw decision.
    if (argType.kind !== "externref" && isObjectRef(argType)) {
      fctx.body.push({ op: "extern.convert_any" });
      argType = { kind: "externref" };
    }

    // For externref objects, delegate to host import for runtime enforcement
    if (argType.kind === "externref") {
      const objLocal = allocLocal(fctx, `__freeze_obj_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: objLocal });

      // Use the actual JS Object.freeze/seal/preventExtensions via host import
      const importName =
        method === "freeze" ? "__object_freeze" : method === "seal" ? "__object_seal" : "__object_preventExtensions";
      if (boundaryObjectInterop) ensureObjectRuntime(ctx);
      const hostIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      const boundaryIdx = boundaryObjectInterop
        ? ctx.funcMap.get(
            method === "freeze"
              ? "__boundary_object_freeze"
              : method === "seal"
                ? "__boundary_object_seal"
                : "__boundary_object_prevent_extensions",
          )
        : undefined;

      if (hostIdx !== undefined && boundaryIdx !== undefined) {
        const boundaryResultLocal = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "call", funcIdx: boundaryIdx });
        fctx.body.push({ op: "local.tee", index: boundaryResultLocal });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [
            { op: "local.get", index: objLocal },
            { op: "call", funcIdx: hostIdx },
          ],
          else: [{ op: "local.get", index: boundaryResultLocal }],
        });
        releaseTempLocal(fctx, boundaryResultLocal);
        return { kind: "externref" };
      }
      if (hostIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "call", funcIdx: hostIdx });
        return { kind: "externref" };
      }

      // Fallback: just return the object as-is
      fctx.body.push({ op: "local.get", index: objLocal });
      return { kind: "externref" };
    }

    // For struct/ref types, compile-time tracking is sufficient — return as-is
    return argType;
  }

  // Handle Object.isFrozen/isSealed — compile-time fast path + runtime delegation
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    (propAccess.name.text === "isFrozen" || propAccess.name.text === "isSealed") &&
    expr.arguments.length >= 1
  ) {
    const method = propAccess.name.text;
    const arg0 = expr.arguments[0]!;

    // Test262's original top-level harness is not yet IR-claimed. Keep this
    // compatibility adapter thin: the semantic classification remains owned
    // by ir/object-integrity and is shared with selector + AST→IR lowering.
    if (
      method === "isFrozen" &&
      isPristineEs5IntrinsicIsFrozenCall(expr, (node) => isGlobalBuiltinIdentifier(ctx, fctx, node))
    ) {
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }

    // (#2744) The host-mode static fold (`ctx.frozenVars`/`ctx.sealedVars`
    // keyed on the identifier) was execution-order-blind — `Object.freeze(o)`
    // populates those sets during codegen, so an *earlier* `Object.isFrozen(o)`
    // / `assert(Object.isExtensible(o))` pre-check wrongly folded to the sealed
    // answer. The runtime `__object_is*` helpers now answer authoritatively for
    // every object ref (the SET path records WeakSet/descriptor state for
    // arrays/structs/Date too), so the static fold is dropped here; the
    // compile-time tracking remains only for the strict-mode write-throw
    // decision.
    const argType = compileExpression(ctx, fctx, arg0);
    if (argType && isObjectRef(argType)) {
      // Object receiver ($Object/any externref, typed struct ref, array vec,
      // Date) → RAW extern.convert_any (identity-preserving, recognized by
      // _isWasmStruct; NOT coerceType, which would materialize a vec into a
      // fresh JS array and lose the WeakSet/descriptor identity) and delegate to
      // the runtime TestIntegrityLevel query.
      return emitIntegrityPredicateCall(arg0, argType, method);
    } else if (argType) {
      fctx.body.push({ op: "drop" });
      // (#1462) Primitive (f64/i32/i64) is not an Object per ES2015+ §19.1.2.13/14;
      // isFrozen/isSealed on a primitive returns TRUE.
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    }
    // Fallback (no argType): treat as not frozen/sealed
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Handle Object.isExtensible — compile-time fast path + runtime delegation
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "isExtensible" &&
    expr.arguments.length >= 1
  ) {
    const arg0 = expr.arguments[0]!;

    // (#2744) The host-mode static fold (`ctx.nonExtensibleVars`) was
    // execution-order-blind (same reason as isFrozen/isSealed above) — a
    // pre-check `Object.isExtensible(o)` before a later `Object.seal(o)` wrongly
    // folded to 0. The runtime `__object_isExtensible` now answers
    // authoritatively for every object ref (the SET path records the WeakSet
    // for arrays/structs/Date too), so the static fold is dropped here.
    const argType = compileExpression(ctx, fctx, arg0);
    if (argType && isObjectRef(argType)) {
      // Object receiver → RAW extern.convert_any (identity-preserving,
      // recognized by _isWasmStruct; NOT coerceType, which would materialize a
      // vec into a fresh JS array and lose identity) and delegate to the runtime
      // query.
      return emitIntegrityPredicateCall(arg0, argType, "isExtensible");
    } else if (argType) {
      fctx.body.push({ op: "drop" });
      // (#1462) Primitive (f64/i32/i64) is not an Object per ES2015+ §19.1.2.12;
      // isExtensible on a primitive returns FALSE.
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }
    // Fallback (no argType): extensible (conservative)
    fctx.body.push({ op: "i32.const", value: 1 });
    return { kind: "i32" };
  }

  // Handle Object.setPrototypeOf(obj, proto).
  //   - Standalone (#1888 Slice 7): route to the native __object_setPrototypeOf
  //     runtime helper, which writes $Object.$proto (field 0) after the
  //     §10.1.2.1 OrdinarySetPrototypeOf extensibility + cycle checks and
  //     returns obj. No host import leaks (the name is in
  //     OBJECT_RUNTIME_HELPER_NAMES, so ensureLateImport lands the native fn).
  //   - GC/host: keep the existing stub (compile both args, drop proto,
  //     return obj) — byte-for-byte unchanged, the host runtime owns proto.
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "setPrototypeOf" &&
    expr.arguments.length >= 2
  ) {
    if (ctx.targetProfile.semanticProviders === "native-first") {
      // obj (externref)
      const objType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (!objType) {
        // obj produced no value — nothing to set on; push null result.
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      if (objType.kind !== "externref") {
        coerceType(ctx, fctx, objType, { kind: "externref" });
      }
      // proto (externref)
      // #2580 M3 Stage A — build an INLINE-LITERAL proto as a native `$Object`
      // (compileProtoArg) so __object_setPrototypeOf's `ref.test $Object`
      // succeeds and writes $Object.$proto; a closed-shape literal struct fails
      // that test → null proto → inherited reads return 0. compileProtoArg keeps
      // the ordinary externref path for non-literal protos (incl. `null`).
      compileProtoArg(ctx, fctx, expr.arguments[1]!);
      const spoIdx = ensureLateImport(
        ctx,
        "__object_setPrototypeOf",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (spoIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: spoIdx });
      } else {
        // Helper unavailable (should not happen in standalone) — fall back to
        // the stub: drop proto, leave obj on the stack.
        fctx.body.push({ op: "drop" });
      }
      return { kind: "externref" };
    }
    // (#2739) GC/host: record the user [[Prototype]] via the host import so the
    // for-in walk + read path can follow it. An opaque WasmGC struct has no
    // host-observable [[Prototype]], so the previous stub (drop proto) lost the
    // link entirely and inherited keys never enumerated.
    const objType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
    if (!objType) {
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    if (objType.kind !== "externref") {
      coerceType(ctx, fctx, objType, { kind: "externref" });
    }
    const protoType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
    if (protoType) {
      if (protoType.kind !== "externref") {
        coerceType(ctx, fctx, protoType, { kind: "externref" });
      }
    } else {
      // proto produced no value — push null so the import receives two args.
      fctx.body.push({ op: "ref.null.extern" });
    }
    const sproIdx = ensureLateImport(
      ctx,
      "__host_set_struct_proto",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (sproIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: sproIdx });
    } else {
      // Import unavailable — fall back to the old stub (drop proto, keep obj).
      fctx.body.push({ op: "drop" });
    }
    return { kind: "externref" };
  }

  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    isGlobalBuiltinIdentifier(ctx, fctx, propAccess.expression) &&
    propAccess.name.text === "getPrototypeOf"
  ) {
    const es5Early = tryCompileEs5GetPrototypeOfEarly(ctx, fctx, expr);
    if (es5Early) return es5Early;
    const arg0 = expr.arguments[0]!;

    // (#2743 a) `Object.getPrototypeOf(arguments)` is %Object.prototype%
    // (§10.4.4), NOT the array prototype the vec representation would yield.
    // Emit the compiler's own `Object.prototype` value so ordinary objects and
    // arguments share one identity. Host-mode only; standalone keeps the vec.
    if (!noJsHost(ctx) && ts.isIdentifier(arg0) && arg0.text === "arguments" && fctx.localMap.has("arguments")) {
      const objProtoExpr = ts.factory.createPropertyAccessExpression(
        propAccess.expression,
        ts.factory.createIdentifier("prototype"),
      );
      (objProtoExpr as { parent?: ts.Node }).parent = propAccess.parent ?? propAccess;
      ts.setTextRange(objProtoExpr, propAccess.expression);
      const t = compileExpression(ctx, fctx, objProtoExpr, { kind: "externref" });
      return t ?? { kind: "externref" };
    }

    // For Object.getPrototypeOf(Child.prototype), return Parent's prototype singleton
    // Must check BEFORE the general class instance check, because TS types
    // Child.prototype as Child (the instance type).
    if (
      ts.isPropertyAccessExpression(arg0) &&
      ts.isIdentifier(arg0.expression) &&
      arg0.name.text === "prototype" &&
      ctx.classSet.has(arg0.expression.text)
    ) {
      const childClassName = arg0.expression.text;
      const parentClassName = ctx.classParentMap.get(childClassName);
      if (parentClassName && emitLazyProtoGet(ctx, fctx, parentClassName)) {
        return { kind: "externref" };
      }
      // Base class with no parent: return null (Object.prototype not modeled)
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // (#1516) `Object.getPrototypeOf(g)` where `g` is a generator function
    // declaration must return `%GeneratorFunction.prototype%` (= `%Generator%`)
    // — the object whose `.prototype` is `%GeneratorPrototype%`. The compiled
    // closure is opaque to the host, so we resolve the call statically here
    // by routing to a dedicated runtime import.
    //
    // Same shape for `async function*`. Tests rely on this:
    //   var GeneratorPrototype = Object.getPrototypeOf(g).prototype;
    //   GeneratorPrototype.next.call(non_gen);  // → TypeError
    if (ts.isIdentifier(arg0)) {
      const argName = arg0.text;
      const isGen = ctx.generatorFunctions.has(argName);
      // ctx.asyncFunctions excludes async generators by design — codegen
      // checks the original AST for the async keyword. Re-derive the flag
      // from the symbol declaration so we route async-generators correctly.
      let isAsyncGen = false;
      if (isGen) {
        const sym = ctx.checker.getSymbolAtLocation(arg0);
        const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
        if (decl && (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl))) {
          isAsyncGen = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
        }
      }
      if (isGen) {
        // (#3236 S1) Standalone sync generators route
        // `Object.getPrototypeOf(genFn)` to the native `%Generator%`
        // (= %GeneratorFunction.prototype%) singleton — host-free — instead of
        // leaking `__get_generator_function_prototype`. Async generators keep
        // the host import.
        if (!isAsyncGen && (ctx.standalone || ctx.wasi)) {
          const t = emitGeneratorFunctionPrototypeSingleton(ctx, fctx);
          if (t) return t;
        }
        const helperName = isAsyncGen
          ? "__get_async_generator_function_prototype"
          : "__get_generator_function_prototype";
        const helperIdx = ensureLateImport(ctx, helperName, [], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (helperIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: helperIdx });
          return { kind: "externref" };
        }
        // Standalone mode (no host): fall through to legacy null path.
      }
    }

    // (#2901) `Object.getPrototypeOf(<view ctor>)` → the standalone `%TypedArray%`
    // intrinsic constructor object (whose `.prototype` is `%TypedArray%.prototype`).
    // The test262 `testTypedArray.js` harness does
    // `var TypedArray = Object.getPrototypeOf(Int8Array); TypedArray.prototype`
    // to reach the §23.2.3 accessor descriptors (#2893). Keyed on the SYNTACTIC
    // constructor identifier — NOT identifier-as-value — so it can't collide with
    // the name-keyed `new Int8Array()` construction path, and is host-mode-neutral
    // (the JS host import already returns the correct intrinsic). A local binding
    // shadowing the name falls through unchanged.
    if (
      noJsHost(ctx) &&
      ts.isIdentifier(arg0) &&
      !fctx.localMap.has(arg0.text) &&
      isWiredTypedArrayViewName(arg0.text)
    ) {
      const ctorType = emitTypedArrayIntrinsicCtorObject(ctx, fctx);
      if (ctorType) return ctorType;
    }

    // (#3236 S1) `Object.getPrototypeOf(<ordinary function>)` → the native
    // `%Function.prototype%` `$Object` singleton (§20.2.3) in standalone. This
    // is the SAME singleton that `%Generator%`'s `[[Prototype]]` links to, so
    // `getPrototypeOf(getPrototypeOf(genFn)) === getPrototypeOf(ordinaryFn)`
    // (prototype-relation-to-function.js) holds by identity. Keyed on a
    // SYNTACTIC top-level function identifier (not a local binding, not a
    // generator — those are handled above), so it cannot mis-map a non-function
    // value. Without it the native `__getPrototypeOf` returns null for the
    // opaque function closure. Host/gc keeps the `__getPrototypeOf` import path.
    if (
      (ctx.standalone || ctx.wasi) &&
      ts.isIdentifier(arg0) &&
      !fctx.localMap.has(arg0.text) &&
      ctx.topLevelFunctionNames.has(arg0.text) &&
      !ctx.generatorFunctions.has(arg0.text)
    ) {
      const fpType = emitFunctionPrototypeObjectSingleton(ctx, fctx);
      if (fpType) return fpType;
    }

    // (#4480 S2) A `new F()` instance reports the object `F.prototype` reads.
    // Ordering is load-bearing — see fnctor-instance-prototype.ts.
    const fnctorInstanceProto = tryCompileFnctorInstanceGetPrototypeOf(ctx, fctx, arg0);
    if (fnctorInstanceProto) return fnctorInstanceProto;

    const argTsType = ctx.checker.getTypeAtLocation(arg0);

    const es5Value = tryCompileEs5GetPrototypeOfValue(ctx, fctx, expr);
    if (es5Value) return es5Value;

    // (#3013) `Object.getPrototypeOf(<array iterator>)` → the shared native
    // `%ArrayIteratorPrototype%` singleton (standalone/WASI). Every array
    // iterator (`[].values()` / `.keys()` / `.entries()` / `[][Symbol.iterator]()`
    // and any value flowing through an `ArrayIterator<T>`-typed binding) reports
    // the SAME prototype object by identity (§23.1.5.2). The TS checker names
    // ALL four producers' result type `ArrayIterator` — distinct from
    // `Generator`/`MapIterator`/`SetIterator`/`StringIterator` — so this routes
    // genuinely and never mis-maps a different iterator kind. Without it the
    // standalone fallback below returns `ref.null.extern`, which made the
    // identity assertion pass only coincidentally (null === null). Host/gc mode
    // keeps the `__getPrototypeOf` host import (byte-inert).
    if ((ctx.standalone || ctx.wasi) && argTsType.getSymbol()?.name === "ArrayIterator") {
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType) fctx.body.push({ op: "drop" });
      const protoType = emitArrayIteratorPrototypeSingleton(ctx, fctx);
      if (protoType) return protoType;
      // Runtime unavailable: preserve the historical null return.
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // (#3236 S2) `Object.getPrototypeOf(<sync generator instance>)` → the same
    // native `%GeneratorPrototype%` singleton that `genFn.prototype` /
    // `getPrototypeOf(genFn).prototype` resolve to (§27.5.1). A generator
    // INSTANCE (`g()`) is OrdinaryCreateFromConstructor(g, "%GeneratorPrototype%")
    // — its `[[Prototype]]` is the intrinsic %GeneratorPrototype% captured at
    // instantiation, INDEPENDENT of any later mutation of `g.prototype`
    // (default-proto.js sets `g.prototype = null` yet still expects GP). The
    // native generator model doesn't carry a per-instance proto slot, so we
    // route to the identity-stable GP singleton directly — the SAME cached
    // global `emitGeneratorPrototypeSingleton` returns everywhere, so the
    // `getPrototypeOf(g()) === getPrototypeOf(g).prototype` identity holds.
    // The TS checker names a sync generator's result type `Generator`
    // (distinct from `AsyncGenerator`, which keeps the host path), so this
    // routes genuinely. Compile+drop the arg for its evaluation side effects
    // (`g()` evaluates arguments; the generator body itself stays suspended).
    // Host/gc mode keeps the `__getPrototypeOf` import (byte-inert).
    if ((ctx.standalone || ctx.wasi) && argTsType.getSymbol()?.name === "Generator") {
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType) fctx.body.push({ op: "drop" });
      const protoType = emitGeneratorPrototypeSingleton(ctx, fctx);
      if (protoType) return protoType;
      // Runtime unavailable: preserve the historical null return.
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    const className = resolveStructName(ctx, argTsType);

    // For known class instances, return the class prototype singleton
    if (className && ctx.classSet.has(className)) {
      // (#802 Slice C) Marked-hierarchy receiver (standalone): the instance's
      // dynamic `$__proto__` field takes precedence over the compile-time
      // singleton. Field null = never dynamically set → the singleton (the
      // pre-#802 answer); the explicit-null sentinel reads as JS null
      // (`__dynproto_norm`); any other stored value is returned as-is.
      if (ctx.standalone) {
        const dpRoot = dynamicProtoRootFor(ctx, className);
        const dpRootTypeIdx = dpRoot !== undefined ? ctx.structMap.get(dpRoot) : undefined;
        const dpFieldIdx = dpRoot !== undefined ? dynamicProtoFieldIdx(ctx, dpRoot) : undefined;
        if (dpRoot !== undefined && dpRootTypeIdx !== undefined && dpFieldIdx !== undefined) {
          const argType = compileExpression(ctx, fctx, arg0);
          if (!argType) {
            fctx.body.push({ op: "ref.null.extern" });
            return { kind: "externref" };
          }
          const recvStructName =
            argType.kind === "ref" ? ctx.typeIdxToStructName.get((argType as { typeIdx: number }).typeIdx) : undefined;
          if (recvStructName !== undefined && dynamicProtoRootFor(ctx, recvStructName) === dpRoot) {
            // Non-null struct receiver: inline field read.
            const normIdx = reserveDynprotoNorm(ctx);
            fctx.body.push({ op: "struct.get", typeIdx: dpRootTypeIdx, fieldIdx: dpFieldIdx });
            const fLocal = allocLocal(fctx, `__dp_proto_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.tee", index: fLocal });
            fctx.body.push({ op: "ref.is_null" });
            // Build the lazy-singleton instrs off to the side so they can live
            // in the then-arm (emitLazyProtoGet appends to fctx.body).
            const saved = pushBody(fctx);
            const haveSingleton = emitLazyProtoGet(ctx, fctx, className);
            const singletonInstrs = fctx.body;
            popBody(fctx, saved);
            if (!haveSingleton) {
              singletonInstrs.length = 0;
              singletonInstrs.push({ op: "ref.null.extern" });
            }
            fctx.body.push({
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: singletonInstrs,
              else: [
                { op: "local.get", index: fLocal },
                { op: "call", funcIdx: normIdx },
              ],
            });
            return { kind: "externref" };
          }
          // Nullable / externref-typed receiver: route through the generic
          // native `__getPrototypeOf`, whose prepended (#802) marked arm reads
          // the struct field (finalize fill). No trap on a null receiver.
          if (argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
          const gptIdx = ensureLateImport(ctx, "__getPrototypeOf", [{ kind: "externref" }], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          if (gptIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: gptIdx });
          } else {
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "ref.null.extern" });
          }
          return { kind: "externref" };
        }
      }
      // Compile and drop the argument (for side effects)
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
      if (emitLazyProtoGet(ctx, fctx, className)) {
        return { kind: "externref" };
      }
    }

    // Fallback: use host import for externref/dynamic objects (e.g. Object.create results).
    return emitBuiltinGetPrototypeOfFallback(ctx, fctx, arg0);
  }

  // Handle Object.create(proto) — create instances for known prototypes
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "create" &&
    expr.arguments.length >= 1
  ) {
    const arg0 = expr.arguments[0]!;

    const staticPrototype = tryCompileObjectCreateStaticPrototype(ctx, fctx, arg0);
    if (staticPrototype !== undefined) return staticPrototype;

    // Host import path: Object.create(null) and Object.create(proto[, descriptors])
    // Object.create(null) → empty object with null prototype
    // Object.create(proto) → new object with __proto__ set to proto
    // Object.create(proto, descriptors) → expand descriptors at compile time
    const hostIdx = ensureLateImport(ctx, "__object_create", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);

    if (hostIdx !== undefined) {
      // Compile the proto argument
      if (arg0.kind === ts.SyntaxKind.NullKeyword) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (ctx.standalone) {
        // #2580 M3 Stage A — build an INLINE-LITERAL proto as a native `$Object`
        // (compileProtoArg) so __object_create's `ref.test $Object` succeeds and
        // the $proto link is recorded; a closed-shape literal struct would fail
        // that test → null proto → inherited reads return 0. Non-literal protos
        // (identifiers, calls, Foo.prototype) keep the ordinary path inside
        // compileProtoArg.
        compileProtoArg(ctx, fctx, arg0);
      } else {
        const argType = compileExpression(ctx, fctx, arg0);
        if (!argType) {
          // Expression produced no value — push null as fallback
          fctx.body.push({ op: "ref.null.extern" });
        } else if (argType.kind !== "externref") {
          // (#1462) Use coerceType — handles f64 → __box_number, i32 → boxed,
          // ref/ref_null → extern.convert_any. Bare extern.convert_any here would
          // emit an illegal cast on primitive types (e.g. `Object.create(5)`).
          coerceType(ctx, fctx, argType, { kind: "externref" });
        }
      }
      fctx.body.push({ op: "call", funcIdx: hostIdx });

      // Second argument (property descriptors): expand at compile time, but only
      // for descriptors this expansion can FULLY model. The admission test and
      // its reasoning are `mayStaticallyExpandCreateDescriptor` (#4061) —
      // accessors (silently dropped here), §6.2.5.6 violations, unresolvable flags.
      if (
        expr.arguments.length >= 2 &&
        ts.isObjectLiteralExpression(expr.arguments[1]!) &&
        (expr.arguments[1] as ts.ObjectLiteralExpression).properties.every(
          (p) => !ts.isPropertyAssignment(p) || mayStaticallyExpandCreateDescriptor(p.initializer, staticToBoolean),
        )
      ) {
        const descsLiteral = expr.arguments[1] as ts.ObjectLiteralExpression;
        // Save created object to local for repeated use
        const objLocal = allocLocal(fctx, `__ocreate_obj_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: objLocal });

        // Expand each property descriptor as Object.defineProperty(obj, key, desc)
        for (const prop of descsLiteral.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const propName = ts.isIdentifier(prop.name)
            ? prop.name.text
            : ts.isStringLiteral(prop.name)
              ? prop.name.text
              : ts.isNumericLiteral(prop.name)
                ? prop.name.text
                : undefined;
          if (propName === undefined) continue;

          // Parse descriptor fields from the object literal
          let valueExpr: ts.Expression | undefined;
          let getExpr: ts.Expression | undefined;
          let setExpr: ts.Expression | undefined;
          let descWritable: boolean | undefined;
          let descEnumerable: boolean | undefined;
          let descConfigurable: boolean | undefined;

          if (ts.isObjectLiteralExpression(prop.initializer)) {
            for (const dp of prop.initializer.properties) {
              if (ts.isPropertyAssignment(dp) && ts.isIdentifier(dp.name)) {
                if (dp.name.text === "value") valueExpr = dp.initializer;
                if (dp.name.text === "get") getExpr = dp.initializer;
                if (dp.name.text === "set") setExpr = dp.initializer;
                // Per §6.2.6 ToPropertyDescriptor: each flag is ToBoolean-coerced —
                // `configurable: 123` / `'x'` / `{}` are all truthy. Statically
                // evaluate ToBoolean for literal-shape initializers; bail to the
                // runtime fallback (descWritable left undefined → handled below)
                // for anything we can't resolve at compile time.
                if (dp.name.text === "writable") {
                  descWritable = staticToBoolean(dp.initializer);
                }
                if (dp.name.text === "enumerable") {
                  descEnumerable = staticToBoolean(dp.initializer);
                }
                if (dp.name.text === "configurable") {
                  descConfigurable = staticToBoolean(dp.initializer);
                }
              }
            }
          }

          // Emit __defineProperty_value(obj, prop, value, flags)
          const dpIdx = ensureLateImport(
            ctx,
            "__defineProperty_value",
            [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
            [{ kind: "externref" }],
          );
          flushLateImportShifts(ctx, fctx);

          if (dpIdx !== undefined) {
            // obj
            fctx.body.push({ op: "local.get", index: objLocal });
            // prop name as string constant. (#51) Materialize via the dual-mode
            // helper — under nativeStrings `addStringConstantGlobal` records a
            // `-1` sentinel global (no host string-constant global), so a bare
            // `global.get -1` reaches binary emit as "global index out of range
            // — -1". `stringConstantExternrefInstrs` emits the inline
            // NativeString externref standalone and the host `global.get` under GC.
            addStringConstantGlobal(ctx, propName);
            fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
            // Missing value defaults to canonical JS undefined (§8.10.5; #3042).
            if (valueExpr) {
              const vt = compileExpression(ctx, fctx, valueExpr);
              if (!vt) {
                emitUndefined(ctx, fctx);
              } else if (vt.kind !== "externref") {
                coerceType(ctx, fctx, vt, { kind: "externref" });
              }
            } else {
              emitUndefined(ctx, fctx);
            }
            // flags: bit 0=writable, 1=enumerable, 2=configurable, 3=writable specified,
            //        4=enumerable specified, 5=configurable specified, 7=has value
            let flags = 0;
            if (descWritable) flags |= 1;
            if (descEnumerable) flags |= 2;
            if (descConfigurable) flags |= 4;
            if (descWritable !== undefined) flags |= 8;
            if (descEnumerable !== undefined) flags |= 16;
            if (descConfigurable !== undefined) flags |= 32;
            if (valueExpr) flags |= 128; // has value
            if (getExpr || setExpr) flags |= 64; // is accessor
            fctx.body.push({ op: "i32.const", value: flags });
            fctx.body.push({ op: "call", funcIdx: dpIdx });
            fctx.body.push({ op: "drop" }); // defineProperty returns obj, drop it
          }
        }
        // Push obj back on stack as the result
        fctx.body.push({ op: "local.get", index: objLocal });
      } else if (expr.arguments.length >= 2 && ts.isObjectLiteralExpression(expr.arguments[1]!)) {
        // Object literal second arg with non-literal descriptor values (identifiers/expressions).
        // Iterate properties at compile time, calling __defineProperty_desc(obj, key, desc)
        // for each. This lets the runtime use native Object.defineProperty which traverses
        // the descriptor's prototype chain per ToPropertyDescriptor (ECMA-262 §10.1).
        const descsLiteral = expr.arguments[1] as ts.ObjectLiteralExpression;
        const objLocal = allocLocal(fctx, `__ocreate_obj_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: objLocal });

        // (#2515 S1) Per-property descriptor apply. In `--target standalone`
        // there is no JS host, so the `__defineProperty_desc` host import is
        // refused (#1472 Phase B) — route instead to the Wasm-native
        // `__obj_define_from_desc(obj, key, descObj)` helper, the SAME native
        // `Object.defineProperty` standalone uses (object-ops.ts). It performs
        // ToPropertyDescriptor over the descriptor `$Object` and dispatches to
        // the native `__defineProperty_value`/`__defineProperty_accessor`
        // store. Host/gc/wasi keep the precise `__defineProperty_desc` import.
        let dpDescIdx: number | undefined;
        if (ctx.standalone) {
          ensureObjectRuntime(ctx);
          dpDescIdx = ctx.funcMap.get("__obj_define_from_desc");
        } else {
          dpDescIdx = ensureLateImport(
            ctx,
            "__defineProperty_desc",
            [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
            [{ kind: "externref" }],
          );
          flushLateImportShifts(ctx, fctx);
        }

        for (const prop of descsLiteral.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const propName = ts.isIdentifier(prop.name)
            ? prop.name.text
            : ts.isStringLiteral(prop.name)
              ? prop.name.text
              : ts.isNumericLiteral(prop.name)
                ? prop.name.text
                : undefined;
          if (propName === undefined) continue;

          // (#4061) The two ToPropertyDescriptor TypeErrors the dynamic applier
          // structurally cannot report — see `staticDescriptorTypeError`. Emitted
          // where THIS key applies, after its side effects, so earlier keys land first.
          const descTypeError = staticDescriptorTypeError(prop.initializer);
          if (descTypeError !== undefined) {
            const sideEffectType = compileExpression(ctx, fctx, prop.initializer);
            if (sideEffectType) fctx.body.push({ op: "drop" });
            emitThrowTypeError(ctx, fctx, descTypeError);
            fctx.body.push({ op: "unreachable" });
            return { kind: "externref" };
          }

          if (dpDescIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: objLocal });
            // (#51) Dual-mode key materialization — nativeStrings stores a `-1`
            // sentinel global, so a bare `global.get` crashes binary emit.
            addStringConstantGlobal(ctx, propName);
            fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
            // (#3253) Under standalone, build a plain inline descriptor object
            // literal as a native `$Object` so `__obj_define_from_desc`'s
            // `ref.test $Object` succeeds. A contextually-typed descriptor
            // literal (its type resolves to `PropertyDescriptor`, a CONCRETE
            // object type — not `any`) otherwise compiles to a CLOSED struct the
            // applier rejects, so `value` and the ToBoolean-coerced
            // writable/enumerable/configurable flags are silently dropped —
            // e.g. `Object.create(o, {p: {value: 9, configurable: new
            // Boolean(true)}})` lost the value and read configurable as false.
            // Mirrors compileObjectAssignArg / compileProtoArg (#2076 / #2580).
            // `compileObjectLiteralAsExternref` returns null only before any
            // emit (import unavailable) and skips computed/symbol keys, so a
            // fall-through to the generic path is side-effect-free.
            let descValType: ValType | null | undefined;
            if (ctx.standalone && ts.isObjectLiteralExpression(prop.initializer)) {
              descValType = compileObjectLiteralAsExternref(ctx, fctx, prop.initializer);
            }
            if (descValType === undefined || descValType === null) {
              descValType = compileExpression(ctx, fctx, prop.initializer);
            }
            if (!descValType) {
              fctx.body.push({ op: "ref.null.extern" });
            } else if (descValType.kind !== "externref") {
              coerceType(ctx, fctx, descValType, { kind: "externref" });
            }
            fctx.body.push({ op: "call", funcIdx: dpDescIdx });
            fctx.body.push({ op: "drop" });
          }
        }
        fctx.body.push({ op: "local.get", index: objLocal });
      } else if (expr.arguments.length >= 2) {
        emitObjectCreateDynamicProperties(ctx, fctx, expr.arguments[1]!);
      }
      return { kind: "externref" };
    }

    // Standalone fallback (no host): compile arg for side effects, return null externref
    if (arg0.kind === ts.SyntaxKind.NullKeyword) {
      fctx.body.push({ op: "ref.null.extern" });
    } else {
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle Object.defineProperty(obj, prop, descriptor) — stub
  // If descriptor is an object literal with a `value` property, sets obj[prop] = value via __extern_set.
  // Otherwise compiles all args for side effects and returns obj.
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "defineProperty" &&
    expr.arguments.length >= 3
  ) {
    return compileObjectDefineProperty(ctx, fctx, expr);
  }

  // Handle Object.defineProperties(obj, props) — expand to individual defineProperty calls
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "defineProperties" &&
    expr.arguments.length >= 2
  ) {
    return compileObjectDefineProperties(ctx, fctx, expr);
  }

  // Handle Object.getOwnPropertyDescriptor(obj, prop)
  // Fast path: known struct type + string literal prop → inline struct.get + __create_descriptor
  // Fallback: __getOwnPropertyDescriptor host import for dynamic cases
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "getOwnPropertyDescriptor" &&
    expr.arguments.length >= 2
  ) {
    const arg0 = expr.arguments[0]!;
    const arg1 = expr.arguments[1]!;
    // §10.4.1.1: in Script code, top-level `this` is the realm global object.
    // It must stay on the host-MOP path here: the checker's global interface
    // resolves to a large static struct, whose missing-property fast path would
    // return undefined without consulting the property just created by sloppy
    // unresolvable PutValue. This is deliberately gOPD-local; general Script
    // `this` lowering belongs to the source-goal implementation (#3365).
    const isScriptGlobalThisReceiver =
      arg0.kind === ts.SyntaxKind.ThisKeyword &&
      fctx.name === "__module_init" &&
      !ts.isExternalModule(arg0.getSourceFile()) &&
      !ctx.standalone &&
      !ctx.wasi;

    // (#2874) Under standalone, register the native object runtime so the
    // typed-receiver fast path's `ensureLateImport("__create_descriptor", …)`
    // below resolves to the native `__create_descriptor` (object-runtime.ts)
    // instead of leaking the `env::__create_descriptor` host import (which has
    // no standalone carrier — the module would trap). Idempotent.
    if (ctx.standalone) ensureObjectRuntime(ctx);

    // Try compile-time fast path: known struct + literal property name.
    // (#2965) Standalone also canonicalizes NON-string literal keys
    // (`gOPD(obj, -20)` / `gOPD(obj, true)`) to their §7.1.19 ToPropertyKey
    // string form ("-20"/"true") so they hit the SAME struct fast path a
    // string-literal key takes. Without this they fell through to the
    // dynamic `__getOwnPropertyDescriptor` native, which answers `undefined`
    // for a typed-struct receiver (it only walks `$Object`s), so
    // `gOPD(obj, -20).value` threw on a property that exists as "-20"
    // (test262 15.2.3.3-2-* — argument 'P' is a number/boolean). Host/gc
    // mode is NOT rerouted (its dynamic path delegates ToPropertyKey to the
    // host import and already passes) — gated on ctx.standalone so host
    // bytes stay identical.
    const arg0TsType = ctx.checker.getTypeAtLocation(arg0);
    const structName = isScriptGlobalThisReceiver ? undefined : resolveStructName(ctx, arg0TsType);
    const literalKeyText = (e: ts.Expression): string | undefined => {
      if (ts.isStringLiteral(e)) return e.text;
      if (!ctx.standalone) return undefined;
      if (ts.isNumericLiteral(e)) return String(Number(e.text));
      if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) {
        return String(-Number(e.operand.text));
      }
      if (e.kind === ts.SyntaxKind.TrueKeyword) return "true";
      if (e.kind === ts.SyntaxKind.FalseKeyword) return "false";
      return undefined;
    };
    const propLiteral = literalKeyText(arg1);

    // (#2984) `gOPD(this, "NaN"|"Infinity"|"undefined")` — the sloppy-mode
    // GLOBAL `this` (no local binding, not a static-class context) folds at
    // RUNTIME to the spec §19.1 value-property descriptor when nullish, and
    // keeps the dynamic read for a real dispatched receiver. Full rationale
    // on `emitGlobalThisGopdFold` (dyn-read.ts). Receiver is compiled FIRST
    // (its lowering may add late imports) — the helper captures funcIdxs
    // after it.
    if (
      arg0.kind === ts.SyntaxKind.ThisKeyword &&
      (propLiteral === "NaN" || propLiteral === "Infinity" || propLiteral === "undefined") &&
      fctx.localMap.get("this") === undefined &&
      !(fctx.isStaticContext && fctx.enclosingClassName)
    ) {
      const thisType = compileExpression(ctx, fctx, arg0);
      if (thisType && thisType.kind !== "externref") coerceType(ctx, fctx, thisType, { kind: "externref" });
      emitGlobalThisGopdFold(ctx, fctx, propLiteral);
      return { kind: "externref" };
    }

    if (structName && propLiteral !== undefined) {
      const structTypeIdx = ctx.structMap.get(structName);
      const fields = ctx.structFields.get(structName);

      if (structTypeIdx !== undefined && fields) {
        // Find the field index for the property name
        const userFields = fields
          .map((f, idx) => ({ field: f, fieldIdx: idx }))
          .filter((e) => !e.field.name.startsWith("__"));
        const entry = userFields.find((e) => e.field.name === propLiteral);
        const sidecarDefinedKey =
          ts.isIdentifier(arg0) && ctx.sidecarDefinedPropertyKeys.has(`${arg0.text}:${propLiteral}`);

        if (entry && !sidecarDefinedKey) {
          // #1629b: Object.defineProperty updates `definedPropertyFlags`
          // (keyed `varName:propName`) but `shapePropFlags` is built AFTER
          // body compilation finishes, so per-variable updates made during
          // codegen are lost when the table is initialized with defaults.
          // Read the per-variable map first, then fall back to the shape table.
          const flagsArr = ctx.shapePropFlags.get(structTypeIdx);
          const userFieldIdx = userFields.indexOf(entry);
          let flags = flagsArr && userFieldIdx >= 0 ? flagsArr[userFieldIdx]! : 0x07; // default WEC
          if (ts.isIdentifier(arg0)) {
            // (#3403) per-declaration key so a foreign same-named var's flags
            // don't leak into this receiver's gOPD.
            const dpfKey = `${integrityVarKey(ctx, arg0)}:${propLiteral}`;
            const dpfFlags = ctx.definedPropertyFlags.get(dpfKey);
            if (dpfFlags !== undefined) flags = dpfFlags & 0x0f;
          }

          // Compile the object expression
          const objType = compileExpression(ctx, fctx, arg0);
          if (!objType) {
            fctx.body.push({ op: "ref.null.extern" });
            return { kind: "externref" };
          }

          // Guard cast with ref.test to avoid illegal cast traps (#778).
          // If the runtime type doesn't match, convert to anyref for testing.
          {
            let needsCast = false;
            if (objType.kind === "externref") {
              fctx.body.push({ op: "any.convert_extern" });
              needsCast = true;
            } else if (objType.kind === "ref_null" && objType.typeIdx !== structTypeIdx) {
              needsCast = true;
            }
            if (needsCast) {
              const gopdTmp = allocLocal(fctx, `__gopd_tmp_${fctx.locals.length}`, { kind: "anyref" });
              fctx.body.push({ op: "local.set", index: gopdTmp });
              fctx.body.push({ op: "local.get", index: gopdTmp });
              fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
              fctx.body.push({
                op: "if",
                blockType: { kind: "val", type: { kind: "externref" } as ValType },
                then: (() => {
                  // Cast succeeds — proceed with struct.get + descriptor
                  const thenInstrs: Instr[] = [
                    { op: "local.get", index: gopdTmp },
                    { op: "ref.cast", typeIdx: structTypeIdx },
                    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx },
                  ];
                  // Coerce field value to externref
                  const ft = entry.field.type;
                  if (ft.kind === "f64") {
                    const boxIdx2 = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                    flushLateImportShifts(ctx, fctx);
                    if (boxIdx2 !== undefined) thenInstrs.push({ op: "call", funcIdx: boxIdx2 });
                  } else if (ft.kind === "i32") {
                    thenInstrs.push({ op: "f64.convert_i32_s" });
                    const boxIdx2 = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                    flushLateImportShifts(ctx, fctx);
                    if (boxIdx2 !== undefined) thenInstrs.push({ op: "call", funcIdx: boxIdx2 });
                  } else if (ft.kind === "ref" || ft.kind === "ref_null") {
                    thenInstrs.push({ op: "extern.convert_any" });
                  } else if (ft.kind !== "externref") {
                    thenInstrs.push({ op: "extern.convert_any" });
                  }
                  // Push flags + call __create_descriptor
                  thenInstrs.push({ op: "i32.const", value: flags });
                  const createIdx2 = ensureLateImport(
                    ctx,
                    "__create_descriptor",
                    [{ kind: "externref" }, { kind: "i32" }],
                    [{ kind: "externref" }],
                  );
                  flushLateImportShifts(ctx, fctx);
                  if (createIdx2 !== undefined) thenInstrs.push({ op: "call", funcIdx: createIdx2 });
                  return thenInstrs;
                })(),
                else: (() => {
                  // (#3321) Cast would fail — the runtime miss must be JS
                  // `undefined` on every lane: host/gc → the real
                  // `__get_undefined` sentinel (bare null externref is `null`
                  // there); standalone singleton regime → the tag-1
                  // `$undefined` singleton; legacy standalone keeps the
                  // byte-identical `ref.null.extern`. Resolved AFTER the
                  // then-arm's late imports (source-order property eval) so
                  // adding the import cannot skew the already-baked idxs —
                  // and in gc all three are env imports (idx-stable), while
                  // standalone adds no import at all here.
                  const undefIdx = ensureGetUndefined(ctx);
                  if (undefIdx !== undefined) {
                    flushLateImportShifts(ctx, fctx);
                    return [{ op: "call", funcIdx: undefIdx } satisfies Instr];
                  }
                  return (
                    undefinedExternInstrs(ctx)?.map((i) => ({ ...i })) ?? [{ op: "ref.null.extern" } satisfies Instr]
                  );
                })(),
              });
              return { kind: "externref" };
            }
          }

          // Save obj ref for struct.get (direct path — type already matches)
          const objLocal = allocLocal(fctx, `__gopd_obj_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: structTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: objLocal });

          // Get field value: struct.get → coerce to externref
          fctx.body.push({ op: "local.get", index: objLocal });
          fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx });

          // Coerce field value to externref for __create_descriptor
          const fieldType = entry.field.type;
          if (fieldType.kind === "f64") {
            const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
            flushLateImportShifts(ctx, fctx);
            if (boxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: boxIdx });
            }
          } else if (fieldType.kind === "i32") {
            fctx.body.push({ op: "f64.convert_i32_s" });
            const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
            flushLateImportShifts(ctx, fctx);
            if (boxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: boxIdx });
            }
          } else if (fieldType.kind === "i64") {
            fctx.body.push({ op: "f64.convert_i64_s" });
            const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
            flushLateImportShifts(ctx, fctx);
            if (boxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: boxIdx });
            }
          } else if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else if (fieldType.kind !== "externref") {
            // Other types: try extern.convert_any
            fctx.body.push({ op: "extern.convert_any" });
          }

          // Push flags as i32 constant
          fctx.body.push({ op: "i32.const", value: flags });

          // Call __create_descriptor(value, flags) → externref
          const createIdx = ensureLateImport(
            ctx,
            "__create_descriptor",
            [{ kind: "externref" }, { kind: "i32" }],
            [{ kind: "externref" }],
          );
          flushLateImportShifts(ctx, fctx);
          if (createIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: createIdx });
          }
          return { kind: "externref" };
        }
        // #1364a — if the property is a registered class method, fall
        // through to the dynamic `__getOwnPropertyDescriptor` host import
        // path (which now handles proto-method allowlists by returning a
        // descriptor with `enumerable: false, configurable: true,
        // writable: true`). Without this, the fast path returns
        // `ref.null.extern` (undefined) for any class method lookup, and
        // `verifyProperty(C.prototype, "m", {...})` fails before checking
        // any flag.
        //
        // (#1395) Same logic for static methods on the class object —
        // `verifyProperty(C, "m", {...})` lookups need the runtime arm to
        // fire instead of returning `ref.null.extern` here.
        if (!sidecarDefinedKey) {
          const methodNames = ctx.classMethodNames.get(structName);
          const staticMethodNames = ctx.classStaticMethodNames.get(structName);
          const isMethodLookup =
            (methodNames && methodNames.includes(propLiteral)) ||
            (staticMethodNames && staticMethodNames.includes(propLiteral));
          if (isMethodLookup) {
            // Skip the fast-path null-return; let the dynamic fallback below
            // handle the method case via the host import.
          } else {
            // Property not found in struct — return undefined
            // (own property doesn't exist on this shape). (#3319/#3321) The
            // miss must be observable as JS `undefined` on EVERY lane:
            // host/gc → the real `__get_undefined` sentinel (bare null
            // externref is `null` there — `gOPD(o, missing) === undefined`
            // answered false, the gc twin of the issue-2874 shape);
            // standalone singleton regime → the tag-1 `$undefined` singleton;
            // legacy standalone keeps the byte-identical `ref.null.extern`.
            // `emitUndefined` is the canonical all-lane emitter for exactly
            // this dispatch.
            const argResult = compileExpression(ctx, fctx, arg0);
            if (argResult) fctx.body.push({ op: "drop" });
            emitUndefined(ctx, fctx);
            return { kind: "externref" };
          }
        }
      }
    }

    // (#2885 Site 2) Standalone builtin-proto descriptor synthesis. The native
    // `__getOwnPropertyDescriptor` only understands `$Object`; an INTRINSIC
    // accessor/method on a virtual `$NativeProto` (e.g. `RegExp.prototype.global`)
    // is invisible to it, so gOPD returns undefined and `desc.get` then derefs
    // undefined → trap. Synthesize the descriptor directly from the brand-keyed
    // closure factory when arg0 is a literal `<Builtin>.prototype` and arg1 names
    // a member the glue advertises. Anything that doesn't resolve falls through
    // to the dynamic fallback below (no behavior change for other receivers).
    // (#2901) Resolve the proto's builtin name from EITHER the syntactic
    // `<Ctor>.prototype` form OR the harness's dynamic %TypedArray%.prototype
    // receiver traced through intermediate vars.
    const gopdProtoBuiltin = resolveBuiltinProtoGopdReceiver(ctx, fctx, arg0, propLiteral, BUILTIN_CTOR_NAMES, (e) =>
      tracesToTypedArrayIntrinsicProto(ctx, e),
    );
    // (#4200) `constructor` is OWN on every builtin prototype but is NOT a
    // method, so it misses the member-CSV gate below and answered `undefined`.
    // Synthesized from the same carrier module as the VALUE read, before that
    // gate — see builtin-proto-constructor.ts.
    if (tryEmitBuiltinProtoConstructorDescriptor(ctx, fctx, gopdProtoBuiltin, propLiteral)) {
      return { kind: "externref" };
    }
    if (gopdProtoBuiltin !== undefined && propLiteral !== undefined) {
      const protoBuiltin = gopdProtoBuiltin;
      const protoMember = propLiteral;
      const protoBrand = tryEnsureNativeProtoBrand(ctx, protoBuiltin);
      const protoGlue = protoBrand !== undefined ? getNativeProtoBuiltinGlue(ctx, protoBrand) : undefined;
      if (protoBrand !== undefined && protoGlue && protoGlue.memberCsv.split(",").includes(protoMember)) {
        const memberKind = protoGlue.memberKind(protoMember);
        // (#2984 Phase 2) Un-wired members reify as identity-stable throwing
        // closures (see native-proto-value-read.ts) so the descriptor is
        // spec-shaped and `desc.value === <Builtin>.prototype.<m>` holds.
        const protoClosure = ensureStandaloneNativeMethodClosure(ctx, protoBrand, protoMember, memberKind, {
          refusalBodyFallback: true,
        });
        if (protoClosure) {
          if (memberKind === "getter") {
            // Accessor descriptor: get=<closure>, set=undefined,
            // {enumerable:false, configurable:true} (intrinsic accessor attrs).
            const createAccIdx = ensureLateImport(
              ctx,
              "__create_accessor_descriptor",
              [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
              [{ kind: "externref" }],
            );
            flushLateImportShifts(ctx, fctx);
            if (createAccIdx !== undefined) {
              // (#2175 V2-S2) Identity-stable getter singleton so the accessor's
              // `.get` is the SAME function object across repeated gOPD calls and
              // the syntactic getter-invocation self (property-access.ts Site 3).
              fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, protoClosure));
              fctx.body.push({ op: "extern.convert_any" }); // get
              fctx.body.push({ op: "ref.null.extern" }); // set = undefined
              fctx.body.push({ op: "i32.const", value: 0x04 }); // FLAG_CONFIGURABLE
              fctx.body.push({ op: "call", funcIdx: createAccIdx });
              return { kind: "externref" };
            }
          } else {
            // Data descriptor: value=<method closure>,
            // {writable:true, enumerable:false, configurable:true}.
            const createIdx = ensureLateImport(
              ctx,
              "__create_descriptor",
              [{ kind: "externref" }, { kind: "i32" }],
              [{ kind: "externref" }],
            );
            flushLateImportShifts(ctx, fctx);
            if (createIdx !== undefined) {
              // (#2175 V2-S2) Identity-stable method singleton so the data
              // descriptor's `.value` is the SAME function object as the syntactic
              // read `RegExp.prototype.exec` (property-access.ts method arm):
              // `gOPD(p,"exec").value === RegExp.prototype.exec`.
              fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, protoClosure));
              fctx.body.push({ op: "extern.convert_any" }); // value
              fctx.body.push({ op: "i32.const", value: 0x05 }); // FLAG_WRITABLE | FLAG_CONFIGURABLE
              fctx.body.push({ op: "call", funcIdx: createIdx });
              return { kind: "externref" };
            }
          }
        }
      }
    }

    // (#2984 Phase 3) Standalone builtin-CTOR/NAMESPACE-receiver descriptor
    // synthesis — `gOPD(Math, "atan2")`, `gOPD(Date, "prototype")`,
    // `gOPD(Number, "MAX_VALUE")`, `gOPD(String, "length")`. The dynamic
    // fallback below routes a builtin-identifier receiver through
    // `__get_builtin`, which refuses-loud under standalone (#1472 Phase B) —
    // every shape this arm intercepts was a hard CE on main, so synthesizing
    // the §6.1.7.3 descriptor from the compile-time static-property tables
    // (builtin-static-gopd.ts) is strictly regression-free. Unresolvable
    // members (Symbol well-knowns / RegExp legacy statics / dynamic keys)
    // fall through to the existing refusal; host/gc keeps the working
    // `__get_builtin` host route untouched.
    // (#2984 bucket-1) The receiver recognizer also follows one level of
    // reaching-def aliasing (`var m = Math; gOPD(m, "atan2")` — the dominant
    // 15.2.3.3-4-* fixture shape) via the conservative AST-only resolver in
    // builtin-static-gopd.ts; direct unshadowed builtins resolve as before.
    if (ctx.standalone && propLiteral !== undefined) {
      const builtinRecv = resolveBuiltinReceiverName(fctx, arg0, BUILTIN_CLASS_NAMES);
      if (builtinRecv !== undefined && tryEmitStandaloneBuiltinStaticGopd(ctx, fctx, builtinRecv, propLiteral)) {
        return { kind: "externref" };
      }
    }

    // (#2984 "builtin receiver + non-literal key") `gOPD(<Ctor>,
    // Symbol.species)` — the dominant NON-literal-key builtin-receiver shape
    // (26 standalone CEs: built-ins/*/Symbol.species/*). The @@species own
    // property is an ACCESSOR `{get: "get [Symbol.species]" (returns this),
    // set: undefined, e:false, c:true}`; synthesize it from the per-ctor
    // getter singleton (builtin-static-gopd.ts). Every intercepted shape
    // CE'd via the `__get_builtin` refusal below, so the arm is strictly
    // additive; non-owner receivers / other symbol keys (Symbol well-knowns,
    // RegExp annex-B legacy statics) keep the refusal. Both operands are
    // side-effect-free (builtin/alias identifier + `Symbol.species` fold),
    // so neither is compiled — same discipline as the Phase-3 literal arm.
    if (ctx.standalone && propLiteral === undefined && isSymbolSpeciesKeyExpression(fctx, arg1)) {
      const builtinRecv = resolveBuiltinReceiverName(fctx, arg0, BUILTIN_CLASS_NAMES);
      if (builtinRecv !== undefined && tryEmitStandaloneBuiltinSpeciesGopd(ctx, fctx, builtinRecv)) {
        return { kind: "externref" };
      }
    }

    // (#2984 arg-2 name coercion) Struct receiver + NON-literal key: runtime
    // ToPropertyKey dispatch over the compile-time field set (the dynamic
    // native below only walks $Objects, so a struct receiver always answered
    // `undefined` — test262 15.2.3.3-2-*). See builtin-static-gopd.ts.
    if (
      ctx.standalone &&
      propLiteral === undefined &&
      structName &&
      tryEmitStandaloneStructGopdKeyDispatch(ctx, fctx, arg0, arg1, structName)
    ) {
      return { kind: "externref" };
    }

    // Fallback: dynamic case — delegate to __getOwnPropertyDescriptor host import
    // If arg0 is a known built-in global identifier, use __get_builtin to get
    // the real JS object instead of the ref.null.extern from compileIdentifier.
    const arg0IsBuiltin = ts.isIdentifier(arg0) && BUILTIN_CLASS_NAMES.has((arg0 as ts.Identifier).text);

    let getBuiltinFuncIdx: number | undefined;
    if (arg0IsBuiltin) {
      getBuiltinFuncIdx = ensureLateImport(ctx, "__get_builtin", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
    }

    let objType: ReturnType<typeof compileExpression>;
    if (arg0IsBuiltin && getBuiltinFuncIdx !== undefined) {
      const builtinName = (arg0 as ts.Identifier).text;
      addStringConstantGlobal(ctx, builtinName);
      const strIdx = ctx.stringGlobalMap.get(builtinName);
      // (#2515 S0) `>= 0`, not `!== undefined`: the standalone `-1` sentinel
      // must fall to the inline-materializing path, not bake `global.get -1`.
      if (strIdx !== undefined && strIdx >= 0) {
        fctx.body.push({ op: "global.get", index: strIdx });
      } else {
        compileStringLiteral(ctx, fctx, builtinName);
      }
      fctx.body.push({ op: "call", funcIdx: getBuiltinFuncIdx });
      objType = { kind: "externref" };
    } else if (isScriptGlobalThisReceiver) {
      ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      const globalThisIdx = ctx.funcMap.get("__get_globalThis");
      if (globalThisIdx === undefined) {
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "call", funcIdx: globalThisIdx });
      objType = { kind: "externref" };
    } else {
      objType = compileExpression(ctx, fctx, arg0, { kind: "externref" });
      if (!objType) {
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      if (objType.kind !== "externref") {
        coerceType(ctx, fctx, objType, { kind: "externref" });
      }
    }

    const propType = compileExpression(ctx, fctx, arg1, { kind: "externref" });
    if (!propType) {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    if (propType.kind !== "externref") {
      coerceType(ctx, fctx, propType, { kind: "externref" });
    }
    const funcIdx = ensureLateImport(
      ctx,
      "__getOwnPropertyDescriptor",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // Handle Object.getOwnPropertyNames(obj) — returns all own string-keyed property names
  // (including non-enumerable), delegates to __getOwnPropertyNames host import.
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "getOwnPropertyNames" &&
    expr.arguments.length >= 1
  ) {
    const arg = expr.arguments[0]!;
    // (#4227) §20.1.2.10 step 1 is `ToObject(O)`, so `null`/`undefined` throws.
    // Host delegates to the real builtin and already did; the standalone
    // `__getOwnPropertyNames` native has no nullish arm and answered an empty
    // name list (15.2.3.4-1-2/-1-3). SYNTACTIC on purpose: `Object.keys`' twin
    // guard (#2746) reads the argument's TS type, which the #1930 oracle ratchet
    // forbids in new codegen — and a primitive receiver must NOT be caught here,
    // since ES2015+ ToObject wraps it rather than throwing.
    const isSyntacticNullish =
      arg.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(arg) && arg.text === "undefined" && !fctx.localMap.has("undefined"));
    if (isSyntacticNullish) {
      emitThrowTypeError(ctx, fctx, "TypeError: Cannot convert undefined or null to object");
      fctx.body.push({ op: "unreachable" });
      return { kind: "externref" };
    }
    const argResult = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (!argResult) {
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    if (argResult.kind !== "externref") {
      coerceType(ctx, fctx, argResult, { kind: "externref" });
    }
    const funcIdx = ensureLateImport(ctx, "__getOwnPropertyNames", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle Object.getOwnPropertySymbols(obj) — returns own symbol-keyed properties
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "getOwnPropertySymbols" &&
    expr.arguments.length >= 1
  ) {
    const arg = expr.arguments[0]!;
    const argResult = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (!argResult) {
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    if (argResult.kind !== "externref") {
      coerceType(ctx, fctx, argResult, { kind: "externref" });
    }
    const funcIdx = ensureLateImport(ctx, "__getOwnPropertySymbols", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle Object.hasOwn(obj, key) — ES2022 static method (#965)
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "hasOwn" &&
    expr.arguments.length >= 2
  ) {
    const objArg = expr.arguments[0]!;
    const keyArg = expr.arguments[1]!;
    const objType = compileExpression(ctx, fctx, objArg, { kind: "externref" });
    if (objType && objType.kind !== "externref") coerceType(ctx, fctx, objType, { kind: "externref" });
    const keyType = compileExpression(ctx, fctx, keyArg, { kind: "externref" });
    if (keyType && keyType.kind !== "externref") coerceType(ctx, fctx, keyType, { kind: "externref" });
    const funcIdx = ensureLateImport(
      ctx,
      "__object_hasOwn",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i32" };
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Handle Object.is(x, y) — SameValue comparison (#965)
  // Delegates to host: handles NaN===NaN and +0!==-0 correctly.
  // Uses type-aware boxing: booleans use __box_boolean, numbers use __box_number,
  // so that Object.is(false, 0) correctly returns false (different JS types).
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "is" &&
    expr.arguments.length >= 2
  ) {
    const xArgEarly = expr.arguments[0]!;
    const yArgEarly = expr.arguments[1]!;
    // (#2375) Native SameValue (§20.1.2.13) for statically same-type scalar
    // args — no boxing, no host `__object_is` (unsatisfiable in --target
    // standalone, where Object.is otherwise CE'd). Purely additive: only fires
    // when BOTH args are the same primitive type; everything else falls through
    // to the existing boxed `__object_is` path unchanged. Host mode benefits too
    // (avoids the boxing round-trip) but the host path is preserved for the
    // mixed/dynamic cases.
    {
      const xType = ctx.checker.getTypeAtLocation(xArgEarly);
      const yType = ctx.checker.getTypeAtLocation(yArgEarly);
      const bothNumber = isNumberType(xType) && isNumberType(yType) && !isBooleanType(xType) && !isBooleanType(yType);
      const bothBoolean = isBooleanType(xType) && isBooleanType(yType);
      const bothString = isStringType(xType) && isStringType(yType);

      if (bothBoolean) {
        // Booleans lower to i32 (0/1). SameValue(bool, bool) === strict equality.
        const xt = compileExpression(ctx, fctx, xArgEarly);
        if (xt && xt.kind !== "i32") coerceType(ctx, fctx, xt, { kind: "i32" });
        const yt = compileExpression(ctx, fctx, yArgEarly);
        if (yt && yt.kind !== "i32") coerceType(ctx, fctx, yt, { kind: "i32" });
        fctx.body.push({ op: "i32.eq" });
        return { kind: "i32" };
      }

      if (bothNumber) {
        // SameValue(Number x, Number y): true iff x,y are both NaN, OR their
        // IEEE-754 bit patterns are identical (which distinguishes +0 from -0
        // — different sign bit — and treats all NaN as equal via the both-NaN
        // clause). Lower as:
        //   (x !== x && y !== y) | (i64.reinterpret(x) == i64.reinterpret(y))
        const xLocal = allocLocal(fctx, `__objis_x_${fctx.locals.length}`, { kind: "f64" });
        const yLocal = allocLocal(fctx, `__objis_y_${fctx.locals.length}`, { kind: "f64" });
        const xt = compileExpression(ctx, fctx, xArgEarly);
        if (xt && xt.kind !== "f64") coerceType(ctx, fctx, xt, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: xLocal });
        const yt = compileExpression(ctx, fctx, yArgEarly);
        if (yt && yt.kind !== "f64") coerceType(ctx, fctx, yt, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: yLocal });
        // SameValue(Number, Number): (bits(x) == bits(y)) | bothNaN — shared with
        // the reified `Object.is` value closure so the two never drift.
        for (const instr of sameValueNumberOps(xLocal, yLocal)) fctx.body.push(instr);
        return { kind: "i32" };
      }

      if (bothString && ctx.nativeStrings) {
        // SameValue(String x, String y) === string content equality. Use the
        // native `__str_equals` (over flattened native strings) — no host call.
        const eqIdx = ctx.nativeStrHelpers.get("__str_equals");
        const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
        if (eqIdx !== undefined && flattenIdx !== undefined) {
          const xt = compileExpression(ctx, fctx, xArgEarly);
          void xt;
          fctx.body.push({ op: "call", funcIdx: flattenIdx });
          const yt = compileExpression(ctx, fctx, yArgEarly);
          void yt;
          fctx.body.push({ op: "call", funcIdx: flattenIdx });
          fctx.body.push({ op: "call", funcIdx: eqIdx });
          return { kind: "i32" };
        }
      }
    }
    // Helper: compile an argument and coerce to externref preserving JS type
    const compileArgAsExternref = (arg: ts.Expression) => {
      const argTsType = ctx.checker.getTypeAtLocation(arg);
      const wasmType = compileExpression(ctx, fctx, arg);
      if (!wasmType || wasmType.kind === "externref") return;
      if (wasmType.kind === "i32" && isBooleanType(argTsType)) {
        // Boolean i32: box as JS boolean (not number) so Object.is(false, 0) = false
        addUnionImports(ctx);
        const boxIdx = ctx.funcMap.get("__box_boolean");
        if (boxIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: boxIdx });
          return;
        }
      }
      coerceType(ctx, fctx, wasmType, { kind: "externref" });
    };
    const xArg = expr.arguments[0]!;
    const yArg = expr.arguments[1]!;
    compileArgAsExternref(xArg);
    compileArgAsExternref(yArg);
    const isIdx = ensureLateImport(
      ctx,
      "__object_is",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (isIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: isIdx });
      return { kind: "i32" };
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Handle Object.assign(target, ...sources) — shallow copy properties (#965)
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "assign" &&
    expr.arguments.length >= 1
  ) {
    const targetArg = expr.arguments[0]!;
    // (#2076) Object-literal operands must build as native $Objects in
    // standalone so __object_assign's `ref.test $Object` recognises them.
    compileObjectAssignArg(ctx, fctx, targetArg);
    // Build the variadic `...sources` list. Under the native semantic provider
    // the native __object_assign iterates a $ObjVec built by
    // the native $ObjVec builders (__objvec_new / __objvec_push) instead of the
    // host __js_array_new / __js_array_push. Compatibility mode keeps the host
    // imports unchanged (byte-for-byte). Per the #1472 S3 note the __js_array_*
    // builders are NOT globally safe to alias (real JS arrays elsewhere depend
    // on them) — so this is a per-call-site swap.
    let arrNewIdx: number | undefined;
    let arrPushIdx: number | undefined;
    if (ctx.targetProfile.semanticProviders === "native-first") {
      const b = ensureObjVecBuilders(ctx);
      arrNewIdx = b.newIdx;
      arrPushIdx = b.pushIdx;
    } else {
      arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
      arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
    }
    const assignIdx = ensureLateImport(
      ctx,
      "__object_assign",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (assignIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
      const targetLocal = allocLocal(fctx, `__assign_tgt_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: targetLocal });
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      const sourcesLocal = allocLocal(fctx, `__assign_src_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: sourcesLocal });
      for (let i = 1; i < expr.arguments.length; i++) {
        fctx.body.push({ op: "local.get", index: sourcesLocal });
        compileObjectAssignArg(ctx, fctx, expr.arguments[i]!);
        fctx.body.push({ op: "call", funcIdx: arrPushIdx });
      }
      fctx.body.push({ op: "local.get", index: targetLocal });
      fctx.body.push({ op: "local.get", index: sourcesLocal });
      fctx.body.push({ op: "call", funcIdx: assignIdx });
      return { kind: "externref" };
    }
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle Object.fromEntries(iterable) — create object from [key,value] pairs (#965)
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "fromEntries" &&
    expr.arguments.length >= 1
  ) {
    const entriesArg = expr.arguments[0]!;
    // (#2042 S3) In standalone, the native `__object_fromEntries` helper iterates
    // the entries arg + each pair via `__extern_get_idx`, which reliably indexes
    // only a `$ObjVec`. A native ARRAY-LITERAL of pairs (`[["a",1],["b",2]]`) is
    // a typed native vec, not a $ObjVec, and indexing it through the externref
    // boundary mis-casts. So — mirroring `compileObjectAssignArg` for
    // Object.assign — normalise an array-literal-of-pairs into a $ObjVec of pair
    // $ObjVecs HERE (push each element's two slots), then hand the helper the
    // indexable representation. (Map / generic-iterable args keep the old
    // ordinary-externref path; their native iterator-protocol consumption is a
    // larger #2190 follow-up.)
    if (
      ctx.standalone &&
      ts.isArrayLiteralExpression(entriesArg) &&
      entriesArg.elements.length > 0 &&
      entriesArg.elements.every(
        (el) =>
          ts.isArrayLiteralExpression(el) &&
          el.elements.length === 2 &&
          // Gate to STRING-typed keys (string literal, or statically-string).
          // A numeric/boxed key round-trips through __objvec_push/__extern_get_idx
          // and then mis-casts in __to_property_key (illegal cast) — keep that
          // (rare) shape on the ordinary path rather than introduce a new trap.
          (el.elements[0]!.kind === ts.SyntaxKind.StringLiteral ||
            isStringType(ctx.checker.getTypeAtLocation(el.elements[0]!))),
      )
    ) {
      const { newIdx: objVecNewIdx, pushIdx: objVecPushIdx } = ensureObjVecBuilders(ctx);
      const outerVecLocal = allocLocal(fctx, `__fe_entries_${fctx.locals.length}`, { kind: "externref" });
      // outer = __objvec_new()
      fctx.body.push({ op: "call", funcIdx: objVecNewIdx });
      fctx.body.push({ op: "local.set", index: outerVecLocal });
      for (const el of entriesArg.elements) {
        const pair = el as ts.ArrayLiteralExpression;
        const pairVecLocal = allocLocal(fctx, `__fe_pair_${fctx.locals.length}`, { kind: "externref" });
        // pair = __objvec_new()
        fctx.body.push({ op: "call", funcIdx: objVecNewIdx });
        fctx.body.push({ op: "local.set", index: pairVecLocal });
        // __objvec_push(pair, <key>); __objvec_push(pair, <value>)
        for (const slot of pair.elements) {
          fctx.body.push({ op: "local.get", index: pairVecLocal });
          const slotType = compileExpression(ctx, fctx, slot, { kind: "externref" });
          if (slotType && slotType.kind !== "externref") coerceType(ctx, fctx, slotType, { kind: "externref" });
          if (slotType === null) fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "call", funcIdx: objVecPushIdx });
        }
        // __objvec_push(outer, pair)
        fctx.body.push({ op: "local.get", index: outerVecLocal });
        fctx.body.push({ op: "local.get", index: pairVecLocal });
        fctx.body.push({ op: "call", funcIdx: objVecPushIdx });
      }
      fctx.body.push({ op: "local.get", index: outerVecLocal });
      // __object_fromEntries is registered by ensureObjectRuntime (via
      // ensureObjVecBuilders above) but is NOT routed via OBJECT_RUNTIME_HELPER_NAMES
      // (so the ordinary raw-arg path keeps refusing) — resolve it from funcMap.
      const feIdx = ctx.funcMap.get("__object_fromEntries");
      if (feIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: feIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    const argType = compileExpression(ctx, fctx, entriesArg, { kind: "externref" });
    if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
    const funcIdx = ensureLateImport(ctx, "__object_fromEntries", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle Object.getOwnPropertyDescriptors(obj) — all own descriptors (#965)
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "getOwnPropertyDescriptors" &&
    expr.arguments.length >= 1
  ) {
    const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
    if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
    const funcIdx = ensureLateImport(
      ctx,
      "__object_getOwnPropertyDescriptors",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // (#3149) Handle Map.groupBy(items, callback) — ES2024 §24.1.1.2 grouping
  // into a WasmGC-native `$Map` keyed by SameValueZero. Standalone-only; the
  // gc/host lane keeps its `Map.groupBy` host builtin. Mirrors the
  // Object.groupBy arm below (indexable-items gate; raw-GC-closure callback so
  // no `__make_callback` env import leaks) but returns a `ref $Map`.
  if (
    (ctx.standalone || ctx.nativeStrings) &&
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Map" &&
    propAccess.name.text === "groupBy" &&
    expr.arguments.length >= 2
  ) {
    const mgItemsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
    const mgItemsIndexable =
      ts.isArrayLiteralExpression(expr.arguments[0]!) || mgItemsType.getNumberIndexType() !== undefined;
    if (mgItemsIndexable) {
      // `ensureMapGroupBy` resolves `__box_number`/`__extern_length`/
      // `__extern_get_idx` (from the union + object runtime) via `!`-asserted
      // funcMap lookups, and the Map key equality/hash arms
      // (`__same_value_zero`/`__hash_anyref`) only include their number/string
      // comparison when `__unbox_number`/`__typeof_number`/`__typeof_string`/
      // `__str_equals` are registered BEFORE `ensureMapHelpers` runs. Both
      // require the union + native-string helpers up front (a module whose
      // ONLY Map use is `Map.groupBy` has no prior `new Map()` to register
      // them). Ensure them here first — mirrors the new-super.ts `new Map()`
      // order (`addUnionImports` before `ensureMapHelpers`). Omitting them
      // makes ensureMapGroupBy trip an undefined funcIdx → the arm throws and
      // silently falls back to the refusing `__get_builtin` path.
      addUnionImports(ctx);
      ensureNativeStringHelpers(ctx);
      // ensureMapGroupBy sets up the Map runtime types (mapTypeIdx) as a
      // side effect, so it is called BEFORE reading ctx.mapTypeIdx.
      const mapGroupByIdx = ensureMapGroupBy(ctx);
      const itemsTy = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (itemsTy && itemsTy.kind !== "externref") coerceType(ctx, fctx, itemsTy, { kind: "externref" });
      const cbArg = expr.arguments[1]!;
      const cbTy =
        ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
          ? compileArrowAsClosure(ctx, fctx, cbArg)
          : compileExpression(ctx, fctx, cbArg, { kind: "externref" });
      if (cbTy && cbTy.kind !== "externref") coerceType(ctx, fctx, cbTy, { kind: "externref" });
      fctx.body.push({ op: "call", funcIdx: mapGroupByIdx });
      return { kind: "ref", typeIdx: ctx.mapTypeIdx };
    }
    // Non-indexable (generic iterable) items → fall through to the refusing
    // host path (#2864 iterator-carrier follow-up), not a silent empty Map.
  }

  // Handle Object.groupBy(iterable, keyFn) — ES2024 grouping (#965)
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Object" &&
    propAccess.name.text === "groupBy" &&
    expr.arguments.length >= 2
  ) {
    // (#2863 Phase 3) Standalone has no host `__object_groupBy`; register the
    // native helper (array / array-like receiver) instead of refusing. The
    // helper needs the closure bridge, so register it BEFORE lowering the args
    // (append-only; no funcidx shift of this in-flight function). Generic
    // iterables (Map/Set/user iterators) are the #2864 iterator-carrier
    // follow-up and still fall through to the refusing host import below.
    // Only take the native array/array-like path when the items arg is
    // indexable (real Array, tuple, `any`, or an array-like with a numeric
    // index signature). Map/Set/generic iterables have no numeric index →
    // `__extern_length`/`__extern_get_idx` can't iterate them; keep refusing
    // loudly there (the #2864 iterator carrier is the follow-up) rather than
    // silently returning an empty grouping.
    const gbItemsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
    const gbItemsIndexable =
      ts.isArrayLiteralExpression(expr.arguments[0]!) || gbItemsType.getNumberIndexType() !== undefined;
    if (ctx.standalone && gbItemsIndexable) {
      const groupByIdx = ensureObjectGroupBy(ctx);
      const iterTypeS = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (iterTypeS && iterTypeS.kind !== "externref") coerceType(ctx, fctx, iterTypeS, { kind: "externref" });
      // Compile the callback as a raw GC closure (call_ref via __apply_closure),
      // NOT a host callback — `compileExpression` on an arrow that flows to a
      // host import would insert `__make_callback`, leaking an env import into
      // the standalone module (#2863). Mirrors the array-method callback path.
      const cbArg = expr.arguments[1]!;
      const fnTypeS =
        ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
          ? compileArrowAsClosure(ctx, fctx, cbArg)
          : compileExpression(ctx, fctx, cbArg, { kind: "externref" });
      if (fnTypeS && fnTypeS.kind !== "externref") coerceType(ctx, fctx, fnTypeS, { kind: "externref" });
      fctx.body.push({ op: "call", funcIdx: groupByIdx });
      return { kind: "externref" };
    }
    const iterType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
    if (iterType && iterType.kind !== "externref") coerceType(ctx, fctx, iterType, { kind: "externref" });
    const fnType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
    if (fnType && fnType.kind !== "externref") coerceType(ctx, fctx, fnType, { kind: "externref" });
    const funcIdx = ensureLateImport(
      ctx,
      "__object_groupBy",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Standalone and native-first use the Wasm-owned Proxy/revoker carriers.
  // Compatibility mode keeps the existing real-JS Proxy.revocable provider.
  if (
    (ctx.standalone || ctx.targetProfile.semanticProviders === "native-first") &&
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Proxy" &&
    propAccess.name.text === "revocable"
  ) {
    ensureNativeProxyRuntime(ctx);
    const compileProxyInput = (arg: ts.Expression | undefined): void => {
      if (arg === undefined) {
        fctx.body.push({ op: "ref.null.extern" });
        return;
      }
      const result = ts.isObjectLiteralExpression(arg)
        ? compileObjectLiteralAsExternref(ctx, fctx, arg)
        : ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
          ? compileArrowAsClosure(ctx, fctx, arg)
          : compileExpression(ctx, fctx, arg);
      if (result === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (result.kind !== "externref") {
        coerceType(ctx, fctx, result, { kind: "externref" });
      }
    };
    compileProxyInput(expr.arguments[0]);
    compileProxyInput(expr.arguments[1]);
    const nativeRevocableIdx = ctx.funcMap.get("__proxy_revocable");
    if (nativeRevocableIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: nativeRevocableIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle Proxy.revocable(target, handler) — creates revocable Proxy (#965)
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "Proxy" &&
    propAccess.name.text === "revocable" &&
    expr.arguments.length >= 2
  ) {
    const tgtType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
    if (tgtType && tgtType.kind !== "externref") coerceType(ctx, fctx, tgtType, { kind: "externref" });
    const hndType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
    if (hndType && hndType.kind !== "externref") coerceType(ctx, fctx, hndType, { kind: "externref" });
    const funcIdx = ensureLateImport(
      ctx,
      "__proxy_revocable",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  return undefined;
}

/**
 * (#3541) `String.fromCharCode` / `String.fromCodePoint` invoked REFLECTIVELY —
 * `.call(thisArg, …codes)` or `.apply(thisArg, codesArray)` — on the native
 * string lanes (`ctx.nativeStrings`, standalone/WASI).
 *
 * Why this exists: the generic reflective path wraps the builtin static in a
 * closure and routes through the runtime apply machinery, which cannot spread
 * a native `$vec` argv into the builtin's variadic lowering — the result is a
 * null string and the first consumer null-derefs in `__str_concat`. That is
 * the SOLE remaining gate on the 311 `built-ins/RegExp/property-escapes`
 * baseline rows (every one runs `regExpUtils.js`'s `buildString`, whose two
 * `String.fromCodePoint.apply(null, <array>)` calls die here). See
 * plan/issues/3541-standalone-fromcodepoint-apply-vec-null.md.
 *
 * Lowering:
 *   - `.call(thisArg, a, b)`  → direct `String.fromX(a, b)` (§22.1.2.* never
 *     reads `this`); thisArg is evaluated first for argument order.
 *   - `.apply(thisArg)`       → `""` (empty code-unit list).
 *   - `.apply(thisArg, arr)`  → runtime fold over the native vec: per element
 *     load → ToUint16 (`fromCharCode`) or the §22.1.2.2 integral/[0,0x10FFFF]
 *     RangeError guard (`fromCodePoint`) → the 1-char native helper → shared
 *     `emitStringJoinFold` concat (sep "", `""` for the empty/null array).
 *
 * Precision gates (fall through to the legacy path, `undefined`):
 *   - host lane (js-string) — untouched, it has a working host `.apply`;
 *   - thisArg / argsArray not re-eval-safe (identifier, literal, null, …) —
 *     bailing after compilation would double side effects on the legacy
 *     recompile;
 *   - argsArray does not compile to a native `$vec` of f64/i32/i8/i16/externref
 *     elements (the compiled value is dropped; the gate above makes that safe).
 */
export function tryCompileFromCharCodeFamilyReflective(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  innerExpr: ts.Expression,
  isCall: boolean,
): InnerResult | undefined {
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return undefined;
  let target: ts.Expression = innerExpr;
  while (ts.isParenthesizedExpression(target) || ts.isAsExpression(target) || ts.isNonNullExpression(target)) {
    target = target.expression;
  }
  if (!ts.isPropertyAccessExpression(target)) return undefined;
  if (!ts.isIdentifier(target.expression) || target.expression.text !== "String") return undefined;
  const mName = target.name.text;
  if (mName !== "fromCharCode" && mName !== "fromCodePoint") return undefined;
  const isFromCodePoint = mName === "fromCodePoint";
  ensureNativeStringHelpers(ctx);
  const repr = nativeStringRepr(ctx);
  const helperIdx = ctx.nativeStrHelpers.get(isFromCodePoint ? "__str_fromCodePoint" : "__str_fromCharCode");
  if (repr === undefined || helperIdx === undefined) return undefined;

  const dropCompiled = (t: ValType | null): void => {
    if (t !== null) fctx.body.push({ op: "drop" });
  };

  // `.call(thisArg, …codes)` → direct family call (reuses the #2088 fold and
  // the #2601/#2875 per-argument coercion + guards wholesale).
  if (isCall) {
    if (expr.arguments.length > 0) dropCompiled(compileExpression(ctx, fctx, expr.arguments[0]!));
    const synthetic = ts.factory.createCallExpression(
      target as ts.LeftHandSideExpression,
      undefined,
      expr.arguments.slice(1),
    );
    ts.setTextRange(synthetic, expr);
    (synthetic as { parent?: ts.Node }).parent = expr.parent;
    return compileExpression(ctx, fctx, synthetic);
  }

  // `.apply()` / `.apply(thisArg)` — §: argArray absent → empty list → "".
  if (expr.arguments.length < 2) {
    if (expr.arguments.length === 1) dropCompiled(compileExpression(ctx, fctx, expr.arguments[0]!));
    fctx.body.push(...repr.literal(""));
    return repr.resultType;
  }

  const thisArg = expr.arguments[0]!;
  let argsVal: ts.Expression = expr.arguments[1]!;
  while (ts.isParenthesizedExpression(argsVal) || ts.isAsExpression(argsVal) || ts.isNonNullExpression(argsVal)) {
    argsVal = argsVal.expression;
  }
  const reEvalSafe = (e: ts.Expression): boolean =>
    ts.isIdentifier(e) ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isNumericLiteral(e) ||
    ts.isStringLiteralLike(e);
  // The argsArray additionally admits `obj.prop` (single member access on an
  // identifier — the `buildString(args){ …apply(null, args.pts) }` shape) and
  // array literals. The bail-after-compile path only re-evaluates when the
  // compiled type is NOT a supported vec; a getter-bearing read of that shape
  // is already broken on the legacy path today, so the residual double-eval
  // exposure is strictly smaller than the bug this replaces.
  const argsReEvalSafe =
    reEvalSafe(argsVal) ||
    ts.isArrayLiteralExpression(argsVal) ||
    (ts.isPropertyAccessExpression(argsVal) && ts.isIdentifier(argsVal.expression));
  if (!reEvalSafe(thisArg) || !argsReEvalSafe) {
    return undefined;
  }

  dropCompiled(compileExpression(ctx, fctx, thisArg));

  const argType = compileExpression(ctx, fctx, argsVal);
  if (argType === null) return null;

  const vecElemSupported = (k: string): boolean =>
    k === "f64" || k === "i32" || k === "i8" || k === "i16" || k === "externref";

  /**
   * Emit the destructure + join fold for ONE concrete vec type. Precondition:
   * a `(ref null vecTypeIdx)` value is on the stack. Leaves one
   * `repr.resultType` value. A null argArray spreads as the empty list
   * (len stays 0 → "").
   */
  const emitVecSpreadFold = (vecTypeIdx: number, arrTypeIdx: number, elemType: ValType): void => {
    const vecTmp = allocLocal(fctx, `__fccapply_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
    const dataTmp = allocLocal(fctx, `__fccapply_data_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    });
    const foldLocals = allocJoinFoldLocals(fctx, repr, "fccapply");
    fctx.body.push({ op: "local.set", index: vecTmp });
    fctx.body.push({ op: "local.get", index: vecTmp });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: foldLocals.lenTmp },
      ],
      else: [
        { op: "local.get", index: vecTmp },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: foldLocals.lenTmp },
        { op: "local.get", index: vecTmp },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.set", index: dataTmp },
      ],
    });
    fctx.body.push(...repr.literal(""));
    fctx.body.push({ op: "local.set", index: foldLocals.resultTmp });
    fctx.body.push(...repr.literal(""));
    fctx.body.push({ op: "local.set", index: foldLocals.sepTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: foldLocals.iTmp });

    // elem → 1-char string. Built via a body swap so emitThrowRangeError (a
    // late-import-bearing emitter) targets the buffer; registered with
    // ctx.liveBodies so a later late-import shift still fixes baked indices
    // (the #2088 family pattern), and de-registered after the splice.
    const elemBuf: Instr[] = [];
    ctx.liveBodies.add(elemBuf);
    const savedBody = fctx.body;
    fctx.body = elemBuf;
    try {
      const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
      elemBuf.push({ op: "local.get", index: dataTmp });
      elemBuf.push({ op: "local.get", index: foldLocals.iTmp });
      elemBuf.push({ op: getOp, typeIdx: arrTypeIdx } as Instr);
      if (elemType.kind === "externref") {
        // Boxed-any element → numeric code via the shared coercion engine
        // (unboxes `__box_number` payloads; undefined → NaN).
        coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
      }
      const elemIsF64 = elemType.kind === "f64" || elemType.kind === "externref";
      if (isFromCodePoint) {
        if (elemIsF64) {
          // §22.1.2.2 2b/2c — non-integral (incl. NaN) or out-of-[0,0x10FFFF]
          // code points throw RangeError (mirrors the direct-call family arm).
          const cpTmp = allocTempLocal(fctx, { kind: "f64" });
          elemBuf.push({ op: "local.tee", index: cpTmp });
          elemBuf.push({ op: "local.get", index: cpTmp });
          elemBuf.push({ op: "f64.trunc" });
          elemBuf.push({ op: "f64.ne" });
          elemBuf.push({ op: "local.get", index: cpTmp });
          elemBuf.push({ op: "f64.const", value: 0 });
          elemBuf.push({ op: "f64.lt" });
          elemBuf.push({ op: "local.get", index: cpTmp });
          elemBuf.push({ op: "f64.const", value: 0x10ffff });
          elemBuf.push({ op: "f64.gt" });
          elemBuf.push({ op: "i32.or" });
          elemBuf.push({ op: "i32.or" });
          const throwBuf: Instr[] = [];
          fctx.body = throwBuf;
          emitThrowRangeError(ctx, fctx, "RangeError: Invalid code point");
          fctx.body = elemBuf;
          elemBuf.push({ op: "if", blockType: { kind: "empty" }, then: throwBuf });
          elemBuf.push({ op: "local.get", index: cpTmp });
          elemBuf.push({ op: "i32.trunc_sat_f64_s" });
          releaseTempLocal(fctx, cpTmp);
        } else {
          // Integral by construction; range-check in the i32 domain.
          const cpTmp = allocTempLocal(fctx, { kind: "i32" });
          elemBuf.push({ op: "local.tee", index: cpTmp });
          elemBuf.push({ op: "i32.const", value: 0 });
          elemBuf.push({ op: "i32.lt_s" });
          elemBuf.push({ op: "local.get", index: cpTmp });
          elemBuf.push({ op: "i32.const", value: 0x10ffff });
          elemBuf.push({ op: "i32.gt_s" });
          elemBuf.push({ op: "i32.or" });
          const throwBuf: Instr[] = [];
          fctx.body = throwBuf;
          emitThrowRangeError(ctx, fctx, "RangeError: Invalid code point");
          fctx.body = elemBuf;
          elemBuf.push({ op: "if", blockType: { kind: "empty" }, then: throwBuf });
          elemBuf.push({ op: "local.get", index: cpTmp });
          releaseTempLocal(fctx, cpTmp);
        }
      } else if (elemIsF64) {
        // fromCharCode: §7.1.8 ToUint16 in the f64 domain BEFORE the i32
        // conversion (the #2875 slice-5 pattern — NaN/±Inf → 0, |x| ≥ 2^31
        // keeps its true modulo; a bare trunc_sat saturates first and gets
        // both wrong).
        const u16Tmp = allocTempLocal(fctx, { kind: "f64" });
        elemBuf.push({ op: "f64.trunc" });
        elemBuf.push({ op: "local.tee", index: u16Tmp });
        elemBuf.push({ op: "local.get", index: u16Tmp });
        elemBuf.push({ op: "f64.const", value: 65536 });
        elemBuf.push({ op: "f64.div" });
        elemBuf.push({ op: "f64.floor" });
        elemBuf.push({ op: "f64.const", value: 65536 });
        elemBuf.push({ op: "f64.mul" });
        elemBuf.push({ op: "f64.sub" });
        elemBuf.push({ op: "i32.trunc_sat_f64_s" });
        releaseTempLocal(fctx, u16Tmp);
      }
      // i32/i8/i16 fromCharCode: the helper's low-16 mask IS ToUint16.
      elemBuf.push({ op: "call", funcIdx: helperIdx });
    } finally {
      fctx.body = savedBody;
    }

    // (#3224-style) Bounds-check against the physical backing: a grown/sparse
    // array's logical length can exceed it; an absent index spreads as
    // `undefined` — RangeError for fromCodePoint (NaN is not integral),
    // code 0 for fromCharCode.
    const oobBuf: Instr[] = [];
    if (isFromCodePoint) {
      ctx.liveBodies.add(oobBuf);
      fctx.body = oobBuf;
      try {
        emitThrowRangeError(ctx, fctx, "RangeError: Invalid code point");
      } finally {
        fctx.body = savedBody;
      }
      oobBuf.push(...repr.literal(""));
    } else {
      oobBuf.push({ op: "i32.const", value: 0 });
      oobBuf.push({ op: "call", funcIdx: helperIdx });
    }
    const boundsCheckedElem: Instr[] = [
      { op: "local.get", index: dataTmp },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: repr.resultType },
        then: [...oobBuf],
        else: [
          { op: "local.get", index: foldLocals.iTmp },
          { op: "local.get", index: dataTmp },
          { op: "array.len" },
          { op: "i32.lt_s" },
          {
            op: "if",
            blockType: { kind: "val", type: repr.resultType },
            then: elemBuf,
            else: [...oobBuf],
          },
        ],
      },
    ];

    emitStringJoinFold(ctx, fctx, repr, foldLocals, boundsCheckedElem);
    ctx.liveBodies.delete(elemBuf);
    ctx.liveBodies.delete(oobBuf);
    fctx.body.push({ op: "local.get", index: foldLocals.resultTmp });
  };

  // Statically-typed native vec argument: fold it directly.
  if (argType.kind === "ref" || argType.kind === "ref_null") {
    const vecTypeIdx = argType.typeIdx;
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) {
      fctx.body.push({ op: "drop" });
      return undefined;
    }
    const elemType = (ctx.mod.types[arrTypeIdx] as { kind: "array"; element: ValType }).element;
    if (!vecElemSupported(elemType.kind)) {
      fctx.body.push({ op: "drop" });
      return undefined;
    }
    emitVecSpreadFold(vecTypeIdx, arrTypeIdx, elemType);
    return repr.resultType;
  }

  // EXTERNREF argument — the shape inside a struct-narrowed callee (#3536):
  // `const lone = args.loneCodePoints` reads through the dynamic member path,
  // so the local carries the vec WRAPPED as externref. Unwrap and dispatch on
  // the two vec representations a JS `number[]` can take here ($vec_f64 for
  // typed literals, $vec_externref for boxed/grown arrays); anything else is
  // not array-like spreadable — §Function.prototype.apply step 4 TypeError.
  if (argType.kind === "externref") {
    const vecF64Idx = getOrRegisterVecType(ctx, "f64", { kind: "f64" });
    const arrF64Idx = getArrTypeIdxFromVec(ctx, vecF64Idx);
    const vecExtIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
    const arrExtIdx = getArrTypeIdxFromVec(ctx, vecExtIdx);
    if (arrF64Idx < 0 || arrExtIdx < 0) {
      fctx.body.push({ op: "drop" });
      return undefined;
    }
    const anyTmp = allocLocal(fctx, `__fccapply_any_${fctx.locals.length}`, { kind: "anyref" });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "local.set", index: anyTmp });

    const savedBody = fctx.body;
    const buildArm = (vecIdx: number, arrIdx: number, elemType: ValType): Instr[] => {
      const buf: Instr[] = [];
      ctx.liveBodies.add(buf);
      fctx.body = buf;
      try {
        buf.push({ op: "local.get", index: anyTmp });
        buf.push({ op: "ref.cast_null", typeIdx: vecIdx });
        emitVecSpreadFold(vecIdx, arrIdx, elemType);
      } finally {
        fctx.body = savedBody;
      }
      ctx.liveBodies.delete(buf);
      return buf;
    };
    const f64Arm = buildArm(vecF64Idx, arrF64Idx, { kind: "f64" });
    const extArm = buildArm(vecExtIdx, arrExtIdx, { kind: "externref" });
    const throwArm: Instr[] = [];
    ctx.liveBodies.add(throwArm);
    fctx.body = throwArm;
    try {
      // Also covers null/undefined argArray: §Function.prototype.apply treats
      // those as the empty list — test nullish BEFORE the TypeError.
      throwArm.push({ op: "local.get", index: anyTmp });
      throwArm.push({ op: "ref.is_null" });
      const emptyArm: Instr[] = [...repr.literal("")];
      const teBuf: Instr[] = [];
      fctx.body = teBuf;
      emitThrowTypeError(ctx, fctx, "TypeError: CreateListFromArrayLike called on non-object");
      fctx.body = throwArm;
      teBuf.push(...repr.literal("")); // unreachable filler after throw; keeps the arm typed
      throwArm.push({
        op: "if",
        blockType: { kind: "val", type: repr.resultType },
        then: emptyArm,
        else: teBuf,
      });
    } finally {
      fctx.body = savedBody;
    }
    ctx.liveBodies.delete(throwArm);

    fctx.body.push({ op: "local.get", index: anyTmp });
    fctx.body.push({ op: "ref.test", typeIdx: vecF64Idx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: repr.resultType },
      then: f64Arm,
      else: [
        { op: "local.get", index: anyTmp },
        { op: "ref.test", typeIdx: vecExtIdx },
        {
          op: "if",
          blockType: { kind: "val", type: repr.resultType },
          then: extArm,
          else: throwArm,
        },
      ],
    });
    return repr.resultType;
  }

  fctx.body.push({ op: "drop" });
  return undefined; // re-eval-safe by the gate above
}
