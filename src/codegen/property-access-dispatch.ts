// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Property-access dispatch helpers (#3276, Wave B decomposition of #3182).
 *
 * `compilePropertyAccess` in property-access.ts is a ~3.3k-LOC function that
 * dispatches on access kind / receiver family through a long sequence of
 * independent early-return guard bands. This module hosts the extracted,
 * cohesively-named guard bands. Each helper contains a VERBATIM run of the
 * original inline guard blocks and returns {@link PA_FALLTHROUGH} where the
 * original fell through (guard false / inner attempt produced nothing); every
 * original `return X` inside a band is preserved unchanged.
 *
 * Byte-identity: the moved statements execute in the same order with the same
 * ctx/fctx mutations, so the emitted Wasm is unchanged (proved with
 * scripts/prove-emit-identity.mjs — 39/39 gc/standalone/wasi IDENTICAL).
 *
 * Call-site contract in compilePropertyAccess:
 *
 *   {
 *     const __r = tryFooBar(ctx, fctx, expr, propName, objType);
 *     if (__r !== PA_FALLTHROUGH) return __r;
 *   }
 */

import { ts } from "../ts-api.js";
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  isExternalDeclaredClass,
  isIteratorResultType,
  isStringType,
  isStringWrapperType,
} from "../checker/type-mapper.js";
import { commonScalarFieldType, ensureScalarUnbox, symbolBrand } from "./symbol-field-carrier.js";
import { emitDynGet, widenBooleanDynamicAccess } from "./dyn-read.js";
import { expectedArgumentCountOfSignature } from "./function-expected-argument-count.js"; // (#4436) §15.1.5
import { functionPrototypeMemberSpecLength } from "./function-prototype-callable.js"; // (§20.2.3)
import { emitSymbolDescLoad, ensureNativeSymbolBoundaryBridge, usesNativeSymbolProvider } from "./symbol-native.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { rollbackSpeculative, snapshotSpeculative } from "./context/speculative.js";
import {
  tryCompileNativeGeneratorResultProperty,
  isNativeGeneratorResultStruct,
  sentinelAwareF64BoxInstrs,
} from "./generators-native.js";
import {
  classAccessorCandidatesForProp,
  classMethodCandidatesForProp,
  reserveMemberGetDispatch,
} from "./member-get-dispatch.js";
import { coercionInstrs, defaultValueInstrs } from "./type-coercion.js";
import { patchStructNewForAddedField } from "./expressions/late-imports.js";
import { reserveAccessorGetDriver } from "./accessor-driver.js";
import { S5C_STRUCT_ACCESSOR_CLOSURE } from "./struct-accessor-closure.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import {
  classifyPrivateMember,
  emitPrivateBrandPredicate,
  emitThrowTypeError,
  noJsHost,
  resolveDeclaringClassForPrivateName,
} from "./expressions/helpers.js";
import { popBody, pushBody } from "./context/bodies.js";
import { classMemberFuncKey, resolveMethodOwnerClass } from "./class-member-keys.js";
import { exactClassExpressionTypeName } from "./class-expression-identity.js";
import { definedFuncAt } from "./func-space.js";
import { emitCachedMethodClosureAccess, emitFuncRefAsClosure, getFuncRefWrapperRootTypeIdx } from "./closures.js";
import { emitLazyClassObjectGet, emitLazyProtoGet } from "./expressions/extern.js";
import { emitLazyNativeProtoGet } from "./native-proto.js";
import { buildCaughtErrorPropFallback } from "./caught-error-prop-fallback.js"; // (#4394) catch-binding non-$Error read
import { addStringConstantGlobal, localGlobalIdx } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import {
  emitBuiltinConstructorIdentity,
  emitBuiltinNamespaceObject,
  isBuiltinConstructorIdentityName,
} from "./builtin-static-globals.js";
import { tryEmitPrimitiveStringConstructorRead } from "./string-primitive-constructor.js"; // (#2875 w4-F)
import { tryCompileNativeDisposableStackAnyDisposedGet } from "./disposable-runtime.js";
import { tryEmitFnctorPrototypeRead } from "./expressions/fnctor-prototype.js";
import { tryEmitDerivedLengthLocal } from "./derived-split-scalar.js";
import {
  tryCompileStandaloneRegExpMatchResultRead,
  tryCompileStandaloneRegExpPropertyRead,
} from "./regexp-standalone.js";
import {
  emitGeneratorPrototypeSingleton,
  emitNativeGlobalThisObject,
  emitTypedArrayIntrinsicCtorObject,
  ensureTypedArrayViewNativeProtoGlue,
} from "./array-object-proto.js";
import {
  dvDetachedThrowInstrs,
  emitTaCtorBytesPerElement,
  emitTaCtorValue,
  emitTaViewAccessor,
  emitTaViewDynamicByteLength,
  getOrRegisterDvWindowType,
  pushTaViewEffectiveLen,
  usesNativeDataViewProvider,
} from "./dataview-native.js";
import { staticConstStringValues } from "./analysis/static-string-values.js";
import { staticUniformDerivedLength, tryEmitNativeTrimLength } from "./native-strings-derived-length.js";
import {
  addUnionImports,
  resolveWasmType,
  TYPED_ARRAY_NAMES,
  typedArrayVecStorage,
  undefinedTypedMemberReadProducesExternref,
} from "./index.js";
import {
  getArrTypeIdxFromVec,
  getOrRegisterResizableAbType,
  getOrRegisterTaCtorType,
  getOrRegisterVecType,
  isTaViewTypeIdx,
  TA_CTOR_KINDS,
  taCtorKindOf,
} from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStringLiteral,
  compileSuperPropertyAccess,
  ensureLateImport,
  flushLateImportShifts,
  skipTransparentExpressions,
} from "./shared.js";
import { tryEmitJsonParsePropertyAccess } from "./json-standalone.js";
import { resolveReceiverStruct } from "./fnctor-escape-gate.js";
import { foreignReturnFunctionNames, typeIsForeignReturnFnctorInstance } from "./fnctor-foreign-return.js"; // (#2071)
import { findColdStructsForField } from "./fnctor-cold-tail.js"; // (#3927) hot/cold fnctor split
import { findFnctorLayoutStructsForField, findFnctorResidStructsForField } from "./fnctor-layout-emit.js"; // (#3927) per-type layouts — vote seam
import { tryCompileTemporalPropertyAccess } from "./temporal-native.js";
import { emitReceiverNullGuard } from "./nonnull-proof.js"; // (#4157) provably-dead null guards
import {
  BUILTIN_CTOR_ARITY,
  BUILTIN_CTOR_NAMES,
  ensureStandaloneBuiltinStaticMethodClosure,
  getWellKnownSymbolId,
  hasNativeBuiltinConstantHandler,
  reportUnsupportedStandaloneBuiltinValueRead,
  TYPED_ARRAY_BYTES_PER_ELEMENT,
  tryCompileStandaloneBuiltinProtoMemberMeta,
  tryCompileStandaloneBuiltinProtoMemberRead,
  tryEnsureNativeProtoBrand,
} from "./builtin-value-read.js";
import { tryEmitInstanceBuiltinProtoMethodValue } from "./instance-proto-method-identity.js"; // (#4481)
import { isBuiltinSubtype, isBuiltinTypeName } from "./builtin-tags.js";
import { receiverIsPrimitiveWrapper } from "./object-ctor-primitive-receiver.js";
import { getOrRegisterErrorStructType, isWasiErrorName } from "./registry/error-types.js";
import {
  classExpressionDefinesOwnName,
  classifyPlainCtorReceiverNamespace,
  compileExternPropertyGet,
  emitExternrefBackedOwnFieldRead,
  emitExternrefToStructGet,
  emitGetterCallWithDummy,
  emitGuardedNativeStringLength,
  emitNullGuardedStructGet,
  emitRuntimeDescriptorGet,
  emitThisReceiverGuardConvert,
  findAlternateStructsForField,
  getIteratorResultValueType,
  isAnonymousFunctionDefinition,
  isBindResultExpr,
  isGeneratorIteratorResultLike,
  isGetProtoOfWiredViewProtoCall,
  isProvablyNonNull,
  moduleTouchesConstructorProp,
  receiverIsCatchClauseBinding,
  receiverIsNativeStringValType,
  resolveInheritedStaticProp,
  resolveLogicalAssignmentName,
  resolveStructNameForExpr,
  runtimeAccessorDescriptorKey,
  taViewReceiverTypeIdx,
  thisReceiverGuardTargets,
  tryEmitConstructorViaTag,
  tryEmitDeleteAwareDynamicGet,
  tryEmitPinnedStructMemberGet,
  typeErrorThrowInstrs,
} from "./property-access.js";
import { tryEmitExactStructFieldGet, tryEmitStructuralContractReadFromLocal } from "./property-access-exact-shapes.js";
import { tryEmitProvenReceiverFieldGet, tryEmitTypedThisFieldGet } from "./typed-this.js"; // (#3683 S2 / #3685 S2) inline field reads
import { tryEmitFnctorTypedFieldGet } from "./fnctor-typed-reads.js"; // (#4155 Phase 2) struct-typed fnctor receiver
import {
  emitStandaloneFunctionIntrinsicValue,
  tryEmitFunctionValueConstructorRead,
} from "./function-intrinsic-carrier.js"; // (#4442) `<fn>.constructor`; (#4484) `<Builtin>.constructor`
import { emitRuntimeEvalSharedValueUnwrap, runtimeEvalSharedValueUnwrapInstrs } from "./global-environment.js";

/**
 * Sentinel returned by every dispatch helper to mean "this guard band did not
 * handle the access — keep going". `compilePropertyAccess` returns
 * `ValType | null`, and `null` is itself a legitimate handled result, so it
 * cannot double as the not-handled marker; a unique symbol can.
 */
export const PA_FALLTHROUGH: unique symbol = Symbol("property-access:fallthrough");
export type PADispatchResult = ValType | null | typeof PA_FALLTHROUGH;

export function tryDynamicReceiverRuntimeDispatchReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // (#3054 D) `ctor.BYTES_PER_ELEMENT` where `ctor` is a first-class `$__ta_ctor`
  // value (the kind is only known at runtime — `for (c of ctors) … c.BYTES_PER_ELEMENT`,
  // `CreateRabForTest(ctor)`'s `4 * ctor.BYTES_PER_ELEMENT`). Placed at the TOP so
  // it wins over the generic dynamic-member dispatchers below (which return
  // `undefined`/0 for a `$__ta_ctor` receiver — a param/loop-var typed `any`).
  // Byte-inert: only when a `$__ta_ctor` type already exists in the module (it is
  // registered when a TA name is used as a value, e.g. the `ctors` array). Excludes
  // the static `Uint8Array.BYTES_PER_ELEMENT` NAME form (kept on its dedicated path)
  // and native TypedArray/DataView/ArrayBuffer INSTANCES (their own instance arm).
  if (
    propName === "BYTES_PER_ELEMENT" &&
    noJsHost(ctx) &&
    !(ts.isIdentifier(expr.expression) && taCtorKindOf(expr.expression.text) >= 0)
  ) {
    const recvSym = objType.getSymbol()?.name;
    const isNativeInstance =
      recvSym !== undefined &&
      (taCtorKindOf(recvSym) >= 0 || recvSym === "DataView" || recvSym === "ArrayBuffer" || recvSym === "TypedArray");
    // A `$__ta_ctor` value only ever flows through an `any`/`unknown`/union-typed
    // receiver (a concrete TA / native instance never holds one). Gate on that so
    // non-dynamic reads stay byte-inert, and register the ctor type on demand (the
    // read may compile before the value that would register it).
    const isDynamicReceiver =
      (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || objType.isUnion() || ctx.taCtorTypeIdx >= 0;
    if (!isNativeInstance && isDynamicReceiver) {
      const r = emitTaCtorBytesPerElement(ctx, fctx, () => compileExpression(ctx, fctx, expr.expression));
      if (r) return r;
    }
  }

  // (#3054 D) `.byteLength` on a boxed `$__ta_view` read back through an `any`/union
  // receiver (a dynamically-constructed view stored in an `any[]`, e.g.
  // length-tracking-N's `for (ta of tas) … ta.byteLength`). The compile-time-typeIdx
  // `$__ta_view` accessor arm can't fire (the local is externref), and the generic
  // dynamic reader THROWS on `.byteLength`. Runtime `ref.test` dispatch instead.
  // Gated to a dynamic receiver + at least one registered `$__ta_view` type
  // (byte-inert otherwise); a static ArrayBuffer/DataView/TA `.byteLength` keeps its
  // own concrete arm below (its receiver type is not `any`/union).
  if (propName === "byteLength" && noJsHost(ctx) && ctx.taDynViewTypeIdx >= 0) {
    const isDynamicReceiver = (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || objType.isUnion();
    if (isDynamicReceiver) {
      const r = emitTaViewDynamicByteLength(ctx, fctx, () => compileExpression(ctx, fctx, expr.expression));
      if (r) return r;
    }
  }

  // (#3237 Slice 1) `.disposed` on a DYNAMIC (`any`/`unknown`/union) receiver
  // carrying a native `$DisposableStack` (the runner hoists a captured
  // `var stack = new DisposableStack()` to `let stack: any`). The className arm
  // below can't fire (no nominal symbol), so it fell to the generic dynamic
  // reader — a `__extern_get` miss on the non-`$Object` native struct → always
  // false, silently wrong after `dispose()`. Runtime `ref.test $DisposableStack`
  // dispatch: match → the struct's disposed flag; miss → the generic read (a user
  // object's own `.disposed` still resolves). Byte-inert unless a
  // `DisposableStack` extern class is registered; `nativeStrings`-gated.
  if (propName === "disposed" && ctx.nativeStrings && ctx.externClasses.has("DisposableStack")) {
    const isDynamicReceiver = (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || objType.isUnion();
    if (isDynamicReceiver) {
      const r = tryCompileNativeDisposableStackAnyDisposedGet(ctx, fctx, expr.expression);
      if (r !== undefined) return r as ValType;
    }
  }
  return PA_FALLTHROUGH;
}

export function tryConstructorPrototypeIdentity(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // #3371: the original Test262 realm shim deliberately aliases
  // `$262.createRealm().global` to the current native global. Therefore
  // `other[TA.name]` is the same first-class `$__ta_ctor` value as `TA`, and
  // `.prototype` must select the corresponding per-kind native singleton.
  // Resolve this compound expression directly; the generic `$Object` global
  // map does not pre-populate every builtin constructor name.
  if (
    noJsHost(ctx) &&
    propName === "prototype" &&
    ts.isElementAccessExpression(expr.expression) &&
    ts.isPropertyAccessExpression(expr.expression.argumentExpression) &&
    expr.expression.argumentExpression.name.text === "name"
  ) {
    const realmExpr = expr.expression.expression;
    let isRealmGlobal = ts.isIdentifier(realmExpr) && realmExpr.text === "globalThis";
    if (!isRealmGlobal && ts.isIdentifier(realmExpr)) {
      const realmSymbol = ctx.checker.getSymbolAtLocation(realmExpr);
      const declaration =
        realmSymbol?.valueDeclaration ??
        realmSymbol?.declarations?.find((candidate) => ts.isVariableDeclaration(candidate));
      const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      const init = initializer ? skipTransparentExpressions(initializer) : undefined;
      isRealmGlobal =
        init !== undefined &&
        ts.isPropertyAccessExpression(init) &&
        init.name.text === "global" &&
        ts.isCallExpression(init.expression) &&
        ts.isPropertyAccessExpression(init.expression.expression) &&
        init.expression.expression.name.text === "createRealm";
    }
    if (isRealmGlobal) {
      const ctorExpr = expr.expression.argumentExpression.expression;
      getOrRegisterTaCtorType(ctx);
      const ctorType = compileExpression(ctx, fctx, ctorExpr, { kind: "externref" });
      if (ctorType && ctorType.kind !== "externref") coerceType(ctx, fctx, ctorType, { kind: "externref" });
      else if (ctorType === null) fctx.body.push({ op: "ref.null.extern" });
      if (ctx.taCtorTypeIdx >= 0) {
        const anyLocal = allocLocal(fctx, `__realm_tac_any_${fctx.locals.length}`, { kind: "anyref" });
        const kindLocal = allocLocal(fctx, `__realm_tac_kind_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "local.set", index: anyLocal });
        let chain: Instr[] = [{ op: "ref.null.extern" }];
        for (let kind = TA_CTOR_KINDS.length - 1; kind >= 0; kind--) {
          const brand = ensureTypedArrayViewNativeProtoGlue(ctx, TA_CTOR_KINDS[kind]!);
          if (brand === undefined) continue;
          const then: Instr[] = [];
          const saved = fctx.body;
          fctx.body = then;
          const emitted = emitLazyNativeProtoGet(ctx, fctx, brand);
          fctx.body = saved;
          if (!emitted) continue;
          chain = [
            { op: "local.get", index: kindLocal },
            { op: "i32.const", value: kind },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then,
              else: chain,
            },
          ];
        }
        const matched: Instr[] = [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: ctx.taCtorTypeIdx },
          { op: "struct.get", typeIdx: ctx.taCtorTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: kindLocal },
          ...chain,
        ];
        fctx.body.push({ op: "local.get", index: anyLocal });
        fctx.body.push({ op: "ref.test", typeIdx: ctx.taCtorTypeIdx });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: matched,
          else: [{ op: "ref.null.extern" }],
        });
        return { kind: "externref" };
      }
      return { kind: "externref" };
    }
  }

  // (#2743 a) `arguments.constructor.prototype` → %Object.prototype% (§10.4.4):
  // the arguments object's `.constructor` is %Object%, whose `.prototype` is
  // %Object.prototype%. The arguments object is modeled as a vec, so the inner
  // `arguments.constructor` would resolve to the Array constructor and the outer
  // `.prototype` to %Array.prototype%. Intercept the COMPOUND access and emit the
  // compiler's own `Object.prototype` value-read (a synthetic `Object.prototype`
  // member access — the lowering is name-keyed on `Object`), so it matches the
  // identity a plain `Object.prototype` read produces. (#4555) Both targets.
  if (
    propName === "prototype" &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "constructor" &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "arguments" &&
    fctx.localMap.has("arguments")
  ) {
    const objIdent = ts.factory.createIdentifier("Object");
    (objIdent as { parent?: ts.Node }).parent = expr;
    ts.setTextRange(objIdent, expr.expression.expression);
    const objProtoExpr = ts.factory.createPropertyAccessExpression(objIdent, ts.factory.createIdentifier("prototype"));
    (objProtoExpr as { parent?: ts.Node }).parent = expr.parent ?? expr;
    ts.setTextRange(objProtoExpr, expr);
    const t = compileExpression(ctx, fctx, objProtoExpr, { kind: "externref" });
    if (t) return t.kind === "externref" ? t : { kind: "externref" };
  }

  // (#2743 a) `arguments.constructor` → %Object% (§10.4.4). The arguments object
  // is modeled as a vec (array-like), so `.constructor` would otherwise resolve
  // to the Array constructor. Emit the compiler's own `Object` value-read via a
  // synthetic `Object` identifier so `arguments.constructor === Object`. (The
  // compound `arguments.constructor.prototype` shape is handled above, because
  // the bare `Object` value's `.prototype` is not identity-equal to the
  // `Object.prototype` member-read in this compiler.) (#4555) Both targets —
  // standalone reaches the same `Object` / `Object.prototype` value reads.
  if (
    propName === "constructor" &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "arguments" &&
    fctx.localMap.has("arguments")
  ) {
    const objIdent = ts.factory.createIdentifier("Object");
    (objIdent as { parent?: ts.Node }).parent = expr.parent ?? expr;
    ts.setTextRange(objIdent, expr.expression);
    const t = compileExpression(ctx, fctx, objIdent, { kind: "externref" });
    if (t) return t.kind === "externref" ? t : { kind: "externref" };
  }

  // (#2901) `Object.getPrototypeOf(<view>.prototype).constructor` → the standalone
  // `%TypedArray%` intrinsic constructor object. This is the test262-runner's
  // injected `const TypedArray = Object.getPrototypeOf(Int8Array.prototype).constructor`
  // shim for the abstract intrinsic (test262-runner.ts ~1823); resolving the whole
  // syntactic chain to the ctor object (whose `.prototype` is `%TypedArray%.prototype`)
  // keeps the harness binding non-null at runtime and lets the §23.2.3 accessor
  // descriptor tests reach the #2893 getters host-free. Keyed on the call shape (not
  // identifier-as-value) so it cannot collide with the name-keyed `new Int8Array()`
  // construction path; standalone-only.
  if (noJsHost(ctx) && propName === "constructor" && isGetProtoOfWiredViewProtoCall(expr.expression)) {
    const t = emitTypedArrayIntrinsicCtorObject(ctx, fctx);
    if (t) return t.kind === "externref" ? t : { kind: "externref" };
  }

  // (#2026 PR-2) `.constructor` on an externref / `any`-typed instance: recover
  // class identity by reading the instance `__tag` and dispatching to the
  // matching `__class_<Name>` singleton, so `a.constructor === A` holds even when
  // `a` flowed through an `any` binding. Only fires for an `any`/`unknown`
  // receiver — a concretely-typed class instance keeps the zero-overhead static
  // arm in `compileInstanceMember`.
  if (propName === "constructor") {
    const isAnyOrUnknown = (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    if (isAnyOrUnknown) {
      const ctorIdn = tryEmitConstructorViaTag(ctx, fctx, expr, objType);
      if (ctorIdn !== undefined) return ctorIdn;
    }
  }

  // (#4442) `<fn>.constructor` → `%Function%` (§20.2.3.1); the arm and the
  // emitter the bare `Function` read shares live in function-intrinsic-carrier.ts.
  const fnValueCtor = tryEmitFunctionValueConstructorRead(ctx, fctx, expr, propName, objType);
  if (fnValueCtor !== undefined) return fnValueCtor;

  // (#3006) Standalone `<Builtin>.prototype.constructor` / `<instance>.constructor`
  // → the GENUINE, identity-stable reified builtin-constructor object (supersedes
  // the #2537 null-fold). Reading `.constructor` on a builtin extern-class receiver
  // otherwise walks the inheritance chain (`compileExternPropertyGet`) to the
  // `Object` base extern class — the only declarer of `constructor`,
  // `importPrefix: "Object"` — and emits an `env::Object_get_constructor` host
  // import (the leak the #2999 round-5 analysis flagged: 9 standalone passes for
  // Set/WeakMap/WeakRef/WeakSet/RegExp/FinalizationRegistry/DisposableStack/
  // SuppressedError plus instance forms). Route it to the SAME per-name
  // `__builtin_ctor_<Name>` singleton the bare identifier now resolves to
  // (identifiers.ts), so `<Builtin>.prototype.constructor === <Builtin>` is
  // GENUINELY true (same object) and the swap-wrong-builtin cross-check
  // `Set.prototype.constructor === Map` is GENUINELY false — NOT the null≡null
  // tautology #2537 relied on.
  //
  // Placed HERE (before the builtin-specific `.prototype`/regexp/native-proto
  // member paths further down) so it fires UNIFORMLY for every target builtin:
  // routing `RegExp.prototype.constructor` through `compileExternPropertyGet` would
  // never reach it (a RegExp-specific member path returns first). Gated on the
  // receiver being a genuine ambient-declared builtin (`isExternalDeclaredClass` +
  // the narrow `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` set) so a user `class Set {}`
  // (not extern-declared) keeps its own `.constructor`. Standalone-only: gc/host
  // keeps the real `Object_get_constructor` read (a genuine value there).
  if (ctx.standalone && propName === "constructor") {
    const builtinName = objType.getSymbol()?.name;
    if (
      builtinName !== undefined &&
      isBuiltinConstructorIdentityName(builtinName) &&
      isExternalDeclaredClass(objType, ctx.checker)
    ) {
      // Evaluate the receiver for its side effects (spec: the object expression is
      // evaluated), then discard it — the constructor identity does not depend on
      // the receiver instance.
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult) {
        fctx.body.push({ op: "drop" });
      }
      return emitBuiltinConstructorIdentity(ctx, fctx, builtinName);
    }
  }

  // (#2875 w4-F) `<primitive string>.constructor` → the same carrier as above.
  const psc = tryEmitPrimitiveStringConstructorRead(ctx, fctx, expr, propName);
  if (psc !== undefined) return psc;

  // (#3177) Standalone `.constructor` on a TYPEDARRAY-typed receiver —
  // `Uint16Array.prototype.constructor` (the `.prototype` read's TS type IS the
  // instance type) and `sample.constructor` for a statically-typed view — → the
  // per-kind `$__ta_ctor` SINGLETON (`emitTaCtorValue`), the same object a bare
  // `Uint16Array` identifier mention produces, so
  // `Uint16Array.prototype.constructor === Uint16Array` is GENUINELY true by
  // ref.eq and the cross-check against a different view ctor is genuinely
  // false. Mirrors the #3006 arm above (same gates: ambient-declared receiver
  // type only, so a user `class Uint8Array {}` keeps its own `.constructor`).
  // Any-typed dyn-view receivers resolve at RUNTIME via the `__extern_get`
  // dyn-view arm instead (kind → singleton switch).
  // Guard: TA builtins are ambient `interface` + `var` declarations (NOT
  // classes), so `isExternalDeclaredClass` never matches them — require every
  // declaration to live in a `.d.ts` instead (a user `class Uint8Array {}`
  // declares in the user file → falls through to its own `.constructor`).
  if (ctx.standalone && propName === "constructor") {
    const taSym = objType.getSymbol();
    const taName = taSym?.name;
    const taDecls = taSym?.getDeclarations();
    if (
      taName !== undefined &&
      taCtorKindOf(taName) >= 0 &&
      taDecls !== undefined &&
      taDecls.length > 0 &&
      taDecls.every((d) => d.getSourceFile().isDeclarationFile)
    ) {
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult) {
        fctx.body.push({ op: "drop" });
      }
      const t = emitTaCtorValue(ctx, fctx, taName);
      if (t) return t;
    }
  }

  // (#3133) Standalone `.constructor` on a PLAIN-OBJECT or ARRAY receiver → the
  // SAME identity-stable namespace-object singleton the bare `Object` / `Array`
  // identifier resolves to (`emitBuiltinNamespaceObject`, identifiers.ts ~769).
  // #3006 deliberately EXCLUDED `Object`/`Array` from its per-builtin ctor
  // singletons because their bare values already carry genuine namespace-object
  // identity — but the `.constructor` READ path for their instances was never
  // routed anywhere, so `({}).constructor` / `[1].constructor` /
  // `Object.prototype.constructor` / `Array.prototype.constructor` fell through
  // to the dynamic `$Object` own-prop read and returned `undefined`
  // (`({}).constructor === Object` → false). Routing the read to the SAME
  // per-name `__builtin_<Name>` global makes the identity GENUINELY true (same
  // WasmGC object, `ref.eq`) while the swap-wrong-builtin cross-check
  // (`({}).constructor === Array`) stays GENUINELY false (distinct singletons).
  //
  // Conservative gates: static-type-driven like the #3006 arm above; declines
  // (falls through, current behavior) for any/unknown/union receivers, callables,
  // receivers whose type declares a USER-written `constructor` member, and — as
  // a module-wide guard against runtime shadowing — any module that assigns to
  // or deletes a `.constructor` property anywhere. Standalone-only: gc/host mode
  // keeps the genuine `Object_get_constructor` host read.
  //
  // (#4232) …with ONE exception the classifier cannot see: `Object(<primitive>)`
  // also has TS type `Object`, but ToObject(§20.1.1.1) makes it a String/Number/
  // Boolean WRAPPER, whose `.constructor` is that builtin, not `Object`. The
  // fold stands down for a provable primitive-wrapper receiver so #4223's
  // runtime arm answers instead. See object-ctor-primitive-receiver.ts for why
  // the check has to trace the identifier's initializer.
  if (ctx.standalone && propName === "constructor") {
    const nsName = classifyPlainCtorReceiverNamespace(ctx, objType);
    if (
      nsName !== undefined &&
      !moduleTouchesConstructorProp(expr.getSourceFile()) &&
      !receiverIsPrimitiveWrapper(ctx, expr.expression)
    ) {
      // Evaluate the receiver for its side effects (spec: MemberExpression is
      // evaluated), then discard it — the constructor identity is static.
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult) {
        fctx.body.push({ op: "drop" });
      }
      const t = emitBuiltinNamespaceObject(ctx, fctx, nsName);
      if (t) return t.kind === "externref" ? t : { kind: "externref" };
    }
  }

  // (#2660 S2) `F.prototype` on a user function constructor (standalone): return
  // the per-fnctor prototype `$Object` global instead of `__extern_get($closure,
  // "prototype")` (which misses `ref.test $Object` → null). Makes
  // `Object.create(F.prototype)` resolve and seeds #2660 S3's `instance.$proto`.
  // Declines (falls through) for classes/builtins/host mode.
  {
    const fnctorProto = tryEmitFnctorPrototypeRead(ctx, fctx, expr, propName);
    if (fnctorProto !== undefined) return fnctorProto;
  }
  return PA_FALLTHROUGH;
}

export function tryPinnedAndDeleteAwareDynamicGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // (#3683 S2 branch a) TYPED-`this` field READ inside a typed twin. Runs FIRST
  // — ahead of the pinned dispatcher below — because it is that dispatcher's
  // own `$__fnctor_F` arm inlined against the receiver the twin prologue
  // already `ref.cast` down to a typed local: `struct.get` with NO dispatcher
  // call and NO box→externref→unbox round-trip, returning the FIELD's ValType
  // so downstream expression lowering stays numeric. Declines (falls through to
  // the identical-semantics pinned path) for presence-tracked fields, accessor
  // props, reserved names and method-typed accesses. See typed-this.ts.
  {
    const typed = tryEmitTypedThisFieldGet(ctx, fctx, expr, propName);
    if (typed !== undefined) return typed;
  }

  // (#3685 S2) The same inline `struct.get`, for a receiver the receiver-flow
  // analysis proves rather than one a twin already `ref.cast`. Runs after the
  // `this` form (whose proof is strictly stronger and whose lowering is
  // unguarded) and before the pinned dispatcher below, which it replaces for
  // the reads it admits. Guarded + dynamic-else, so an imprecise verdict is a
  // slow read, never a wrong value. See typed-this.ts.
  {
    const proven = tryEmitProvenReceiverFieldGet(ctx, fctx, expr, propName);
    if (proven !== undefined) return proven;
  }

  // (#2681/#2686 A3) Pinned-struct dynamic member READ. When the receiver is the
  // `this` of a lifted fnctor-PROTOTYPE method (`fctx.thisStructName`, set by
  // `resolveLiftedMethodThisStruct`), or a local bound from a single-return-
  // inferable fnctor `new`/call (the `receiverStruct` flow-map), route the
  // dynamic `recv.<field>` read through the finalize-filled `__get_member_<name>`
  // dispatcher. The dispatcher reads the native struct slot — returning the SAME
  // `__fnctor_*` struct externref the field stored — so `this.type === types.name`
  // is a native `ref.eq` and matches. Without this, acorn's Parser instance reads
  // `this.type` via the host-proxy `__extern_get`, whose externref identity
  // diverges from the stored native `__fnctor_TokenType` → the `switch` falls to
  // `default → unexpected()` (#2681) / the operator compare fails (#2686) → throw.
  // The dispatcher keeps `__extern_get` as its terminal, so accessor / genuinely-
  // dynamic props (`Object.defineProperties(Parser.prototype, …)`) still resolve.
  // Runs BEFORE the delete-aware read so it covers BOTH delete and delete-free
  // modules. The `this`-receiver branch intentionally bypasses
  // `resolveReceiverStruct`'s `structMap.has` gate: a reader method often compiles
  // before the `new this()` site registers the struct, but the dispatcher is
  // finalize-filled so a later-registered struct is still enumerated.
  {
    const pinnedThis =
      expr.expression.kind === ts.SyntaxKind.ThisKeyword && fctx.thisStructName !== undefined
        ? fctx.thisStructName
        : undefined;
    const pinned = pinnedThis ?? resolveReceiverStruct(ctx, fctx, expr.expression);
    if (pinned !== undefined) {
      const routed = tryEmitPinnedStructMemberGet(ctx, fctx, expr, propName, pinned);
      if (routed !== undefined) return routed;
    }
  }

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
  return PA_FALLTHROUGH;
}

export function tryBuiltinNamespaceDeferredReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
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
        if (recvType !== null) fctx.body.push({ op: "drop" });
        return compileStringLiteral(ctx, fctx, "utf-8");
      }
      if (objSym === "TextDecoder" && (propName === "fatal" || propName === "ignoreBOM")) {
        const recvType = compileExpression(ctx, fctx, expr.expression);
        if (recvType !== null) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
    }
  }
  return PA_FALLTHROUGH;
}

export function tryBufferViewAttributeReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // (#3054 B2) Accessor props on a shared-backing `$__ta_view` receiver
  // (`.byteLength`, `.byteOffset`, `.buffer` identity, `BYTES_PER_ELEMENT`). Runs
  // BEFORE the generic TypedArray accessor arms below, which discriminate on the
  // TS type NAME and would `ref.cast` the view to a native vec (→ read 0 for
  // `.byteLength`, synthesize a fresh non-identity buffer for `.buffer`). The view
  // is discriminated by the receiver's resolved LOCAL typeIdx, so native TAs /
  // plain arrays / non-buffer programs never reach this arm (byte-inert). `.length`
  // stays on the B1 local-type arm further down.
  if (
    propName === "byteLength" ||
    propName === "byteOffset" ||
    propName === "buffer" ||
    propName === "BYTES_PER_ELEMENT"
  ) {
    const tvIdx = taViewReceiverTypeIdx(ctx, fctx, expr.expression);
    if (tvIdx !== undefined) {
      const r = emitTaViewAccessor(ctx, fctx, tvIdx, propName, expr.expression, (e, h) =>
        compileExpression(ctx, fctx, e, h),
      );
      if (r) return r;
    }
  }

  // (#3054 C) Standalone `.maxByteLength` / `.resizable` on an ArrayBuffer
  // receiver. The resizable-ness is the runtime type identity: a
  // `$__resizable_ab` instance (from `new ArrayBuffer(n, {maxByteLength})`) vs a
  // plain `$__vec_i32_byte`. Discriminated with `ref.test $__resizable_ab`:
  //   `.resizable`     → the test result (true for resizable, false for fixed).
  //   `.maxByteLength` → resizable: field 2; fixed: field 0 (byteLength) per
  //                      §25.1.5.4 (a fixed buffer reports its byteLength).
  // Only reached for a static ArrayBuffer receiver in the host-free lane; native
  // TAs / plain arrays / non-buffer programs never take this arm (byte-inert).
  if (
    (ctx.wasi || ctx.standalone || ctx.strictNoHostImports) &&
    (propName === "maxByteLength" || propName === "resizable")
  ) {
    const recvName =
      objType.getSymbol()?.name ??
      (ts.isNewExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)
        ? expr.expression.expression.text
        : undefined);
    if (recvName === "ArrayBuffer" && noJsHost(ctx)) {
      const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
      const rabTypeIdx = getOrRegisterResizableAbType(ctx);
      // Recover the receiver as an anyref so `ref.test $__resizable_ab` is valid
      // regardless of whether the local is typed as the vec or externref.
      const recvType = compileExpression(ctx, fctx, expr.expression);
      if (recvType?.kind === "externref") {
        fctx.body.push({ op: "any.convert_extern" });
      }
      const abAny = allocLocal(fctx, `__rab_any_${fctx.locals.length}`, { kind: "anyref" });
      fctx.body.push({ op: "local.set", index: abAny });
      if (propName === "resizable") {
        // IsResizableArrayBuffer is the native subtype identity and is
        // intentionally unaffected by detachment. Keep the boolean tag on the
        // ValType so an escaped value boxes as true/false, not numeric 1/0.
        fctx.body.push({ op: "local.get", index: abAny });
        fctx.body.push({ op: "ref.test", typeIdx: rabTypeIdx });
        return { kind: "i32", boolean: true };
      }
      // maxByteLength: detached -> 0; otherwise resizable field 2 or fixed
      // byteLength field 0.
      fctx.body.push({ op: "local.get", index: abAny });
      fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.lt_s" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } as ValType },
        then: [{ op: "i32.const", value: 0 }],
        else: [
          { op: "local.get", index: abAny },
          { op: "ref.test", typeIdx: rabTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } as ValType },
            then: [
              { op: "local.get", index: abAny },
              { op: "ref.cast", typeIdx: rabTypeIdx },
              { op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 2 },
            ],
            else: [
              { op: "local.get", index: abAny },
              { op: "ref.cast", typeIdx: vecTypeIdx },
              { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
            ],
          },
        ],
      });
      if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_u" });
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }
  }

  // (#2159 Slice 2) Standalone/WASI `byteLength` / `byteOffset` view-semantics
  // for ArrayBuffer / SharedArrayBuffer / TypedArrays. In JS-host mode the JS
  // runtime supplies these; with no host they fell through to `__extern_length`
  // / a 0 default. The backing representation (see dataview-native.ts):
  //   ArrayBuffer / SharedArrayBuffer  → vec "i32_byte" (field 0 = *byte* length)
  //   Uint8Array (native)              → vec "i8_byte"  (field 0 = element count)
  //   other TypedArrays                → vec "f64"      (field 0 = element count)
  // `byteLength` is element-size-scaled: ArrayBuffer/Uint8Array byteLength ==
  // field0; Int32Array == field0*4, Float64Array == field0*8, etc. `byteOffset`
  // is always 0 for our non-offset views (a fresh backing store per view), which
  // already reads correctly today — handled here only for the externref-receiver
  // case so it doesn't leak `__extern_get`.
  // (#3061) `.byteLength` / `.byteOffset` on an ArrayBuffer / SharedArrayBuffer
  // are ALSO computed natively in JS-host mode. The host `__extern_get` fallback
  // returns `undefined` for these accessors on the opaque WasmGC byte-vec struct
  // (they are not real struct fields and no `__sget_byteLength` export exists), so
  // `ab.byteLength` / `ab.byteOffset` read back NaN (~45 test262 fails). The
  // `i32_byte` backing (field-0 = byte count, element size 1) is IDENTICAL across
  // host and standalone, so the `isBuffer` arm below is representation-safe in both
  // modes. (#3062) DataView is ALSO host-handled now, via the `__dv_view_byte_attr`
  // helper that reads the `_dvViewMeta` window (see the dedicated arm below).
  // TypedArray stays standalone-only here (its element-scaled backing diverges in
  // host mode — a separate follow-up).
  const hostBufferByteAttr =
    !noJsHost(ctx) && !ctx.strictNoHostImports && (propName === "byteLength" || propName === "byteOffset");
  if (
    (ctx.wasi || ctx.standalone || ctx.strictNoHostImports || hostBufferByteAttr) &&
    (propName === "byteLength" || propName === "byteOffset" || propName === "BYTES_PER_ELEMENT")
  ) {
    const recvNameRaw =
      objType.getSymbol()?.name ??
      (ts.isNewExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)
        ? expr.expression.expression.text
        : undefined);
    // (#3062) `DataView.prototype.byteLength` / `ArrayBuffer.prototype.byteLength`
    // etc. — a `.prototype` receiver has the buffer/view TYPE name but is NOT an
    // instance (no [[DataView]] / [[ArrayBufferData]] internal slot), so per spec
    // (§25.3.4.1 / §25.1.5.1 step 3) the getter must throw a TypeError. The native
    // accessor arms below would instead read a bogus 0 off the non-instance
    // prototype object (`__dv_byte_len` misses → 0, or a trapping `ref.cast`
    // standalone). Null out `recvName` for a `<ctor>.prototype` receiver so every
    // arm skips it and the read falls through to the generic reader, which
    // reports the required TypeError (matches pre-#3061/#3062 behaviour).
    const recvName =
      ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "prototype"
        ? undefined
        : recvNameRaw;
    // (#3061) In JS-host mode only the plain ArrayBuffer arm is
    // representation-safe (`i32_byte`, field-0 = byte count, identical to
    // standalone). SharedArrayBuffer's host-mode backing differs (a bare
    // `i32_byte` `ref.test` misses → a wrong `0`), so keep SAB — like
    // TypedArray — gated to no-host; both fall through to the generic reader in
    // host mode exactly as before.
    const isBuffer = recvName === "ArrayBuffer" || (recvName === "SharedArrayBuffer" && noJsHost(ctx));
    const isTypedArr = recvName !== undefined && TYPED_ARRAY_NAMES.has(recvName) && noJsHost(ctx);
    const isDataView = recvName === "DataView";
    // (#2159/#38) DataView `byteOffset` / `byteLength` honour the constructor's
    // window. The receiver is either a `$__dv_window` wrapper (windowed view) or
    // a bare `$__vec_i32_byte` (offset-0 default-length view). For the wrapper,
    // read its byteOffset / byteLength fields; for the bare vec, byteOffset = 0
    // and byteLength = vec.length (one i32 per byte ⇒ length IS the byte count).
    if (isDataView && usesNativeDataViewProvider(ctx) && propName !== "BYTES_PER_ELEMENT") {
      const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
      const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
      const fieldIdx = propName === "byteOffset" ? 1 : 2;
      // (#3173) §25.3.4.2/3 — the byteLength/byteOffset getters throw TypeError
      // on a detached buffer (marker: buffer vec length < 0). Template built
      // BEFORE the receiver compile (funcIdx-capture ordering rule).
      const detachedThrow = dvDetachedThrowInstrs(ctx);
      flushLateImportShifts(ctx, fctx);
      const recvType = compileExpression(ctx, fctx, expr.expression);
      const anyLocal = allocLocal(fctx, `__dvp_any_${fctx.locals.length}`, { kind: "anyref" });
      if (recvType?.kind === "externref") {
        fctx.body.push({ op: "any.convert_extern" });
      }
      fctx.body.push({ op: "local.set", index: anyLocal });
      const winBranch: Instr[] = [
        // detached? → TypeError
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: dvWinTypeIdx },
        { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 0 }, // buf
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }, // buf.length
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        { op: "if", blockType: { kind: "empty" }, then: detachedThrow, else: [] },
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: dvWinTypeIdx },
        { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx },
      ];
      const vecBranch: Instr[] =
        propName === "byteOffset"
          ? [{ op: "i32.const", value: 0 }]
          : [
              { op: "local.get", index: anyLocal },
              { op: "ref.cast", typeIdx: vecTypeIdx },
              { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
            ];
      fctx.body.push({ op: "local.get", index: anyLocal });
      fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: winBranch,
        else: vecBranch,
      });
      if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }
    // (#3062) JS-host DataView `byteLength` / `byteOffset`. In host mode
    // `new DataView(buf, offset, length)` returns the raw i32_byte buffer struct
    // (no `$__dv_window` wrapper — that shape is `noJsHost`-only, see
    // new-super.ts); the view window is recorded out-of-band in `_dvViewMeta` by
    // `__dv_register_view` at construction. Without this arm the read falls
    // through to `__extern_get(struct, "byteLength")` → undefined → NaN. Recover
    // the window via the `__dv_view_byte_attr(view, sel)` host helper:
    //   sel 0 → byteOffset, sel 1 → byteLength (windowed; sentinel handled host-side).
    if (isDataView && !usesNativeDataViewProvider(ctx) && propName !== "BYTES_PER_ELEMENT") {
      const attrIdx = ensureLateImport(
        ctx,
        "__dv_view_byte_attr",
        [{ kind: "externref" }, { kind: "i32" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (attrIdx !== undefined) {
        const recvType = compileExpression(ctx, fctx, expr.expression);
        // The helper takes an externref. DataView locals are already externref;
        // an inline `new DataView(...)` receiver may hand back a GC ref
        // (`ref`/`ref_null`) — recover it to externref before the call.
        if (recvType && recvType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
        fctx.body.push({ op: "i32.const", value: propName === "byteOffset" ? 0 : 1 });
        fctx.body.push({ op: "call", funcIdx: attrIdx });
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
    if (isBuffer || isTypedArr) {
      // byteOffset on a fresh-backing view is always 0.
      if (propName === "byteOffset") {
        const recvType = compileExpression(ctx, fctx, expr.expression);
        if (recvType !== null) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: 0 });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
      // (#2595) `view.BYTES_PER_ELEMENT` — instance element byte width
      // (§23.2.3.1). A constant per constructor name; drop the (possibly
      // side-effecting) receiver and emit it. Only TypedArrays expose it —
      // ArrayBuffer/SharedArrayBuffer/DataView do not, so when the receiver is a
      // buffer, fall through (the read resolves to `undefined` downstream).
      if (propName === "BYTES_PER_ELEMENT") {
        if (isTypedArr) {
          const recvType = compileExpression(ctx, fctx, expr.expression);
          if (recvType !== null) fctx.body.push({ op: "drop" });
          const bytes = TYPED_ARRAY_BYTES_PER_ELEMENT[recvName!] ?? 1;
          fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: bytes });
          return ctx.fast ? { kind: "i32" } : { kind: "f64" };
        }
      } else {
        // byteLength = field0 * BYTES_PER_ELEMENT. ArrayBuffer's field0 is already
        // a byte count, so its element size is 1.
        const bytesPerElem = isBuffer ? 1 : (TYPED_ARRAY_BYTES_PER_ELEMENT[recvName!] ?? 1);
        // (#2593) The vec storage MUST match the receiver's actual backing element
        // type — `typedArrayVecStorage` now packs all integer views standalone
        // (i8/i16/i32_byte), not just Uint8Array. Casting an Int32Array (i32_byte)
        // receiver to an f64 vec read the wrong field-0 → wrong byteLength.
        const storage = isBuffer
          ? { key: "i32_byte", type: { kind: "i8" } as ValType } // (#2835) packed byte buffer
          : typedArrayVecStorage(ctx, recvName!);
        const elemKey = storage.key;
        const elemType: ValType = storage.type;
        const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
        // (#2593) An EMPTY `new TA(0)` literal can compile to a different backing
        // vec type (e.g. an f64/empty vec) than the packed `vecTypeIdx` for the
        // declared view — an unconditional `ref.cast` then traps (`illegal cast`).
        // Read field-0 (length) through a runtime `ref.test`: on a packed-vec hit
        // read its length; on a miss (empty/mismatched backing) the length is 0
        // (`byteLength` of an empty view is 0 regardless of element width).
        const recvType = compileExpression(ctx, fctx, expr.expression);
        if (recvType?.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
        }
        const lenTmpBL = allocLocal(fctx, `__bl_len_${fctx.locals.length}`, { kind: "anyref" });
        fctx.body.push({ op: "local.set", index: lenTmpBL });
        fctx.body.push({ op: "local.get", index: lenTmpBL });
        fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } as ValType },
          then: [
            { op: "local.get", index: lenTmpBL },
            { op: "ref.cast", typeIdx: vecTypeIdx },
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
            // A detached ArrayBuffer stores -1 as its canonical native marker;
            // the public byteLength accessor observes zero.
            { op: "i32.const", value: 0 },
            { op: "local.get", index: lenTmpBL },
            { op: "ref.cast", typeIdx: vecTypeIdx },
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
            { op: "i32.const", value: 0 },
            { op: "i32.ge_s" },
            { op: "select" },
          ],
          else: [{ op: "i32.const", value: 0 }],
        });
        if (bytesPerElem !== 1) {
          fctx.body.push({ op: "i32.const", value: bytesPerElem });
          fctx.body.push({ op: "i32.mul" });
        }
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
  }

  // (#2596) `view.buffer` for a TypedArray / DataView under no-host. Without a
  // dedicated arm this fell to the generic `__extern_get(view, "buffer")` read
  // whose externref result was `ref.cast` to the `i32_byte` ArrayBuffer vec —
  // and since a `new TA(n)` view's backing is an `f64`/`i8` vec (not an
  // `i32_byte` buffer) and standalone has no real buffer object, the cast
  // trapped `illegal cast` at runtime, breaking EVERY `.buffer`-touching test.
  //
  // §22.2 / §25.x — `.buffer` is the view's [[ViewedArrayBuffer]]. We synthesize
  // a fresh `i32_byte` ArrayBuffer vec whose byte length == the view's byte
  // length (field-0 element count × BYTES_PER_ELEMENT for a TypedArray; the
  // backing byte count for a DataView), zero-filled. This makes
  // `view.buffer.byteLength` correct and non-trapping (the dominant test262 use).
  // TRUE write-through aliasing (mutating `.buffer` mutates the view, and
  // `a.buffer === b.buffer` identity) is OUT OF SCOPE — it needs the unified
  // byte-storage representation (pairs with #2593's packed migration); this slice
  // is the non-trapping floor. Host/gc mode keeps its host-import `.buffer`.
  if (
    propName === "buffer" &&
    (noJsHost(ctx) ||
      (usesNativeDataViewProvider(ctx) &&
        ctx.checker.getTypeAtLocation(expr.expression).getSymbol()?.name === "DataView"))
  ) {
    const bufRecvName =
      objType.getSymbol()?.name ??
      (ts.isNewExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)
        ? expr.expression.expression.text
        : undefined);
    const bufIsTypedArr = bufRecvName !== undefined && TYPED_ARRAY_BYTES_PER_ELEMENT[bufRecvName] !== undefined;
    const bufIsDataView = bufRecvName === "DataView";
    if (bufIsTypedArr || bufIsDataView) {
      const byteVecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
      const byteArrTypeIdx = getArrTypeIdxFromVec(ctx, byteVecTypeIdx);
      if (byteArrTypeIdx >= 0) {
        const byteLenLocal = allocLocal(fctx, `__tabuf_len_${fctx.locals.length}`, { kind: "i32" });
        if (bufIsDataView) {
          // (#3173) §25.3.4.1 — a DataView's `.buffer` is its ACTUAL viewed
          // buffer, identity included (`sample.buffer === buffer`, works on a
          // detached buffer too). Standalone DataViews are `$__dv_window`
          // wrappers whose `buf` field HOLDS the shared buffer vec — return it
          // directly instead of synthesizing a fresh zero-filled copy (the
          // pre-#3173 non-identity floor). A bare-vec receiver (legacy shape)
          // IS the buffer — return it unchanged.
          const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
          const recvType = compileExpression(ctx, fctx, expr.expression);
          const anyLocal = allocLocal(fctx, `__tabuf_any_${fctx.locals.length}`, { kind: "anyref" });
          if (recvType?.kind === "externref") {
            fctx.body.push({ op: "any.convert_extern" });
          }
          fctx.body.push({ op: "local.set", index: anyLocal });
          const winBranch: Instr[] = [
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: dvWinTypeIdx },
            { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 0 }, // buf (shared)
            { op: "extern.convert_any" },
          ];
          const vecBranch: Instr[] = [{ op: "local.get", index: anyLocal }, { op: "extern.convert_any" }];
          fctx.body.push({ op: "local.get", index: anyLocal });
          fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: winBranch,
            else: vecBranch,
          });
          return { kind: "externref" };
        } else {
          // TypedArray: recover the receiver through the SAME storage mapping
          // used by its constructor.  The old Uint8Array-vs-f64 split predates
          // packed Int8/Int16 and dedicated i32-element storage; after that
          // migration it cast every such receiver to the wrong vec type and
          // trapped on `.buffer` (Deno's Uint32Array→Uint8Array call-site
          // scratch view is the bootstrap-critical instance).
          const viewStorage = typedArrayVecStorage(ctx, bufRecvName!);
          const viewVecTypeIdx = getOrRegisterVecType(ctx, viewStorage.key, viewStorage.type);
          const recvType = compileExpression(ctx, fctx, expr.expression);
          if (recvType?.kind === "externref") {
            fctx.body.push({ op: "any.convert_extern" });
            fctx.body.push({ op: "ref.cast", typeIdx: viewVecTypeIdx });
          } else if (
            (recvType?.kind === "ref" || recvType?.kind === "ref_null") &&
            "typeIdx" in recvType &&
            recvType.typeIdx !== viewVecTypeIdx
          ) {
            fctx.body.push({ op: "ref.cast", typeIdx: viewVecTypeIdx });
          }
          fctx.body.push({ op: "struct.get", typeIdx: viewVecTypeIdx, fieldIdx: 0 });
          const bytesPerElem = TYPED_ARRAY_BYTES_PER_ELEMENT[bufRecvName!] ?? 1;
          if (bytesPerElem !== 1) {
            fctx.body.push({ op: "i32.const", value: bytesPerElem });
            fctx.body.push({ op: "i32.mul" });
          }
          fctx.body.push({ op: "local.set", index: byteLenLocal });
        }
        // Build the i32_byte ArrayBuffer vec: struct.new (byteLen, zero-filled
        // array of byteLen bytes). One i32 per byte (0..255), matching the
        // ArrayBuffer / DataView backing representation (dataview-native.ts).
        fctx.body.push({ op: "local.get", index: byteLenLocal });
        fctx.body.push({ op: "i32.const", value: 0 }); // default byte value
        fctx.body.push({ op: "local.get", index: byteLenLocal });
        fctx.body.push({ op: "array.new", typeIdx: byteArrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: byteVecTypeIdx });
        return { kind: "ref", typeIdx: byteVecTypeIdx };
      }
    }
  }
  return PA_FALLTHROUGH;
}

export function tryStandaloneBuiltinAndWasiMemberReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
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
      fctx.body.push({ op: "struct.get", typeIdx: resultTypeIdx, fieldIdx: propName === "read" ? 0 : 1 });
      return { kind: "f64" };
    }
    // Receiver didn't lower to the result struct — undo nothing (we already
    // emitted it); coerce/return a sensible f64 fallback.
    if (recvType !== null) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "f64.const", value: 0 });
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
  return PA_FALLTHROUGH;
}

export function tryNativeErrorMemberRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
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
  if (
    ctx.targetProfile.semanticProviders === "native-first" &&
    (propName === "message" || propName === "name" || propName === "stack")
  ) {
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
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "any.convert_extern" });

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
        fctx.body.push({ op: "ref.cast", typeIdx: structIdx });
        fctx.body.push({ op: "struct.get", typeIdx: structIdx, fieldIdx });
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
      fctx.body.push({ op: "local.set", index: tmpAny });
      fctx.body.push({ op: "local.get", index: tmpAny });
      fctx.body.push({ op: "ref.test", typeIdx: structIdx });
      // Build the `then` arm (read + coerce) into a swapped body buffer so
      // coerceType's appends land in the arm, not the main body.
      const savedBody = fctx.body;
      fctx.body = [];
      fctx.body.push({ op: "local.get", index: tmpAny });
      fctx.body.push({ op: "ref.cast", typeIdx: structIdx });
      fctx.body.push({ op: "struct.get", typeIdx: structIdx, fieldIdx });
      if (resultType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, resultType);
      const thenInstrs = fctx.body;
      fctx.body = savedBody;
      // (#4394) Non-`$Error` else-arm: generic `__extern_get` read instead of
      // a null string, so a caught user-fnctor instance (sta.js Test262Error,
      // reified to `$Object` at the throw boundary) keeps its `.message` —
      // see buildCaughtErrorPropFallback.
      const elseInstrs: Instr[] = buildCaughtErrorPropFallback(ctx, fctx, tmpAny, propName, resultType);
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: thenInstrs,
        else: elseInstrs,
      });
      releaseTempLocal(fctx, tmpAny);
      return resultType;
    }
  }
  return PA_FALLTHROUGH;
}

export function tryPrivateIdentifierRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
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
          fctx.body.push({ op: "any.convert_extern" });
        }
        fctx.body.push({ op: "local.set", index: tmpAny });
        emitPrivateBrandPredicate(ctx, fctx, tmpAny, declared.className, declared.structTypeIdx);
        // result-type block: on success, return the field value; on
        // failure, throw TypeError (which doesn't return).
        const successInstrs: Instr[] = [
          { op: "local.get", index: tmpAny },
          { op: "ref.cast", typeIdx: declared.structTypeIdx },
          { op: "struct.get", typeIdx: declared.structTypeIdx, fieldIdx },
        ];
        // Capture failure-path instrs by emitting into a saved body buffer.
        // Use pushBody/popBody (not a raw swap): emitThrowTypeError can add a
        // late string-constant import, which shifts every module-global index
        // and runs fixupModuleGlobalIndices. That fixup walks fctx.savedBodies,
        // so the swapped-out real body (which already holds the receiver's
        // `global.get` from `compileExpression(expr.expression)` above when the
        // receiver is a module global, e.g. a closed-over `self`) MUST be
        // registered there — otherwise its `global.get <self>` keeps its
        // pre-shift index and reads the wrong (f64) global → invalid Wasm
        // (#2563, privatefieldget-typeerror-5).
        const savedBody = pushBody(fctx);
        const message = `Cannot read private member #${expr.name.text.slice(1)} from an object whose class did not declare it`;
        emitThrowTypeError(ctx, fctx, message);
        const failureInstrs = fctx.body;
        popBody(fctx, savedBody);
        // Wrap in `if` returning fieldType. The `else` (failure) branch
        // ends with `throw`, which is unreachable per Wasm typing, so the
        // block's result type is satisfied by the `then` arm only.
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: fieldType },
          then: successInstrs,
          else: failureInstrs,
        });
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
          fctx.body.push({ op: "any.convert_extern" });
        }
        fctx.body.push({ op: "local.set", index: tmpAny });
        emitPrivateBrandPredicate(ctx, fctx, tmpAny, cls.className, structTypeIdx!);

        // Build the failure (throw) branch FIRST. emitThrowTypeError may
        // register late imports, which shift every funcMap index (the
        // getter's included). Settling those shifts before we read the
        // getter funcIdx keeps the `call` target correct.
        //
        // Use pushBody/popBody so the swapped-out real body is on
        // fctx.savedBodies for fixupModuleGlobalIndices: the receiver's
        // `global.get` (emitted by compileExpression above when the receiver
        // is a module global, e.g. a closed-over `self`) must shift with the
        // late string-constant import too, or it reads the wrong global type
        // → invalid Wasm (#2563, same defect as the field path above).
        const savedBody = pushBody(fctx);
        const message = `Cannot read private member #${expr.name.text.slice(1)} from an object whose class did not declare it`;
        emitThrowTypeError(ctx, fctx, message);
        const failureInstrs = fctx.body;
        popBody(fctx, savedBody);

        // Success path: cast to the declaring struct, then either call the
        // getter (accessor) or answer the method VALUE.
        let successInstrs: Instr[] = [
          { op: "local.get", index: tmpAny },
          { op: "ref.cast", typeIdx: structTypeIdx! },
        ];
        let resultKind: ValType;
        if (cls.kind === "method") {
          // (#3080) Reading a private method as a value must yield the SAME
          // canonical cached singleton the `this.#m` read yields (the
          // `__method_closure_<Owner>_<fieldName>` global minted by
          // `emitCachedMethodClosureAccess`), so
          // `this.#m === (() => this)().#m` holds. The legacy arm returned
          // the brand-checked RECEIVER itself as an externref view — a value
          // that is neither the method nor `===` any other read of it. The
          // brand check above still throws on a wrong-brand receiver.
          const canonicalClass = ctx.classExprNameMap.get(cls.className) ?? cls.className;
          const ownerName = resolveMethodOwnerClass(ctx, canonicalClass, cls.fieldName);
          const methodFullName = `${ownerName}_${cls.fieldName}`;
          const methodFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, methodFullName));
          const ownerStructTypeIdx = ctx.structMap.get(ownerName) ?? structTypeIdx!;
          let emitted = false;
          if (methodFuncIdx !== undefined) {
            // Capture the singleton access into a detached array. The failure
            // (throw) branch was popBody'd above and is DETACHED — register it
            // on savedBodies for the duration of this emission so any late
            // import/global shift the singleton emission triggers reaches its
            // baked indices too (the #2563 hazard class).
            fctx.savedBodies.push(failureInstrs);
            const savedBody2 = pushBody(fctx);
            emitted = emitCachedMethodClosureAccess(ctx, fctx, methodFullName, methodFuncIdx, ownerStructTypeIdx);
            const singletonInstrs = fctx.body;
            popBody(fctx, savedBody2);
            fctx.savedBodies.pop();
            if (emitted) successInstrs = singletonInstrs;
          }
          if (!emitted) {
            // Fallback (signature unresolvable): legacy receiver-view.
            successInstrs.push({ op: "extern.convert_any" });
          }
          resultKind = { kind: "externref" };
        } else {
          // Resolve the getter funcIdx AFTER the throw branch settled imports.
          const getterIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName))!;
          successInstrs.push({ op: "call", funcIdx: getterIdx });
          const funcDef = definedFuncAt(ctx, getterIdx);
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
        });
        releaseTempLocal(fctx, tmpAny);
        return resultKind;
      }
    }
    // Resolver failure (no enclosing class declares this private name).
    // Fall through to the generic path; it will throw via the existing
    // alternate / __extern_get fallbacks. This shouldn't happen for
    // well-formed source code.
  }
  return PA_FALLTHROUGH;
}

export function trySuperAndImportMetaRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
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
  return PA_FALLTHROUGH;
}

export function tryGlobalThisAndProcessRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // Handle globalThis.prop — compile as __extern_get(<globalThis>, key)
  // globalThis is a genuine JS object (externref), not a WasmGC struct.
  // Without this handler, the TS type `typeof globalThis` resolves to a struct
  // type and struct.get on a real JS object traps with null deref.
  //
  // (#2988) Receiver resolution is dual-mode:
  //   - host/gc: the `env::__get_globalThis` host import (unchanged).
  //   - standalone/WASI (no-JS-host): the native `globalThis` `$Object`
  //     singleton (#2996, `emitNativeGlobalThisObject`) — the SAME singleton that
  //     `Object.defineProperty(globalThis, k, desc)` and `globalThis.x = v`
  //     already write onto (both proven host-free), so reflective reads
  //     round-trip host-free. This retires the last `env::__get_globalThis`
  //     sole-import leak on the `globalThis.prop` member-read path. `__extern_get`
  //     itself is already a DEFINED native helper in these modes (routed via
  //     `ensureLateImport` → `ensureObjectRuntime`), so the read is fully
  //     host-free. If the native object runtime is unavailable, falls through to
  //     the host-import path.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "globalThis") {
    const nativeGlobal = ctx.standalone || ctx.wasi;
    // Import registration order is preserved for the host/gc path
    // (`__get_globalThis` then `__extern_get`, as it was before #2988) so that
    // path stays byte-identical. In standalone/WASI both names resolve to DEFINED
    // native helpers (no host import added, so ordering is immaterial), and the
    // `__extern_get` lookup also brings up the object runtime (incl.
    // `__new_plain_object`) that `emitNativeGlobalThisObject` needs.
    const gtFuncIdx = nativeGlobal ? undefined : ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);

    if (getIdx === undefined || (!nativeGlobal && gtFuncIdx === undefined)) {
      // Fallback: return null externref if imports couldn't be registered
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Emit: __extern_get(<globalThis receiver>, key) -> externref
    if (nativeGlobal) {
      const nativeVt = emitNativeGlobalThisObject(ctx, fctx);
      if (!nativeVt) {
        // Native runtime unavailable — fall back to the host import.
        const gt2 = ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (gt2 === undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
        fctx.body.push({ op: "call", funcIdx: gt2 });
      }
    } else {
      fctx.body.push({ op: "call", funcIdx: gtFuncIdx! });
    }
    addStringConstantGlobal(ctx, propName);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
    fctx.body.push({ op: "call", funcIdx: getIdx });
    if (ctx.runtimeEvalGlobalFunctionBindings === true) {
      emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
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
  return PA_FALLTHROUGH;
}

export function tryIdentifierNamespaceAndStaticReceiverRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
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
    // pairs so control reaches the constant emitter.
    //
    // (#3676) The trailing "gc/host is unaffected … observationally identical"
    // claim that used to sit here was WRONG for `Symbol.<wellKnown>`, and it is
    // the reason a module-scope `var S = Symbol.iterator` could not instantiate
    // under the default JS-host target. The two lowerings are NOT
    // interchangeable: the `__get_builtin`/`__extern_get` shortcut yields an
    // `externref` (a real host Symbol) while the downstream constant emitter
    // yields `i32.const <id>`. The compiler's canonical symbol VALUE
    // representation is the i32 id — `mapTsTypeToWasm` maps `symbol` → i32 and
    // `compileSymbolCall` returns an unbranded i32 counter — so the externref
    // gets coerced into the i32 slot through `__unbox_number`, i.e. literally
    // `Number(Symbol.iterator)`, which throws TypeError §7.1.4 at
    // `__module_init`. Fold well-known symbol reads to their i32 id in BOTH
    // modes so producer and slot agree. Identity across the host boundary is
    // preserved because `__box_symbol` pre-seeds ids 1..14 with the genuine
    // well-known symbols. Scoped to `Symbol.<wellKnown>` only — the Math/Number
    // f64 constants and `<Ctor>.length`/`.name` keep their standalone-only
    // defer, so host-mode bytes for those are unchanged.
    const deferToWellKnownSymbolId = builtinName === "Symbol" && getWellKnownSymbolId(propName) !== undefined;
    const deferToNativeConstant =
      deferToWellKnownSymbolId || (ctx.standalone && hasNativeBuiltinConstantHandler(builtinName, propName));
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
        // (#2963) IDENTITY-STABLE reified builtin value: read via a module-level
        // singleton so `Array.isArray === Array.isArray`, `Number.isInteger ===
        // Number.isInteger`, etc. hold (a fresh `struct.new` per read gave two
        // distinct instances → `!==`). Distinct builtins keep distinct singleton
        // globals, so `Array.isArray !== Number.isInteger` still holds.
        fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
        return closure.type;
      }
      // (#4484 B) `<Builtin>.constructor` — a builtin constructor is a function
      // object whose [[Prototype]] is `Function.prototype`, so the INHERITED
      // `constructor` it finds is `%Function%` (§20.2.3.1). There is no own
      // `constructor` on any builtin constructor to shadow it. Routed through
      // the ONE `%Function%` emitter (#4442) so this read cannot disagree with a
      // bare `Function` read in the same module. Before this arm the pair
      // refused LOUD — `Object.constructor` / `Boolean.constructor` were the two
      // remaining `compile_error` rows under
      // `language/expressions/property-accessors` (`S11.2.1_A4_T2` / `_A4_T6`,
      // measured compile_error→pass), failing the whole file over a read the
      // spec answers uniformly.
      if (propName === "constructor") {
        const fnIntrinsic = emitStandaloneFunctionIntrinsicValue(ctx, fctx);
        if (fnIntrinsic !== undefined) return fnIntrinsic;
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
      // (#3236 S1) Standalone sync generators route `genFn.prototype` to the
      // native `%GeneratorPrototype%` singleton (host-free) instead of leaking
      // `__get_generator_prototype`. Async generators keep the host import.
      if (!isAsyncGen && (ctx.standalone || ctx.wasi)) {
        const t = emitGeneratorPrototypeSingleton(ctx, fctx);
        if (t) return t;
      }
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
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "static"));
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
    if (
      process.env.DEBUG_MARKED_CODEGEN === "1" &&
      (objName === "Lexer" ||
        objName === "Parser" ||
        propName === "lex" ||
        propName === "lexInline" ||
        propName === "parse" ||
        propName === "parseInline")
    ) {
      const construct = objType.getConstructSignatures?.() ?? [];
      console.error(
        "[marked-static-read]",
        objName,
        "type",
        objType.getSymbol()?.name,
        "exact",
        exactClassExpressionTypeName(ctx, objType),
        "constructReturn",
        construct[0]?.getReturnType?.().getSymbol?.()?.name,
        "constructExact",
        construct[0] ? exactClassExpressionTypeName(ctx, construct[0].getReturnType()) : undefined,
        "mapped",
        ctx.classExprNameMap.get(objName),
        "classSet",
        ctx.classSet.has(objName),
        "moduleGlobal",
        ctx.moduleGlobals.get(objName),
      );
    }

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
      // (#3236 S1) Standalone sync generators route `genFn.prototype` to the
      // native `%GeneratorPrototype%` singleton (host-free) instead of leaking
      // `__get_generator_prototype`. Async generators keep the host import.
      if (!isAsyncGen && (ctx.standalone || ctx.wasi)) {
        const t = emitGeneratorPrototypeSingleton(ctx, fctx);
        if (t) return t;
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
    // Imported/aliased class values are often represented by an externref
    // module binding, so their bare identifier is not present in
    // `classExprNameMap`. Recover the declaration-identity synthetic class
    // from the constructor's instance return type before falling back to the
    // display name; otherwise `Lexer.lex`/`Parser.parse` are lowered through
    // the generic dynamic property path and their returned value is lost.
    const constructReturnType = objType.getConstructSignatures?.()[0]?.getReturnType?.();
    const resolvedClass =
      ctx.classExprNameMap.get(objName) ??
      (constructReturnType ? exactClassExpressionTypeName(ctx, constructReturnType) : undefined) ??
      objName;
    if (ctx.classSet.has(resolvedClass)) {
      const __r = emitClassStaticMemberRead(ctx, fctx, resolvedClass, propName);
      if (__r !== PA_FALLTHROUGH) return __r;
    }
  }
  return PA_FALLTHROUGH;
}

/**
 * (#4460) Static-member read off a resolved compiled class NAME.
 *
 * Extracted VERBATIM from the `ClassName.<prop>` band of
 * {@link tryIdentifierNamespaceAndStaticReceiverRead} so the same emission can
 * also serve a receiver that is a class EXPRESSION written in place
 * (`class { static m() {} }.m`) — see
 * {@link tryClassExpressionStaticMemberRead}. The identifier band previously
 * owned the only copy, so an in-place class expression matched no arm at all
 * and fell through to the generic struct/dynamic member get, which yields
 * `ref.null.extern`: the read was observably `null` at runtime even though the
 * checker-driven `typeof` / `.length` folds still reported `"function"` / `0`.
 *
 * The caller has already established `ctx.classSet.has(resolvedClass)`.
 * Returns {@link PA_FALLTHROUGH} where the original block fell out of its
 * `if (ctx.classSet.has(...))` body without returning.
 */
function emitClassStaticMemberRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  resolvedClass: string,
  propName: string,
): PADispatchResult {
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
  // ClassName.constructor — return the constructor function reference.
  // (#3024) A class may declare a STATIC method literally named
  // `constructor` (`static * constructor() {}` — legal, distinct from the
  // instance constructor; the `grammar-static-ctor-*-meth-valid` test262
  // family). `C.constructor` then reads that static method as a value and
  // must be boxed like any other static method (a closure struct →
  // `extern.convert_any`, the arm below). The legacy raw path here emitted
  // `ref.func <C_constructor>` + `extern.convert_any` — but a funcref is
  // NOT in the anyref hierarchy, so `extern.convert_any` on it is invalid
  // Wasm (`call[N] expected externref, found ref.func of (ref M)`). Skip
  // the raw path when a static method owns the name, letting the
  // static-method closure arm below handle it correctly.
  if (propName === "constructor" && !ctx.staticMethodSet.has(fullName)) {
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
    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "static"));
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
  return PA_FALLTHROUGH;
}

/**
 * (#4460) `class { static m() {} }.m` — a static member read taken directly off
 * an in-place class EXPRESSION.
 *
 * The `ClassName.<prop>` band above requires an IDENTIFIER receiver, so a class
 * expression written in place matched no arm and fell through to the generic
 * struct / dynamic member get, which emits `ref.null.extern`. The value was
 * therefore observably `null` at runtime while the checker-driven `typeof` and
 * `.length` folds still answered `"function"` and `0` from the static type —
 * a compile-time/runtime disagreement, and the reason
 * `language/expressions/class/static-method-length-dflt.js` failed standalone
 * while its `language/statements/class/` twin passed.
 *
 * The class body itself was already collected under a synthetic name
 * (`__anonClass_<n>`, `declarations.ts` `registerClassExpression`), so the fix
 * is purely to route the read through the SAME emission the declaration form
 * uses — {@link emitClassStaticMemberRead}.
 *
 * Emission order: the member read is built into a scratch body first so the
 * arm can decline without having emitted anything; only once it is known to
 * handle the read is the class expression itself compiled (for its observable
 * §15.7.1 effects — the own-name TDZ ReferenceError and the static-`prototype`
 * TypeError live in `compileClassExpression`) and its value dropped. The
 * scratch body stays on `fctx.savedBodies` across that compile so a late import
 * added while compiling the receiver still shifts its func indices.
 */
export function tryClassExpressionStaticMemberRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): PADispatchResult {
  const receiver = skipTransparentExpressions(expr.expression);
  if (!ts.isClassExpression(receiver)) return PA_FALLTHROUGH;
  const className = ctx.anonClassExprNames.get(receiver) ?? receiver.name?.text;
  if (className === undefined || !ctx.classSet.has(className)) return PA_FALLTHROUGH;

  const saved = pushBody(fctx);
  const memberResult = emitClassStaticMemberRead(ctx, fctx, className, propName);
  const memberInstrs = fctx.body;
  popBody(fctx, saved);
  if (memberResult === PA_FALLTHROUGH) return PA_FALLTHROUGH;

  fctx.savedBodies.push(memberInstrs);
  const receiverType = compileExpression(ctx, fctx, receiver);
  fctx.savedBodies.pop();
  if (receiverType) fctx.body.push({ op: "drop" });
  fctx.body.push(...memberInstrs);
  return memberResult;
}

export function tryPrototypeMethodAndArityReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // (#4481) The STANDALONE analogue of the host-lane #3368 arm below, over every
  // {Object,Array,Number,Boolean,String} × proto-method cell. Whole subsystem
  // (measurements, both shadow gates, callee-position decline): the module.
  const identityRead = tryEmitInstanceBuiltinProtoMethodValue(ctx, fctx, expr, propName);
  if (identityRead !== undefined) return identityRead;
  // (#3368) A plain array's inherited method VALUE is the corresponding
  // `%Array.prototype%` function object. Method calls (`arr.toString()`) already
  // use the native array-method lowering, but a detached value read
  // (`arr.toString`) previously fell through to the WasmGC struct-field path
  // and produced `undefined`. Besides being directly observable, that broke
  // the required identity `arr.toString === Array.prototype.toString`.
  //
  // Keep this host-lane slice deliberately narrow to the sampled member. The
  // receiver is still evaluated for side effects, then discarded; the value is
  // read from the same sandboxed builtin object that an explicit
  // `Array.prototype.toString` expression uses, preserving reference identity.
  const receiverFact = ctx.oracle.typeFactOf(expr.expression);
  const receiverName = ctx.oracle.declaredNameOf(expr.expression);
  const receiverIsArray =
    receiverFact.kind === "array" ||
    receiverFact.kind === "tuple" ||
    receiverName === "Array" ||
    receiverName === "ReadonlyArray";
  if (!noJsHost(ctx) && propName === "toString" && receiverIsArray) {
    const getBuiltinIdx = ensureLateImport(ctx, "__get_builtin", [{ kind: "externref" }], [{ kind: "externref" }]);
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getBuiltinIdx !== undefined && getIdx !== undefined) {
      const receiverType = compileExpression(ctx, fctx, expr.expression);
      if (receiverType !== null) fctx.body.push({ op: "drop" });

      addStringConstantGlobal(ctx, "Array");
      fctx.body.push(...stringConstantExternrefInstrs(ctx, "Array"));
      fctx.body.push({ op: "call", funcIdx: getBuiltinIdx });
      for (const member of ["prototype", "toString"] as const) {
        addStringConstantGlobal(ctx, member);
        fctx.body.push(...stringConstantExternrefInstrs(ctx, member));
        fctx.body.push({ op: "call", funcIdx: getIdx });
      }
      return { kind: "externref" };
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
  return PA_FALLTHROUGH;
}

/**
 * (#3424) Emit the standalone numeric `.length` read for an `any`/`unknown`
 * receiver already compiled to externref. Reified builtin function values are
 * closure-root subtypes, so consult their exact finalize-filled metadata before
 * preserving the legacy `__extern_length` fallback for non-closures.
 */
function emitStandaloneAnyLength(ctx: CodegenContext, fctx: FunctionContext): ValType {
  const closureRootIdx = getFuncRefWrapperRootTypeIdx(ctx);
  ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
  // (#2175 S3b-3, defect B) The metadata consult used to be ensured ONLY when
  // the module had a closure root, because it was only ever asked for a closure
  // receiver. It now answers for `$__ta_ctor` too (ta-ctor-meta.ts), and a
  // program can reify `Int8Array` while compiling no closure at all — measured:
  // with a closure present the consult fired and `Int8Array.length` read 3;
  // without one it stayed 0. So the import is ensured whenever a `$__ta_ctor`
  // type is registered as well.
  //
  // Reading `ctx.taCtorTypeIdx` here is a best-effort widening, not a
  // correctness dependency: if the type is not registered yet (function
  // compilation order is not source order) the module simply keeps its previous
  // behaviour for this site. The consult itself is a call resolved at finalize,
  // so wherever the import IS present the `$__ta_ctor` arm works regardless of
  // when the type appeared.
  const taCtorRegistered = ctx.taCtorTypeIdx !== undefined && ctx.taCtorTypeIdx >= 0;
  const wantMeta = closureRootIdx !== undefined || taCtorRegistered;
  if (wantMeta) {
    ensureLateImport(
      ctx,
      "__builtinfn_get_meta",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    addStringConstantGlobal(ctx, "length");
  }
  const metaLengthToI32 = wantMeta ? coercionInstrs(ctx, { kind: "externref" }, { kind: "i32" }, fctx) : undefined;
  flushLateImportShifts(ctx, fctx);

  const lenFn = ctx.funcMap.get("__extern_length");
  const bfnGetMetaFn = ctx.funcMap.get("__builtinfn_get_meta");
  const genericLength = (recvExternLocal: number): Instr[] =>
    lenFn !== undefined
      ? [{ op: "local.get", index: recvExternLocal }, { op: "call", funcIdx: lenFn }, { op: "i32.trunc_sat_f64_s" }]
      : [{ op: "i32.const", value: 0 }];
  const guardedLength = (recvExternLocal: number): Instr[] => {
    if (bfnGetMetaFn === undefined || metaLengthToI32 === undefined) {
      return genericLength(recvExternLocal);
    }
    const metaLocal = allocLocal(fctx, `__bfn_len_meta_${fctx.locals.length}`, { kind: "externref" });
    // (#2175 S3b-3, defect B) The metadata consult is asked FIRST, for ANY
    // receiver, instead of only for a closure-root subtype.
    //
    // WHY. `__builtinfn_get_meta` answers `length` for more shapes than
    // closures: `fillTaCtorGetMetaArm` (ta-ctor-meta.ts) splices a `$__ta_ctor`
    // arm returning 3 per §23.2.5.1. Gating the consult on `ref.test
    // <closureRoot>` made that arm unreachable from this path, so a reified
    // TypedArray constructor fell through to `__extern_length`, which has no
    // notion of a ctor and answered **0**. Measured on `origin/main` @
    // `9e17d34f3`, standalone: `Int8Array.length` → 0, while `Int8Array["length"]`
    // → 3 and `gOPD(Int8Array,"length").value` → 3 — i.e. only the
    // property-access lowering was wrong, which is what the nine
    // `built-ins/TypedArrayConstructors/<View>/length.js` files assert.
    //
    // WHY NOT a `ref.test $__ta_ctor` arm alongside the closure one: this
    // function runs during BODY compilation, and `$__ta_ctor` is registered
    // lazily when a TA constructor is first reified. Function compilation order
    // is not source order, so `ctx.taCtorTypeIdx` can still be unset here even
    // for a program that does reify one — the same ordering trap that made the
    // V2-S3b-1 seeder silently skip RegExp. Asking the meta native has no such
    // dependency: it is a call, resolved at finalize.
    //
    // Legacy behaviour is preserved exactly on the miss path: a receiver with no
    // metadata answers `0` if it is a closure (a plain user closure's arity is
    // not statically tracked here — the #2580 Cluster-A value) and otherwise
    // falls to `__extern_length`, which is what each did before.
    return [
      { op: "local.get", index: recvExternLocal },
      ...stringConstantExternrefInstrs(ctx, "length"),
      { op: "call", funcIdx: bfnGetMetaFn },
      { op: "local.tee", index: metaLocal },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        // Miss path, byte-for-byte the previous semantics: a CLOSURE with no
        // metadata answers 0 (a plain user closure's arity is not tracked here —
        // the #2580 Cluster-A value); anything else falls to `__extern_length`.
        // With no closure root in the module there is no closure to test, so the
        // generic fallback stands alone.
        then:
          closureRootIdx === undefined
            ? genericLength(recvExternLocal)
            : [
                { op: "local.get", index: recvExternLocal },
                { op: "any.convert_extern" },
                { op: "ref.test", typeIdx: closureRootIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [{ op: "i32.const", value: 0 }],
                  else: genericLength(recvExternLocal),
                },
              ],
        else: [{ op: "local.get", index: metaLocal }, ...metaLengthToI32],
      },
    ];
  };

  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    emitGuardedNativeStringLength(ctx, fctx, guardedLength);
  } else if (closureRootIdx !== undefined && bfnGetMetaFn !== undefined && metaLengthToI32 !== undefined) {
    const recvExternLocal = allocLocal(fctx, `__bfn_len_recv_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: recvExternLocal }, ...guardedLength(recvExternLocal));
  } else if (lenFn !== undefined) {
    fctx.body.push({ op: "call", funcIdx: lenFn }, { op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "drop" }, { op: "i32.const", value: 0 });
  }
  if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

export function tryLengthAndNameReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  const derivedLength = tryEmitDerivedLengthLocal(ctx, fctx, expr, propName);
  if (derivedLength !== undefined) return derivedLength;

  // `split(literal).length` normally enters the array-length arm below before
  // the string-derived-length dispatcher gets a chance to see the call. If an
  // immutable literal table proves the field count is uniform, retain the
  // receiver read/trap and return that count without building a string array.
  if (
    ctx.nativeStrings &&
    ctx.anyStrTypeIdx >= 0 &&
    propName === "length" &&
    ts.isCallExpression(expr.expression) &&
    ts.isPropertyAccessExpression(expr.expression.expression) &&
    expr.expression.expression.name.text === "split" &&
    expr.expression.arguments.length === 1 &&
    ts.isStringLiteralLike(expr.expression.arguments[0]!)
  ) {
    const receiver = expr.expression.expression.expression;
    const receiverValues = staticConstStringValues(ctx, receiver);
    if (receiverValues) {
      const separator = expr.expression.arguments[0]!.text;
      const lengths = new Set(receiverValues.map((value) => value.split(separator).length));
      if (lengths.size === 1) {
        const uniformLength = lengths.values().next().value;
        if (uniformLength !== undefined) {
          const receiverType = compileExpression(ctx, fctx, receiver);
          if (receiverType?.kind === "externref") {
            coerceType(ctx, fctx, receiverType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
          }
          fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: uniformLength });
          return { kind: "i32" };
        }
      }
    }
  }

  // (#2187) `.length` on an `any`-typed identifier whose compiled local ValType
  // is a native-string ref (e.g. a for-of var from a string-yielding generator).
  // Must run BEFORE the Function/vec `.length` arms below: the static type is
  // `any`, so those arms either miss or fall through to `__extern_length` (0
  // standalone). At the VALUE level the receiver IS a string — read `len` (field
  // 0 of `$AnyString`) natively. Tightly gated by `receiverIsNativeStringValType`
  // (standalone + bare-identifier + any/unknown TS type + string-ref local).
  if (propName === "length" && receiverIsNativeStringValType(ctx, fctx, expr.expression)) {
    const recvType = compileExpression(ctx, fctx, expr.expression);
    if (recvType && recvType.kind === "externref") {
      coerceType(ctx, fctx, recvType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
    }
    fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
    return { kind: "i32" };
  }

  // Handle Function.length — return the number of formal parameters
  if (propName === "length") {
    // (#1632a) `.length` on the result of `.bind(...)` must NOT be statically
    // resolved to the target's param count — per spec it's
    // `max(0, target.length - boundArgs.length)`. Fall through to the
    // externref / __extern_get path so the host-bound function's actual
    // `.length` is read.
    const isBindResult = isBindResultExpr(ctx, expr.expression);
    // (§20.2.3) `<callable>.{apply,call,bind,toString}.length` — the spec arity,
    // which `lib.es5.d.ts` does not spell (`apply`'s `argArray?` is optional
    // there, so the §15.1.5 prefix walk answers 1 for a member the spec pins
    // at 2). Table + gate live in function-prototype-callable.ts.
    if (!isBindResult) {
      const specLength = functionPrototypeMemberSpecLength(ctx, expr.expression);
      if (specLength !== undefined) {
        fctx.body.push({ op: "f64.const", value: specLength });
        return { kind: "f64" };
      }
    }
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
        // (#4436) ES §15.1.5 ExpectedArgumentCount — a PREFIX count that stops
        // at the first defaulted/optional/rest parameter, NOT a filter of them.
        // The old `filter().length` justified itself with "TS forbids
        // required-after-optional", which is false for the JS this compiler
        // accepts: `function f(x = 42, y) {}` has `length === 0`, not 1. See
        // function-expected-argument-count.ts for the measured divergence table.
        const sig = lengthSigs[0]!;
        const paramCount = expectedArgumentCountOfSignature(sig);
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
        if (decl && (ts.isBindingElement(decl) || ts.isVariableDeclaration(decl))) {
          let resolvedName: string | undefined;
          if (decl.initializer) {
            let initExpr: ts.Expression = decl.initializer;
            while (ts.isParenthesizedExpression(initExpr)) initExpr = initExpr.expression;
            if (isAnonymousFunctionDefinition(decl.initializer) && !classExpressionDefinesOwnName(decl.initializer)) {
              // SingleNameBinding NamedEvaluation: anonymous fn/class inherits
              // the binding identifier's text as its .name. (#2756) A class with
              // its own `static name` member overrides the binding name, so skip
              // synthesis there and fall through to the real property read.
              resolvedName = expr.expression.text;
            } else if (ts.isFunctionExpression(initExpr) && initExpr.name) {
              // Named function expression keeps its own name (the binding
              // identifier is ignored per spec).
              resolvedName = initExpr.name.text;
            } else if (ts.isClassExpression(initExpr) && initExpr.name) {
              resolvedName = initExpr.name.text;
            }
          }
          // (#2201) The binding initializer is not itself a function (e.g.
          // `var value = 1` or no initializer), but a later logical-assignment
          // may install an anonymous fn/class whose .name is NamedEvaluation'd
          // to the LHS identifier.
          if (resolvedName === undefined && sym) {
            resolvedName = resolveLogicalAssignmentName(ctx, expr.expression, sym);
          }
          if (resolvedName !== undefined) {
            addStringConstantGlobal(ctx, resolvedName);
            return compileStringLiteral(ctx, fctx, resolvedName);
          }
        }
      }
      if (hasFuncSig && (noJsHost(ctx) ? !objType.isUnion() : true)) {
        // Resolve the function name from the type symbol or the expression.
        //
        // UNION-typed receivers are excluded on the host-free lanes: a union
        // (e.g. `typedArrayConstructors[i]` — element type is the union of the
        // TA ctor interfaces) has no single static name, and the old fold
        // answered the covered-form `""` for every element — the literal
        // testTypedArray.js harness then keyed `callCounts[""]` and its
        // per-ctor call-count self-check failed. Falling through lets the
        // dynamic read (now backed by the `$__ta_ctor` meta arm) answer the
        // real per-value name. Host lane keeps the fold (byte-identical).
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
            if (
              initExpr !== undefined &&
              (!isAnonymousFunctionDefinition(initExpr) || classExpressionDefinesOwnName(initExpr))
            ) {
              // Covered form — .name is "" (or whatever the inner fn already has).
              // (#2756) A class with its own `static name` member overrides the
              // NamedEvaluation binding name, so it is NOT the binding text either.
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
            fctx.body.push({ op: "struct.get", typeIdx: vecIdx, fieldIdx: 0 });
            if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_u" });
          },
          () => {
            // [externref] → __extern_length (genuine host receiver / real JS array)
            const lengthFuncIdx = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
            flushLateImportShifts(ctx, fctx);
            if (lengthFuncIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: lengthFuncIdx });
              if (ctx.fast) fctx.body.push({ op: "i32.trunc_sat_f64_s" });
            } else {
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: 0 });
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
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_u" });
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
          // Plain vec ({length, data}) OR a `$__ta_view` ({length, buf, byteOffset},
          // #3054 B1) — both keep the ELEMENT count at field 0.
          if (
            typeDef?.kind === "struct" &&
            typeDef.fields[0]?.name === "length" &&
            (typeDef.fields[1]?.name === "data" || isTaViewTypeIdx(ctx, vecTypeIdx))
          ) {
            if (isTaViewTypeIdx(ctx, vecTypeIdx)) {
              // (#3054 C) A `$__ta_view` over a resizable buffer is auto-length —
              // derive the CURRENT element count (field0 == -1 sentinel → live
              // buf.length/elemSize) so `a.length` reflects a `rab.resize()`. A
              // fixed view reads field0 directly (byte-identical to pre-C).
              pushTaViewEffectiveLen(ctx, fctx, localIdx, vecTypeIdx);
            } else {
              fctx.body.push({ op: "local.get", index: localIdx });
              fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
            }
            if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_u" });
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
          fctx.body.push({ op: "any.convert_extern" });
          fctx.body.push({ op: "local.set", index: anyTmpIdx });
          const lenType = ctx.fast ? { kind: "i32" as const } : { kind: "f64" as const };
          const lenTmp2 = allocLocal(fctx, `__len_val_${fctx.locals.length}`, lenType);
          const lengthFuncIdx = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
          flushLateImportShifts(ctx, fctx);
          const fallbackInstrs2: Instr[] =
            lengthFuncIdx !== undefined
              ? [
                  { op: "local.get", index: extTmpIdx },
                  { op: "call", funcIdx: lengthFuncIdx },
                  ...(ctx.fast ? ([{ op: "i32.trunc_sat_f64_s" }] satisfies Instr[]) : []),
                  { op: "local.set", index: lenTmp2 },
                ]
              : [
                  { op: ctx.fast ? "i32.const" : "f64.const", value: 0 },
                  { op: "local.set", index: lenTmp2 },
                ];
          fctx.body.push({ op: "local.get", index: anyTmpIdx });
          fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: anyTmpIdx },
              { op: "ref.cast", typeIdx: vecTypeIdx },
              { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
              ...(ctx.fast ? [] : ([{ op: "f64.convert_i32_u" }] satisfies Instr[])),
              { op: "local.set", index: lenTmp2 },
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
          // (#2649) The compiled receiver's OWN static type may itself be a
          // length-prefixed {length,data} struct that differs from the
          // TS-resolved vec type — the canonical case is a `$__subview_<elem>`
          // returned by `ta.subarray(...)`: TS types it as the TypedArray (vec
          // `vecTypeIdx`), but the runtime value is the subview, whose field 0 IS
          // the element count. Read it DIRECTLY from the receiver's own type;
          // the `ref.test vecTypeIdx` fallback below always FAILS on the subview
          // (sibling subtype of `$__vec_base`, not the vec) and returns 0.
          const exprTypeIdx = (exprResult as { typeIdx: number }).typeIdx;
          const exprTypeDef = ctx.mod.types[exprTypeIdx];
          if (
            exprTypeDef?.kind === "struct" &&
            exprTypeDef.fields[0]?.name === "length" &&
            exprTypeDef.fields[1]?.name === "data"
          ) {
            fctx.body.push({ op: "struct.get", typeIdx: exprTypeIdx, fieldIdx: 0 });
            if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_u" });
            return ctx.fast ? { kind: "i32" } : { kind: "f64" };
          }
          const lenTmp = allocLocal(fctx, `__len_tmp_${fctx.locals.length}`, { kind: "anyref" });
          fctx.body.push({ op: "local.set", index: lenTmp });
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
          const lenResult = ctx.fast ? { kind: "i32" as const } : { kind: "f64" as const };
          fctx.body.push({
            op: "if",
            blockType: { kind: "val" as const, type: lenResult },
            then: [
              { op: "local.get", index: lenTmp },
              { op: "ref.cast", typeIdx: vecTypeIdx },
              { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
              ...(ctx.fast ? [] : ([{ op: "f64.convert_i32_u" }] satisfies Instr[])),
            ],
            else: [{ op: ctx.fast ? "i32.const" : "f64.const", value: 0 }],
          });
          return lenResult;
        }
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // get length from vec
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_u" });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
    // Fallback: compile the expression and check the actual wasm return type
    // This handles cases like strings.raw.length where TS doesn't know the type
    {
      // #1919 — transactional try-lower: keep the compiled receiver + struct.get
      // when it lowers to a length-prefixed vec; otherwise roll back the body AND
      // any locals / late imports / errors the compile leaked.
      const snap = snapshotSpeculative(ctx, fctx);
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
          if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_u" });
          return ctx.fast ? { kind: "i32" } : { kind: "f64" };
        }
      }
      // (#2580 M2 slice 1) `.length` on a statically-`any`/`unknown` receiver in
      // HOST mode, where the compiled receiver is NOT a length-bearing vec struct
      // above. The origin path coerces the read to NUMERIC, turning a plain
      // object's ABSENT `length` (spec `undefined`, §OrdinaryGet) into `0` / a
      // bogus `typeof "boolean"` (`var obj={}; obj.length===undefined` → false —
      // the #2580 headline bug). Route through the M2 tag/null-aware reader
      // (`emitDynGet`), which returns a UNIFORM externref: a boxed number for a vec
      // length / closure arity / null-undefined receiver (matching origin's prior
      // numeric value — the #1894-eject Cluster A/B classes), JS `undefined` for a
      // genuine non-null host object's absent property (the canary). The reader's
      // receiver-kind dispatch (`__extern_is_undefined` → 0, `ref.test $vec` →
      // field-0, `ref.test $closure` → 0, else `__extern_get`) is what a bare
      // `__extern_get` could not do — the M1 over-broad arm's failure. Gated
      // strictly on a static `any`/`unknown` receiver, host mode; the typed
      // `.length` hot-path is byte-identical (handled + returned above).
      // (#2580 M2 s1) DECLINE inside an async function/generator body. The
      // async state machine (#1042 CPS lowering) can leave a destructuring rest /
      // setter-captured local in a state where a speculative `compileExpression`
      // recompile resolves a STALE value (the #2602-class desync; surfaces for the
      // for-await array-rest `.length` reads incl. the setter-property variant).
      // Origin reads those correctly via its own non-speculative path, so DECLINE
      // here → fall through to origin (all 8 for-await rest `.length` tests stay
      // green). The #2580 canary + Cluster A reads are NOT inside async functions,
      // so they still take the reader. Walk to the nearest function-like ancestor
      // and check the `async` modifier.
      let inAsyncFn = false;
      for (let p: ts.Node | undefined = expr.parent; p; p = p.parent) {
        if (
          ts.isFunctionDeclaration(p) ||
          ts.isFunctionExpression(p) ||
          ts.isArrowFunction(p) ||
          ts.isMethodDeclaration(p)
        ) {
          inAsyncFn = ts.getModifiers(p)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
          break;
        }
      }
      if (
        !ctx.standalone &&
        !inAsyncFn &&
        (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 &&
        exprType
      ) {
        if (exprType.kind !== "externref") {
          coerceType(ctx, fctx, exprType, { kind: "externref" });
        }
        if (emitDynGet(ctx, fctx, "length")) {
          return { kind: "externref" };
        }
        // emitDynGet bailed (no runtime) — roll back; the legacy paths recompile.
        rollbackSpeculative(ctx, fctx, snap);
      } else {
        // (#1919) Undo the compiled expression if it didn't match — transactional
        // rollback (body + locals + late imports + errors), not a bare truncate.
        rollbackSpeculative(ctx, fctx, snap);
      }
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
          return emitStandaloneAnyLength(ctx, fctx);
        }
      }
    }
  }
  return PA_FALLTHROUGH;
}

export function tryNamespaceConstantAndSymbolReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
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
          { op: "local.get", index: rawObj },
          { op: "ref.cast", typeIdx: templateVecTypeIdx },
          { op: "struct.get", typeIdx: templateVecTypeIdx, fieldIdx: 2 },
          { op: "local.set", index: rawTmp },
        ],
        else: [
          // Not a template vec — return null (no raw field available)
          { op: "ref.null", typeIdx: baseVecTypeIdx },
          { op: "local.set", index: rawTmp },
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

  // (#2595) `<TypedArrayName>.BYTES_PER_ELEMENT` — static element byte width
  // (§23.2.6.x). Statically known per constructor name, so emit it as a
  // constant. Standalone otherwise reaches `reportUnsupportedStandaloneBuiltinValueRead`
  // (the generic builtin-static-value-read refusal); host mode reads the same
  // constant via the host import, so folding it here is observationally
  // identical and works in both modes. Skip when the name is shadowed by a local.
  if (
    propName === "BYTES_PER_ELEMENT" &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text in TYPED_ARRAY_BYTES_PER_ELEMENT
  ) {
    const builtinName = expr.expression.text;
    const isShadowed = fctx.localMap.has(builtinName) || (fctx.boxedCaptures?.has(builtinName) ?? false);
    if (!isShadowed) {
      const bytes = TYPED_ARRAY_BYTES_PER_ELEMENT[builtinName]!;
      fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: bytes });
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }
  }

  // (#2861) `<Ctor>.length` (declared arity) / `<Ctor>.name` (ctor name string)
  // — a built-in constructor's own function properties. Statically known per ctor
  // name, so emit as a constant. Standalone otherwise reaches
  // `reportUnsupportedStandaloneBuiltinValueRead` (the generic builtin-static-value
  // -read refusal); host mode reads the same value via `__get_builtin` and returns
  // BEFORE this point, so folding here is observationally identical and never
  // fires in host mode for a ctor. Namespaces (Math/JSON/Reflect/Atomics) are not
  // in BUILTIN_CTOR_ARITY (their `.length`/`.name` are undefined), so they keep
  // refusing. Skip when the name is shadowed by a local.
  if (
    (propName === "length" || propName === "name") &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text in BUILTIN_CTOR_ARITY
  ) {
    const builtinName = expr.expression.text;
    const isShadowed = fctx.localMap.has(builtinName) || (fctx.boxedCaptures?.has(builtinName) ?? false);
    if (!isShadowed) {
      if (propName === "length") {
        const arity = BUILTIN_CTOR_ARITY[builtinName]!;
        fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: arity });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
      // `<Ctor>.name` === "<Ctor>" for every standard builtin constructor.
      addStringConstantGlobal(ctx, builtinName);
      fctx.body.push(...stringConstantExternrefInstrs(ctx, builtinName));
      return { kind: "externref" };
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
    if (usesNativeSymbolProvider(ctx)) {
      ensureNativeSymbolBoundaryBridge(ctx);
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
  return PA_FALLTHROUGH;
}

export function tryStringLengthIteratorAndExternClassReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // A temporary ASCII case conversion preserves UTF-16 length exactly, and a
  // string replacement with equal literal code-unit lengths (and no `$`
  // substitution tokens) does too. When `.length` is the only observation,
  // avoid allocating the transformed string. The ASCII proof accepts only a
  // const literal table with no writes/aliases/method calls anywhere in its
  // source file; any uncertainty retains the ordinary native helper.
  if (propName === "length" && ts.isCallExpression(expr.expression)) {
    const call = expr.expression;
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      const receiverValues = staticConstStringValues(ctx, callee.expression);
      const uniformDerivedLength = staticUniformDerivedLength(receiverValues, method, call.arguments);
      if (uniformDerivedLength !== undefined) {
        // Preserve evaluation (including an OOB/null trap) even though the
        // derived result is uniform across every immutable table entry.
        const receiverType = compileExpression(ctx, fctx, callee.expression);
        if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
          if (receiverType?.kind === "externref") {
            coerceType(ctx, fctx, receiverType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
          }
          fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
          fctx.body.push({ op: "drop" });
        } else if (receiverType) {
          fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "i32.const", value: uniformDerivedLength });
        return { kind: "i32" };
      }
      const nativeTrimLength = tryEmitNativeTrimLength(ctx, fctx, call, receiverValues);
      if (nativeTrimLength) return nativeTrimLength;
      const asciiCaseLength =
        (method === "toLowerCase" || method === "toUpperCase") &&
        call.arguments.length === 0 &&
        receiverValues?.every((value) => [...value].every((char) => char.charCodeAt(0) <= 0x7f)) === true;
      const equalLiteralReplaceLength =
        method === "replace" &&
        call.arguments.length === 2 &&
        ts.isStringLiteralLike(call.arguments[0]!) &&
        ts.isStringLiteralLike(call.arguments[1]!) &&
        call.arguments[0]!.text.length === call.arguments[1]!.text.length &&
        !call.arguments[1]!.text.includes("$");
      const hostLengthIdx = ctx.jsStringImports.get("length");
      if ((asciiCaseLength || equalLiteralReplaceLength) && (ctx.nativeStrings || hostLengthIdx !== undefined)) {
        const receiverType = compileExpression(ctx, fctx, callee.expression);
        if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
          if (receiverType?.kind === "externref") {
            coerceType(ctx, fctx, receiverType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
          }
          fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
        } else {
          fctx.body.push({ op: "call", funcIdx: hostLengthIdx! });
        }
        return { kind: "i32" };
      }
    }
  }

  // #1910 R4 — String-wrapper `.length` in standalone. `new String("ab")` builds
  // a `$Object` wrapper carrying its [[StringData]] native string in the reserved
  // FLAG_INTERNAL slot (#1910 S2). `.length` is a String-exotic own property whose
  // value is the underlying string's length (§22.1.4.1). Recover the slot string
  // via `__to_primitive(recv, "string")` (reads the slot first, §7.1.1.1), then
  // read `$AnyString.len` (field 0). Standalone only — host mode keeps the wrapper
  // host-object machinery and its own `.length` reader.
  if (ctx.standalone && isStringWrapperType(objType) && propName === "length" && ctx.anyStrTypeIdx >= 0) {
    ensureObjectRuntime(ctx);
    const toPrimIdx = ctx.funcMap.get("__to_primitive");
    if (toPrimIdx !== undefined) {
      compileExpression(ctx, fctx, expr.expression, { kind: "externref" });
      addStringConstantGlobal(ctx, "string");
      fctx.body.push(...stringConstantExternrefInstrs(ctx, "string"));
      fctx.body.push({ op: "call", funcIdx: toPrimIdx });
      // __to_primitive returns the [[StringData]] string as externref; coerce to
      // $AnyString and read its `len` field.
      coerceType(ctx, fctx, { kind: "externref" }, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
      return { kind: "i32" };
    }
  }

  // Handle string.length
  // (#2187) Also fire for an `any`-typed identifier whose compiled local ValType
  // is a native-string ref (e.g. a for-of var from a string-yielding generator):
  // the static type lost the string info, but at the VALUE level it IS a string.
  if ((isStringType(objType) || receiverIsNativeStringValType(ctx, fctx, expr.expression)) && propName === "length") {
    // A detected string-builder binding is represented by synthetic
    // (buffer,length,capacity,materialized) locals. Its logical length is
    // already available directly; materializing a temporary NativeString on
    // every loop condition obscures this scalar from Wasmtime/Cranelift.
    if (ts.isIdentifier(expr.expression)) {
      const builder = fctx.stringBuilders?.get(expr.expression.text);
      if (builder !== undefined) {
        fctx.body.push({ op: "local.get", index: builder.lenLocalIdx });
        return { kind: "i32" };
      }
    }
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
  return PA_FALLTHROUGH;
}

/**
 * (#4157) The `__extern_get` receiver guard, hoisted out of
 * `finalizeStructAndDynamicMemberGet` so the proof plumbing does not grow an
 * already-oversized function. Elided when the receiver is provably non-null —
 * see `nonnull-proof.ts` for the proof discipline.
 *
 * `boxed` is recomputed rather than tracked: the caller boxes exactly when the
 * compiled type is `f64`/`i32` and `__box_number` resolved, which is the same
 * condition tested here.
 */
function emitExternGetReceiverGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  objExprType: ValType | null,
  objTmp: number,
): void {
  const numeric = objExprType?.kind === "f64" || objExprType?.kind === "i32";
  emitReceiverNullGuard(
    ctx,
    fctx,
    objTmp,
    {
      site: "dispatch:extern-get-recv",
      compiled: objExprType,
      expr: expr.expression,
      boxed: numeric && ctx.funcMap.get("__box_number") !== undefined,
      syntacticNonNull: isProvablyNonNull(expr.expression, ctx.checker),
    },
    () => typeErrorThrowInstrs(ctx, expr),
  );
}

export function finalizeStructAndDynamicMemberGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): ValType | null {
  // Handle getter accessor on user-defined classes
  const typeName = resolveStructNameForExpr(ctx, fctx, expr.expression, expr.name);
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
        fctx.body.push({ op: "extern.convert_any" });
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
        const getterDef = definedFuncAt(ctx, funcIdx);
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
      // (#2963) Owner-chain resolution extracted to `resolveMethodOwnerClass`
      // (class-member-keys.ts) so the member-get dispatcher's dynamic-read
      // method arms canonicalise to the SAME owner (→ same cache global).
      const owner = resolveMethodOwnerClass(ctx, typeName, propName);
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
            // Direct eval may reify a typed object binding into an externref
            // cell so the interpreter can observe and update it.  Preserve the
            // object-literal method fast path, but recover the concrete struct
            // before reading its closure field when that widening happened.
            const fieldType = structFields[fieldIdx]!.type;
            const objResult = compileExpression(ctx, fctx, expr.expression);
            if (objResult) {
              if (objResult.kind === "externref") {
                emitExternrefToStructGet(ctx, fctx, fieldType, structTypeIdx, fieldIdx, propName, true);
                if (fieldType.kind === "ref") {
                  return { kind: "ref_null", typeIdx: fieldType.typeIdx };
                }
              } else {
                fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
              }
              return fieldType;
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

    // (#2101a R5) Own-field READ on an externref-backed Error subclass. The
    // instance is the parent `$Error_struct` externref, NOT a `$A` struct, so
    // the struct.get-on-`$A` path below traps. message/name/stack were already
    // handled by the Error fast-path above (~L2227); any other property is a
    // user-declared own field living in the `$Error_struct.$props` (fieldIdx 5)
    // open-`$Object` backing. Read it via `__extern_get(self.props, propName)`
    // (null/undefined when props is null). Standalone only.
    if (ctx.standalone && ctx.classExternrefBackedSet.has(typeName)) {
      const ownRead = emitExternrefBackedOwnFieldRead(ctx, fctx, expr, propName, typeName);
      if (ownRead !== undefined) return ownRead;
      // undefined → helper unavailable; fall through to the legacy path.
    }

    // Handle struct field access (named or anonymous)
    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx !== undefined && fields) {
      const exactField = tryEmitExactStructFieldGet(
        ctx,
        fctx,
        expr,
        propName,
        objType,
        typeName,
        structTypeIdx,
        fields,
      );
      if (exactField !== undefined) return exactField;

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
            fctx.body.push({ op: "any.convert_extern" });
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
              { op: "ref.null.extern" },
              { op: "local.set", index: protoLocal },
            ],
            else: [
              // Try to cast to expected struct type and get __proto__
              { op: "local.get", index: objLocal },
              { op: "ref.test", typeIdx: structTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: objLocal },
                  { op: "ref.cast", typeIdx: structTypeIdx },
                  { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: protoFieldIdx },
                  { op: "local.set", index: protoLocal },
                ],
                else: [
                  // Wrong struct type — try alternate structs that have __proto__
                  { op: "ref.null.extern" },
                  { op: "local.set", index: protoLocal },
                ],
              },
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
              { op: "local.get", index: protoLocal },
              ...stringConstantExternrefInstrs(ctx, propName),
              { op: "call", funcIdx: getIdx },
              ...(ctx.runtimeEvalGlobalFunctionBindings === true ? runtimeEvalSharedValueUnwrapInstrs(ctx, fctx) : []),
              ...((effectiveResult.kind === "f64" && unboxIdx !== undefined
                ? [{ op: "call", funcIdx: unboxIdx }]
                : effectiveResult.kind === "i32" && unboxIdx !== undefined
                  ? [{ op: "call", funcIdx: unboxIdx }, { op: "i32.trunc_sat_f64_s" }]
                  : []) satisfies Instr[]),
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
          if (ctx.runtimeEvalGlobalFunctionBindings === true) {
            emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
          }

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
  // (#2071) A foreign-return-capable fnctor instance has no trustworthy static
  // shape (§10.2.1.3 step 13 may substitute an arbitrary object), so the
  // member's checker type may not narrow the dynamic read — an f64 access type
  // here would drag an overriding object's "A" through __unbox_number to NaN.
  // The receiver already resolves externref (resolveWasmType degrade); this
  // keeps the RESULT representation equally honest.
  const foreignReturnReceiver = (ctx.standalone || ctx.wasi) && typeIsForeignReturnFnctorInstance(objType);
  const accessWasm: ValType = foreignReturnReceiver
    ? { kind: "externref" }
    : symbolBrand(accessType, widenBooleanDynamicAccess(accessType, resolveWasmType(ctx, accessType)));

  // For struct types with the property, try to compile the object and do struct.get
  // but NEVER for class struct types — their fields are fixed at collection time
  // — and never for a foreign-return fnctor instance (#2071): its checker shape
  // may not describe the runtime value at all, so no field auto-registration.
  if (typeName && !ctx.classSet.has(typeName) && !foreignReturnReceiver) {
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
      // (#3033 Bug 2b) CHAINED dynamic read: the receiver is itself a purely-
      // undefined-typed member read off an externref receiver (`this.type` in
      // acorn's `this.type.keyword`). Its static type resolves NUMERIC
      // (resolveWasmType(undefined)), so the externref clause above misses it
      // and the read fell through to the terminal "unresolvable" fallback — a
      // constant `ref.null.extern` — making `x.var` throw. The receiver's
      // RUNTIME value is externref (the inner read compiles through this very
      // arm), so admit it here. Shared predicate with Bug 2a's var-slot typing
      // (`varBindingNeedsExternrefForUndefined`) — single source of truth.
      undefinedTypedMemberReadProducesExternref(ctx, expr.expression) ||
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
      // These bindings were deliberately placed on the dynamic object carrier
      // because their shape can change (growable objects, Proxy targets, and
      // other representation-sensitive values). A same-named closed-struct
      // field elsewhere in the module must not narrow the dynamic read back to
      // f64/i32: a missing property is the real undefined carrier, not numeric
      // NaN. The dispatch may still use its struct fast arms; only its result
      // representation stays honest.
      const preserveDynamicResultCarrier =
        (ts.isIdentifier(expr.expression) && ctx.externrefAccessorVars.has(expr.expression.text)) ||
        // (#2071) same honesty rule for a foreign-return fnctor instance: a
        // same-named struct field's f64 vote must not re-narrow the read.
        foreignReturnReceiver;
      const getIdx = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      let unboxIdx = ensureScalarUnbox(ctx, fctx, accessWasm);
      if (getIdx !== undefined) {
        const objExprType = compileExpression(ctx, fctx, expr.expression);
        // (#4155 Phase 2) The receiver's compiled ValType is already a
        // `$__fnctor_<Name>` struct ref and `propName` is one of its plain data
        // slots: read it with one `struct.get` instead of erasing the type one
        // instruction later and round-tripping through `__extern_get`'s
        // ref.test ladder. Flag-gated (declines → byte-identical fallthrough);
        // flag-independent census under JS2WASM_FNCTOR_TYPED_READS_DEBUG.
        const fnctorTypedGet = tryEmitFnctorTypedFieldGet(ctx, fctx, expr, propName, objExprType, () =>
          typeErrorThrowInstrs(ctx, expr),
        );
        if (fnctorTypedGet !== undefined) return fnctorTypedGet;
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
        // Null check: throw TypeError for property access on null/undefined.
        // (#4157) Skipped when the receiver is PROVABLY non-null.
        const objTmp = allocLocal(fctx, `__nullchk_${fctx.locals.length}`, { kind: "externref" });
        emitExternGetReceiverGuard(ctx, fctx, expr, objExprType, objTmp);
        // An interface / object-type receiver is only a structural contract.
        // When its runtime value is externref, let the canonical dynamic
        // provider discriminate exact closed shapes by their `$shape` stamps.
        // The generic inline candidate chain below uses brand-blind `ref.test`
        // and can read the same slot from a different, structurally
        // canonicalised descriptor literal.
        const structuralResult = tryEmitStructuralContractReadFromLocal(
          ctx,
          fctx,
          expr,
          propName,
          objType,
          typeName,
          objTmp,
        );
        if (structuralResult !== undefined) return structuralResult;
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
          fctx.body.push({ op: "any.convert_extern" });
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
          // (#4420) The vote is only admissible when the ACCESS ITSELF is
          // statically dynamic — `accessWasm.kind === "externref"`. The old
          // guard tested `resultWasm`, which is set to externref for EVERY
          // non-f64/i32 `accessWasm`, so a read whose static type is a concrete
          // `ref`/`ref_null` (an array, a struct) was eligible too and could be
          // collapsed to f64/i32 by an unrelated struct that merely shares the
          // property NAME. Self-compiling `src/emit/binary.ts` hit exactly that:
          // `instr.else` is `Instr[]` (`ref null $__vec_externref`), the only
          // struct in the module carrying an `else` field is the `OP` opcode
          // table (all-f64), so the single-candidate vote narrowed the read to
          // f64 while the enclosing `.length` still emitted the typed
          // `struct.get $__vec_externref 0` — `struct.get[0] expected (ref null
          // 2), found local.tee of type f64`, a module the engine rejects while
          // the compiler reported success. A concrete `ref`/`ref_null` access
          // type is a STATEMENT about the value's representation; a name-keyed
          // field vote may not overrule it. Such reads keep the honest
          // externref result and are re-narrowed by the caller's own coercion.
          if (resultWasm.kind === "externref" && accessWasm.kind === "externref" && !preserveDynamicResultCarrier) {
            const fieldKinds = new Set(structCandidates.map((c) => c.fieldType.kind));
            // (#3927) A hot/cold-split fnctor carries `propName` in its
            // lazily-allocated tail, and `findAlternateStructsForField`
            // deliberately cannot see the tail (an arm keyed on `ref.test
            // $…__cold` would be dead at best and, under WasmGC's structural
            // canonicalization, wrongly live at worst). Those slots are always
            // `externref`, so narrowing on the VISIBLE candidates alone is
            // unsound the moment a split moved the last externref carrier out:
            // the terminal `__get_member_<name>` (which DOES know the hop)
            // returns the boxed tail value, and the narrowing then drags it
            // through `__unbox_number` + `i32.trunc_sat_f64_s`. Measured on the
            // standalone acorn lane: with `generator` cold, its only remaining
            // VISIBLE carrier was `$__fnctor_TokContext`'s boolean-branded i32,
            // so every `node.generator` read answered a constant `false` —
            // 32,506 of 32,506 AST nodes, one wrong field out of 64.
            for (const cold of findColdStructsForField(ctx, propName)) fieldKinds.add(cold.fieldType.kind);
            // (#3927 per-type layouts) The same vote seam, twice over: the
            // sibling layouts and the resid carrier are hidden from
            // `findAlternateStructsForField` (their arms need stamp guards),
            // but they are CARRIERS of `propName` and must vote. "This layout
            // lacks the field" must never read as agreement — a family that
            // carries the name anywhere contributes its (externref) kind via
            // BOTH finders, which de-narrows exactly like the cold fix above.
            for (const lay of findFnctorLayoutStructsForField(ctx, propName)) fieldKinds.add(lay.fieldType.kind);
            for (const resid of findFnctorResidStructsForField(ctx, propName)) fieldKinds.add(resid.fieldType.kind);
            // (#2071) A foreign-return ctor's struct is a bad narrowing
            // witness: the same prop name is typically ALSO written to the
            // object the ctor RETURNS (that is the §10.2.1.3 override
            // pattern), and that object's props live on the open `$Object` —
            // an externref carrier this finder can't see. Same seam as the
            // #3927 hidden-carrier fixes above: contribute externref, which
            // de-narrows (measured: `obj.prop` holding "A" was narrowed to
            // the fnctor field's f64 and answered NaN, S13.2.2_A15_T2 shape).
            if ((ctx.standalone || ctx.wasi) && !fieldKinds.has("externref")) {
              const sfForeign = expr.getSourceFile();
              const foreignNames = sfForeign === undefined ? undefined : foreignReturnFunctionNames(sfForeign);
              if (foreignNames !== undefined && foreignNames.size > 0) {
                const foreignIdxs = new Set<number>();
                for (const nm of foreignNames) {
                  const ti = ctx.structMap.get(`__fnctor_${nm}`);
                  if (ti !== undefined) foreignIdxs.add(ti);
                }
                if (structCandidates.some((c) => foreignIdxs.has(c.structTypeIdx))) {
                  fieldKinds.add("externref");
                }
              }
            }
            // (#2864 wave-2 S1) The #2979 generator-sentinel exception, which
            // every OTHER consumer of this candidate set already carries
            // (`fillMemberGetDispatch`'s sentinel-aware box, `planGeneric`'s
            // `generator-sentinel` decline, `planTypedF64` /
            // `fillTypedMemberGetF64Dispatch` / `member-set-f64`'s
            // `!isNativeGeneratorResultStruct`), was MISSING here — and this is
            // the site that actually decides what the read site sees.
            //
            // A native generator's IteratorResult `value` is an f64 slot whose
            // UNDEF_F64 bit pattern MEANS `undefined`. The finalize-filled
            // `__get_member_value` dispatcher honours that: its arm answers a
            // null externref (standalone canonical `undefined`) for the
            // sentinel. The Phase-3 vote then saw a lone `f64` kind, narrowed
            // `resultWasm` to f64, and coerced the dispatcher's externref back
            // down through `__unbox_number` — turning the canonical `undefined`
            // into NaN, which the caller re-boxes as a NUMBER. Measured on the
            // exact test262 harness shape (`var result; result = iter.next();
            // assert.sameValue(result.value, undefined)`): `typeof` answered
            // "number", so every terminal `{value: undefined, done: true}`
            // assertion failed across language/expressions/yield and the
            // generators suites, host-free and silently.
            //
            // The narrowing is a PERFORMANCE specialization; the sentinel is a
            // REPRESENTATION fact. Keep the honest externref for these reads —
            // a numeric consumer re-narrows through its own coercion, paying one
            // box/unbox only in modules that both register a native generator
            // and read `.value` off a dynamically-typed receiver.
            const anyGeneratorSentinelCandidate = structCandidates.some(
              (c) => c.fieldType.kind === "f64" && isNativeGeneratorResultStruct(ctx, c.structTypeIdx),
            );
            if (fieldKinds.size === 1 && !anyGeneratorSentinelCandidate) {
              const k = [...fieldKinds][0];
              if (k === "f64" || k === "i32") {
                // (#2938) Preserve the #2030/#2785 boolean BRAND through the
                // Phase-3 narrowing. When EVERY candidate field is a boolean-
                // branded i32 (e.g. the native generator result's `done`,
                // generators-native.ts ensureNativeGeneratorResultType), the
                // narrowed read result is boolean too — the caller's
                // i32→externref boxing then routes through `__box_boolean`
                // (coerceType's #2785 brand-aware arm), so the test262 harness
                // shape `const d: any = g.next().done; d === true` holds. A
                // fresh unbranded `{kind:"i32"}` here ERASED the brand: the
                // value re-boxed as $BoxedNumber(1), the any-`===` typeof
                // partition saw number-vs-boolean, fell to ref identity, and
                // answered UNEQUAL (the residual wrong-value failure of the
                // #2938 no-yield relax — generators/no-yield.js, return.js).
                resultWasm = commonScalarFieldType(
                  k,
                  structCandidates.map((candidate) => candidate.fieldType),
                );
                if (unboxIdx === undefined) {
                  unboxIdx = ensureScalarUnbox(ctx, fctx, resultWasm);
                }
              }
            }
          }
          const resultLocal = allocLocal(fctx, `__sd_res_${fctx.locals.length}`, resultWasm);

          // Build the __extern_get fallback instructions
          const externGetFallback: Instr[] = [{ op: "local.get", index: objTmp }];
          addStringConstantGlobal(ctx, propName);
          externGetFallback.push(...stringConstantExternrefInstrs(ctx, propName));
          externGetFallback.push({ op: "call", funcIdx: getIdx });
          if (ctx.runtimeEvalGlobalFunctionBindings === true) {
            externGetFallback.push(...runtimeEvalSharedValueUnwrapInstrs(ctx, fctx));
          }
          if (resultWasm.kind === "f64" && unboxIdx !== undefined) {
            externGetFallback.push({ op: "call", funcIdx: unboxIdx });
          } else if (resultWasm.kind === "i32" && unboxIdx !== undefined) {
            externGetFallback.push({ op: "call", funcIdx: unboxIdx });
            if (resultWasm.symbol !== true) externGetFallback.push({ op: "i32.trunc_sat_f64_s" });
          }
          externGetFallback.push({ op: "local.set", index: resultLocal });

          // (#2674) Terminal: route the un-matched case through the deferred-fill
          // `__get_member_<name>` dispatcher (complete candidate set at finalize)
          // instead of straight to `__extern_get`. The inline `structCandidates`
          // here are frozen at THIS read's compile time, so a struct type
          // registered later (acorn's `$__fnctor_Parser`) is excluded → a read of
          // the real instance fell to `__extern_get` → `undefined` (the slot is a
          // real field, not a sidecar prop) → the acorn expression-parse loop
          // never terminated. The dispatcher tries ALL struct candidates THEN
          // `__extern_get`, so it strictly extends coverage; its externref result
          // is coerced back to `resultWasm` (which may be an f64/i32 Phase-3
          // narrowing). Reserved here; filled by fillMemberGetDispatch.
          // (#2043 hardening) Pass fctx so the dispatcher's late-import additions
          // flush against THIS body before baking `getMemberIdx` into the
          // detached terminal array + the follow-on coercion.
          const getMemberIdx = reserveMemberGetDispatch(ctx, propName, fctx);
          const dispatchTerminal: Instr[] =
            getMemberIdx !== undefined
              ? [
                  { op: "local.get", index: tmpAnyExt },
                  { op: "extern.convert_any" },
                  { op: "call", funcIdx: getMemberIdx },
                  ...(ctx.runtimeEvalGlobalFunctionBindings === true
                    ? runtimeEvalSharedValueUnwrapInstrs(ctx, fctx)
                    : []),
                  ...coercionInstrs(ctx, { kind: "externref" }, resultWasm, fctx),
                  { op: "local.set", index: resultLocal },
                ]
              : externGetFallback;

          // The inline candidate chain used to run before the deferred terminal.
          // That froze both the candidate set and collision-stamp knowledge at
          // this read's compile time. A later object shape could therefore be
          // structurally canonicalized with an earlier candidate and make its
          // ref.test succeed before the shape id existed, selecting the wrong
          // field (ReactDOM's `updateQueue.shared` returned a pending-state
          // object). The finalize-filled dispatcher already owns the complete
          // candidate set, shape guards, presence bits, boolean branding, and
          // generator-sentinel boxing. Use it as the single dynamic read path.
          fctx.body.push(...dispatchTerminal);
          fctx.body.push({ op: "local.get", index: resultLocal });
          // Phase 3 (#1269): when we narrowed `resultWasm` to the
          // candidates' shared primitive type, return that — caller
          // sees f64/i32 directly, no enclosing unbox needed. Falls
          // back to the legacy accessWasm-based return when no
          // narrowing was possible.
          // (#2938) Return `resultWasm` itself for the narrowed primitives so
          // the boolean brand (set above when all candidates are branded)
          // survives to the caller's coercions — a fresh `{kind:"i32"}` here
          // re-erased it.
          if (resultWasm.kind === "f64" || resultWasm.kind === "i32") return resultWasm;
          if (accessWasm.kind === "f64") return { kind: "f64" };
          if (accessWasm.kind === "i32") return { kind: "i32" };
          return { kind: "externref" };
        }

        // (#2963) No struct-FIELD candidates — but when a CLASS METHOD named
        // `propName` exists, route through the `__get_member_<name>` dispatcher:
        // its terminal is the same `__extern_get` (own/sidecar props keep
        // shadowing) plus miss-gated method arms answering the canonical
        // method-value singleton, so a dynamic `any`-receiver method read
        // resolves to a `===`-stable value instead of `undefined`.
        // (#3041) Also route when a class GET-ACCESSOR of this name exists —
        // else a getter via an `any` receiver fell to `__extern_get` → NaN; the
        // dispatcher's #3041 accessor arms `ref.cast`+`call` it. No such
        // method/getter of this name → byte-identical.
        if (
          classMethodCandidatesForProp(ctx, propName).length > 0 ||
          classAccessorCandidatesForProp(ctx, propName).length > 0
        ) {
          const getMemberIdx = reserveMemberGetDispatch(ctx, propName, fctx);
          if (getMemberIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: objTmp });
            fctx.body.push({ op: "call", funcIdx: getMemberIdx });
            if (ctx.runtimeEvalGlobalFunctionBindings === true) {
              emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
            }
            if (accessWasm.kind === "f64") {
              if (unboxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: unboxIdx });
              return { kind: "f64" };
            }
            if (accessWasm.kind === "i32") {
              if (unboxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: unboxIdx });
              if (accessWasm.symbol !== true) fctx.body.push({ op: "i32.trunc_sat_f64_s" });
              return { kind: "i32" };
            }
            return { kind: "externref" };
          }
        }

        // No struct candidates — use __extern_get directly
        fctx.body.push({ op: "local.get", index: objTmp });
        addStringConstantGlobal(ctx, propName);
        compileStringLiteral(ctx, fctx, propName);
        fctx.body.push({ op: "call", funcIdx: getIdx });
        if (ctx.runtimeEvalGlobalFunctionBindings === true) {
          emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
        }
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
          if (accessWasm.symbol !== true) fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          return accessWasm;
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
    const structObjTypeIdx =
      structObjType.kind === "ref" || structObjType.kind === "ref_null" ? structObjType.typeIdx : undefined;

    // A widened Object.defineProperty data property can have an exact Wasm
    // struct type even when TypeScript cannot recover its synthetic type name
    // (notably a module-global `var obj = {}`). The field already contains the
    // descriptor's value; sending this read to __extern_get only sees the
    // descriptor sidecar, whose value bit is deliberately absent for struct
    // fields, and therefore produces undefined/NaN. Prefer the exact compiled
    // field before the last-resort host-MOP path. Runtime-sidecar properties
    // and accessors were handled above, so this is the ordinary static field
    // lane that a successfully resolved typeName would have taken.
    //
    // (#1712 regression fix — PR #3267's 479f747c broke compiled-acorn) This
    // lane MUST be restricted to receivers whose runtime representation is
    // KNOWN to be the exact widened struct: `widenedVarStructMap` structs whose
    // `propName` was recorded by a data-descriptor `Object.defineProperty`
    // widening (`widenedDefinePropertyKeys`). The original unrestricted guard
    // ("any struct typeIdx that has a same-named field") also hijacked reads
    // whose receiver merely RESOLVES statically to an anon struct while its
    // runtime value is a growable host `$Object` (acorn's `types$1` token table
    // and `prototypeAccessors` descriptor tables — both take depth-2 writes, so
    // `collectGrowableObjectLiterals` routes them to the externref builder and
    // the anon struct is never instantiated). For a ref_null-typed field the
    // `emitExternrefToStructGet` __extern_get fallback then ref.tests the HOST
    // result against the struct type, fails, and substitutes ref.null — so
    // `prototypeAccessors.inFunction.get = fn` wrote onto null, the scope
    // accessors installed by `Object.defineProperties(Parser.prototype, …)`
    // lost their getters, and every scope predicate (inFunction / inGenerator /
    // allowNewDotTarget) answered undefined→false: "'return' outside of
    // function", new.target/yield parse throws (probe 13/13 → 8/13). The
    // widening pre-pass only widens EMPTY literals, so a widened receiver's
    // runtime value IS the struct and the exact-field read stays sound there —
    // while non-widened receivers keep the pre-#3267 dynamic host-MOP lane that
    // matches where their writes land.
    let exactStructField: ReturnType<typeof findAlternateStructsForField>[number] | undefined;
    if (!typeName && structObjTypeIdx !== undefined) {
      const structName = ctx.typeIdxToStructName.get(structObjTypeIdx);
      let widenedDefinePropStruct = false;
      if (structName) {
        for (const [varKey, widenedName] of ctx.widenedVarStructMap) {
          if (widenedName === structName && ctx.widenedDefinePropertyKeys.has(`${varKey}:${propName}`)) {
            widenedDefinePropStruct = true;
            break;
          }
        }
      }
      if (widenedDefinePropStruct) {
        exactStructField = findAlternateStructsForField(ctx, propName, -1).find(
          (candidate) => candidate.structTypeIdx === structObjTypeIdx,
        );
      }
    }
    if (!typeName && exactStructField) {
      const structExprType = compileExpression(ctx, fctx, expr.expression);
      if (structExprType?.kind === "ref_null") {
        emitNullGuardedStructGet(
          ctx,
          fctx,
          structExprType,
          exactStructField.fieldType,
          exactStructField.structTypeIdx,
          exactStructField.fieldIdx,
          propName,
          true,
        );
        if (exactStructField.fieldType.kind === "ref") {
          return { kind: "ref_null", typeIdx: exactStructField.fieldType.typeIdx };
        }
      } else if (structExprType?.kind === "externref") {
        emitExternrefToStructGet(
          ctx,
          fctx,
          exactStructField.fieldType,
          exactStructField.structTypeIdx,
          exactStructField.fieldIdx,
          propName,
          true,
        );
        if (exactStructField.fieldType.kind === "ref") {
          return { kind: "ref_null", typeIdx: exactStructField.fieldType.typeIdx };
        }
      } else if (structExprType) {
        fctx.body.push({
          op: "struct.get",
          typeIdx: exactStructField.structTypeIdx,
          fieldIdx: exactStructField.fieldIdx,
        });
      }
      return exactStructField.fieldType;
    }

    // (#2838 L4) Route a field-absent read on a typed function-constructor
    // (`__fnctor_*`) or inferred anon-object (`__anon*`) struct receiver through
    // this host-MOP / sidecar path as well — so a prototype accessor installed at
    // runtime via `Object.defineProperties(C.prototype, …)` is consulted
    // (`_fnctorProtoLookup` inside `__extern_get`). Previously only `!typeName`
    // (untyped) WasmGC structs reached here; a `__fnctor_`/`__anon` typed receiver
    // fell through to the default-`0` emit, so the runtime-installed getter never
    // fired (the acorn `this.<accessor>` wall). This is the LAST resort — the
    // static field fast path and the auto-register path (when the field is on the
    // TS type) both run first, so the hot struct-field read is untouched and only
    // genuinely-absent fields take the MOP route. Class structs stay excluded
    // (#856 — typed field access). Standalone resolves `__extern_get` to the
    // host-free open-object runtime, which owns the same prototype-accessor
    // sidecar; excluding it here made Acorn's installed scope getters read as
    // undefined (#3782).
    const fnctorOrAnonMop =
      !!typeName && !ctx.classSet.has(typeName) && (typeName.startsWith("__fnctor_") || typeName.startsWith("__anon"));
    const isWasmStruct =
      (structObjType.kind === "ref" || structObjType.kind === "ref_null") &&
      (structObjType as { typeIdx: number }).typeIdx !== undefined &&
      (!typeName || fnctorOrAnonMop); // typeName set ⇒ user-class structs handled above; allow fnctor/anon (#2838 L4)
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
        if (ctx.runtimeEvalGlobalFunctionBindings === true) {
          emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
        }
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

// <<PA_DISPATCH_HELPERS>>
