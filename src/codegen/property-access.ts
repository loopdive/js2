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
  isStringWrapperType,
} from "../checker/type-mapper.js";
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { emitBoundsCheckedArrayGet } from "./array-methods.js";
import { emitHoleToUndefined } from "./array-holes.js"; // (#2001 S1)
import type { PresenceSlot } from "./fnctor-presence-bits.js"; // (#3780) packed own-presence flags
import { presenceSlotOf, presenceTestInstrs } from "./fnctor-presence-bits.js";
import { classMemberFuncKey, resolveMethodOwnerClass } from "./class-member-keys.js"; // (#1983) collision-free class-member funcMap keys; (#2963) method-owner chain
import { exactClassExpressionTypeName } from "./class-expression-identity.js";
import { popBody, pushBody } from "./context/bodies.js";
import { resolveWidenedVarKey, integrityVarKey } from "./widened-var-key.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "./context/locals.js";
import { emitOverlayRoutedElementGet, overlayRouteActive } from "./typed-lane-overlay-route.js"; // (#4159 S3)
import { snapshotSpeculative, rollbackSpeculative } from "./context/speculative.js";
import { emitDynGet, widenBooleanDynamicAccess } from "./dyn-read.js"; // (#2580 M2 slice 1) (#2984)
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitCachedMethodClosureAccess, emitFuncRefAsClosure, getOrCreateFuncRefWrapperTypes } from "./closures.js";
import {
  BUILTIN_STATIC_METHOD_ARITY,
  ensureBuiltinFnMetaType,
  pushBuiltinFnSingletonValueInstrs,
  STANDALONE_STATIC_METHOD_META,
} from "./builtin-fn-meta.js";
import {
  emitBuiltinConstructorIdentity,
  emitBuiltinNamespaceObject,
  isBuiltinConstructorIdentityName,
} from "./builtin-static-globals.js";
import { emitLazyClassObjectGet, emitLazyProtoGet, findExternInfoForMember } from "./expressions/extern.js";
import {
  buildThrowJsErrorInstrs,
  classifyPrivateMember,
  emitPrivateBrandPredicate,
  emitThrowTypeError,
  noJsHost,
  resolveDeclaringClassForPrivateName,
} from "./expressions/helpers.js";
// (#4157) provably-dead null guards
import { type ReceiverProofHint, emitReceiverNullGuard, receiverProofHolds } from "./nonnull-proof.js";
import {
  emitIsNullishAnyAt,
  ensureAnyFromExternHelper,
  undefinedExternInstrs,
  undefinedSingletonActive,
} from "./any-helpers.js";
import {
  emitUndefined,
  ensureExternIsUndefinedImport,
  patchStructNewForAddedField,
} from "./expressions/late-imports.js";
import { emitSymbolDescLoad } from "./symbol-native.js";
import {
  addUnionImports,
  classifyTypedArrayType,
  reserveVecMethodHelper,
  resolveWasmType,
  undefinedTypedMemberReadProducesExternref,
  TYPED_ARRAY_NAMES,
  typedArrayPackedSignedness,
  typedArrayVecStorage,
} from "./index.js";
import { resolveVecHostBridgeHelper } from "./vec-access-exports.js";
import { emitJsonStringifyValue } from "./json-codec-native.js";
import { tryCompileNativeGeneratorResultProperty } from "./generators-native.js";
import { tryCompileNativeMapSizeGet } from "./map-runtime.js";
import {
  tryCompileNativeDisposableStackAnyDisposedGet,
  tryCompileNativeDisposableStackDisposedGet,
} from "./disposable-runtime.js";
import { tryCompileNativeSetSizeGet } from "./set-runtime.js";
import { tryEmitLinearU8ElementGet, tryEmitLinearU8Length } from "./linear-uint8-codegen.js";
import { tryEmitFnctorPrototypeRead } from "./expressions/fnctor-prototype.js";
import { tryEmitFnctorTypedFieldGet } from "./fnctor-typed-reads.js"; // (#4155 Phase 2) struct-typed fnctor receiver
import { ensureNativeStringHelpers, stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { emitIsUndefF64 } from "./value-tags.js";
import { tryEmitStaticI32Expression } from "./i32-static-range-expr.js";
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
import { resolveStandaloneProtoMemberValueClosure } from "./native-proto-value-read.js";
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
  emitTypedArrayIntrinsicCtorObject,
  isWiredTypedArrayViewName,
  emitNativeGlobalThisObject,
  emitGeneratorPrototypeSingleton,
} from "./array-object-proto.js";
import { isBuiltinSubtype, isBuiltinTypeName } from "./builtin-tags.js";
import {
  externrefBackedOwnFieldBacking,
  getOrRegisterErrorStructType,
  isWasiErrorName,
} from "./registry/error-types.js";
import {
  addStringConstantGlobal,
  ensureExnTag,
  localGlobalIdx,
  recordInModuleInitFlagRead,
} from "./registry/imports.js";
import { receiverIsRealmGlobalObject } from "./helpers/sloppy-this-global.js"; // (#4500 Slice A) realm-global receiver
import { dvDetachedThrowInstrs, getOrRegisterDvWindowType } from "./dataview-native.js"; // (#2159/#38) DataView windowing; (#3173) detached TypeError
import {
  getArrTypeIdxFromVec,
  getOrRegisterResizableAbType,
  getOrRegisterVecType,
  getSubviewArrTypeIdx,
  isSubviewTypeIdx,
  isTaViewTypeIdx,
  taCtorKindOf,
} from "./registry/types.js";
import {
  emitTaCtorBytesPerElement,
  emitTaDynViewElementGet,
  emitTaViewAccessor,
  emitTaViewDynamicByteLength,
  emitTaViewElementGet,
  pushTaViewEffectiveLen,
} from "./dataview-native.js"; // (#3054 B1/B2/C) shared-backing TA view read + accessor props + resize length-tracking; (#3054 D) dynamic ctor BYTES_PER_ELEMENT + dynamic view byteLength; (#3057) dynamic view element get
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
import { reserveMemberSetDispatch } from "./member-set-dispatch.js";
import { alternateFieldArmRead } from "./alternate-field-arm.js";
import { classMethodCandidatesForProp, reserveMemberGetDispatch } from "./member-get-dispatch.js";
import { resolveReceiverStruct } from "./fnctor-escape-gate.js"; // (#2681/#2686 A3) pinned-struct read dispatch
import { emitGuardedNativeStringElementGet } from "./string-element-read.js"; // (#3973) any-typed native-string element read
import { emitStringExoticIndexGet } from "./string-exotic-index.js"; // (#4232) §10.4.3.5 bounds for a statically-string receiver
import { reserveAccessorGetDriver } from "./accessor-driver.js";
import { S5C_STRUCT_ACCESSOR_CLOSURE } from "./struct-accessor-closure.js";
import { tryCompileTemporalPropertyAccess } from "./temporal-native.js";
import { emitRuntimeEvalSharedValueUnwrap, runtimeEvalSharedValueUnwrapInstrs } from "./global-environment.js";
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
  tryEmitBuiltinNamespaceConstantValue,
  tryEnsureNativeProtoBrand,
  typedArrayViewSignedness,
} from "./builtin-value-read.js"; // (#3267) built-in static/prototype VALUE-read subsystem — extracted
import {
  elementAccessTypedArrayName,
  emitNonIndexVecElementGet,
  nonArrayIndexNumericKey,
  compileElementIndexI32,
} from "./array-nonindex-key.js"; // (#4247)
// (#3267) Re-export the moved symbols other modules import from property-access.js
// so their `from "./property-access.js"` imports keep resolving unchanged.
export {
  BUILTIN_CTOR_ARITY,
  BUILTIN_CTOR_NAMES,
  emitArrayIsArrayExternrefPredicate,
  ensureStandaloneBuiltinStaticMethodClosure,
  makeBuiltinClosureFctx,
  MATH_CONSTANT_VALUES,
  NUMBER_CONSTANT_VALUES,
  TYPED_ARRAY_BYTES_PER_ELEMENT,
  tryEnsureNativeProtoBrand,
} from "./builtin-value-read.js";
import { tryBuiltinPrototypeGetterBrandThrow } from "./builtin-prototype-brand.js";
import { tryCompileFunctionPoisonRead } from "./function-poison-pill-access.js";
import { isFnctorLayoutStructName } from "./fnctor-layout-emit.js"; // (#3927) per-type layouts
import { tryEmitPrimitiveAbsentPropertyRead } from "./primitive-absent-property.js"; // (#4483) absent prop of a number/boolean primitive → undefined
import {
  finalizeStructAndDynamicMemberGet,
  PA_FALLTHROUGH,
  tryBufferViewAttributeReads,
  tryBuiltinNamespaceDeferredReads,
  tryClassExpressionStaticMemberRead,
  tryConstructorPrototypeIdentity,
  tryDynamicReceiverRuntimeDispatchReads,
  tryGlobalThisAndProcessRead,
  tryIdentifierNamespaceAndStaticReceiverRead,
  tryLengthAndNameReads,
  tryNamespaceConstantAndSymbolReads,
  tryNativeErrorMemberRead,
  tryPinnedAndDeleteAwareDynamicGet,
  tryPrivateIdentifierRead,
  tryPrototypeMethodAndArityReads,
  tryStandaloneBuiltinAndWasiMemberReads,
  tryStringLengthIteratorAndExternClassReads,
  trySuperAndImportMetaRead,
} from "./property-access-dispatch.js"; // (#3276) Wave B — extracted guard bands

/**
 * (#3037 CS1b) True when `expr` is a direct operand of a standalone
 * `any === any` / `!==` / `==` / `!=` comparison — the EXACT shape that
 * binary-ops.ts routes through the AnyValue equality dispatch
 * (`compileAnyBinaryDispatch` → `emitAnyEqOperands`), which fires only when BOTH
 * operands are statically `any` (`leftTsType.flags & Any` on both sides,
 * binary-ops.ts:1082-1090). Mirroring that gate exactly guarantees a carrier
 * produced here can only ever flow into `emitAnyEqOperands`'s `isAnyValue`
 * fast-path and never into a downstream read/store.
 *
 * (#3037 CS1b(ii)) The gate MUST mirror binary-ops' condition **byte-for-byte**:
 * the raw checker `getTypeAtLocation(operand).flags & TypeFlags.Any` on BOTH
 * sides — NOT `ctx.oracle.typeFactOf(...).kind === "any"`. The two DISAGREE for
 * element-access operands: for `const a: any = [5,5]; a[0] === a[1]` the oracle
 * reports `a[0]` as `"any"` but the checker narrows it away from the `Any` flag,
 * so binary-ops does NOT enter `compileAnyBinaryDispatch` — the `ref $AnyValue`
 * the carrier produced then lands in the raw `ref.eq` struct-identity arm
 * (binary-ops.ts:1937), which compares two freshly-allocated `$AnyValue` structs
 * → always false → value-equal numbers/strings wrongly `!==`. Using the checker
 * flag (the actual gate binary-ops keys on) fires the carrier iff the operand
 * pair truly routes through `__any_strict_eq`. Under-firing is safe (S3a
 * cross-tag reconciliation); over-firing (the oracle's failure mode) is the bug.
 */
function isAnyEqualityOperand(ctx: CodegenContext, expr: ts.Expression): boolean {
  const parent = expr.parent;
  if (!parent || !ts.isBinaryExpression(parent)) return false;
  const op = parent.operatorToken.kind;
  const isEq =
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!isEq) return false;
  if (parent.left !== expr && parent.right !== expr) return false;
  // Mirror binary-ops.ts:1082-1084 EXACTLY (the raw checker `Any` flag on both
  // operands) — this is the precise condition that routes the pair through
  // `compileAnyBinaryDispatch` → `__any_strict_eq`. See the doc-comment above for
  // why the `ctx.oracle` form over-fires on element-access operands.
  const leftAny = (ctx.checker.getTypeAtLocation(parent.left).flags & ts.TypeFlags.Any) !== 0;
  const rightAny = (ctx.checker.getTypeAtLocation(parent.right).flags & ts.TypeFlags.Any) !== 0;
  return leftAny && rightAny;
}

/**
 * (#3037 CS1b — dynamic member-read carrier) When a dynamic `any`-typed member
 * READ compiled to a bare externref and is a direct operand of a standalone
 * `any`-equality (see {@link isAnyEqualityOperand}), re-classify it through the
 * ALWAYS-honest `__any_from_extern_honest` classifier so it reaches `===` as a
 * proper `$AnyValue`: an object → **tag-6** (identity in `refval` → the tag-6
 * same-tag `ref.eq` arm answers identity), a `$BoxedNumber` → **tag-3** (value),
 * a `$BoxedBoolean` → **tag-4**, a `$AnyString` → **tag-5** (content). This flips
 * the CS0 residuals `o.a === o.b` (case b), `o.n === o.n` (case e) and
 * `gOPD.value === gOPD.value` (case a) WITHOUT touching the generic `boxToAny`
 * externref arm (−788) or the `===` operand seam (−299) — the change is purely
 * the reader's result ValType (externref → `$AnyValue`), gated to exactly the
 * shape that routes through `emitAnyEqOperands` so the carrier never reaches a
 * subsequent read/store (which `$AnyValue` would break — the CS1a finding).
 *
 * Byte-inert off-path: any precondition unmet → the bare externref is returned
 * unchanged (a half-migrated tag-6 × tag-5 pair still reconciles via S3a's
 * cross-tag arm, so partial coverage only under-fixes, never regresses).
 */
export function maybeWrapAnyReadEqualityCarrier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  result: ValType | null,
): ValType | null {
  if (!ctx.standalone) return result;
  if (!result || result.kind !== "externref") return result;
  if (!isAnyEqualityOperand(ctx, expr)) return result;
  // (#3169) The enclosing equality must be the ACTIVE `$AnyValue` dispatch
  // (recorded by binary-ops around `compileAnyBinaryDispatch`). The static
  // shape gate above mirrors binary-ops' entry CONDITION, but not its entry
  // STATE: when `$AnyValue` gets lazily registered as a side effect of THIS
  // operand's compile (e.g. the standalone dynamic-index read pulling in the
  // `__unbox_number` union native), `ctx.anyValueTypeIdx` flips ≥ 0 after
  // binary-ops already chose the plain externref equality path — wrapping then
  // hands that path a `ref $AnyValue` it compares by struct identity, so
  // value-equal operands answer a spurious `!==` (`obj[idx] !== val`, the
  // -c-ii test262 family). Requiring the live marker guarantees the carrier is
  // consumed by `__any_strict_eq` and nothing else; under-firing stays safe
  // (bare externref → the chosen path's own equality semantics).
  if (ctx.activeAnyEqDispatchExpr !== expr.parent) return result;
  // (#3037 CS1b(ii)) Mirror binary-ops.ts:1081's `ctx.anyValueTypeIdx >= 0` guard,
  // and check it BEFORE `ensureAnyFromExternHelper` (which lazily REGISTERS the
  // `$AnyValue` type as a side effect). binary-ops routes an `any===any` pair
  // through the `__any_strict_eq` dispatch only when `anyValueTypeIdx >= 0` at the
  // binary expression's entry; the carrier runs later, during operand compilation.
  // If the carrier registered-then-fired when the type was still unregistered, it
  // would hand binary-ops a `ref $AnyValue` for a pair binary-ops already decided
  // to compile down its numeric path — landing in the raw `ref.eq` struct-identity
  // arm (binary-ops.ts:1937), which compares two freshly-allocated `$AnyValue`
  // structs and returns a spurious `!==` for value-equal numbers/strings (e.g.
  // `const a: any = [5,5]; a[0] === a[1]`, where the module never otherwise
  // registers `$AnyValue`). Staying inert here leaves the bare externref, which
  // binary-ops' externref-equality path answers correctly (and S3a reconciles any
  // half-migrated pair) — never a regression, only under-fixing.
  if (ctx.anyValueTypeIdx < 0) return result;
  const classifyIdx = ensureAnyFromExternHelper(ctx, { forceHonest: true });
  if (classifyIdx === undefined) return result;
  fctx.body.push({ op: "call", funcIdx: classifyIdx });
  return { kind: "ref", typeIdx: ctx.anyValueTypeIdx };
}

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
export function isAnonymousFunctionDefinition(expr: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isFunctionExpression(expr) && !expr.name) return true;
  if (ts.isArrowFunction(expr)) return true;
  if (ts.isClassExpression(expr) && !expr.name) return true;
  return false;
}

/**
 * (#2756) ES §15.7.14 ClassDefinitionEvaluation defines a class's static
 * elements AFTER the optional SetFunctionName(F, className) step, so a class that
 * declares its own `static name` member (method / property / accessor) ends up
 * with that member as `F.name` — the NamedEvaluation-supplied binding name is
 * OVERRIDDEN. Likewise a *named* class expression keeps its own name. This
 * compiler synthesises `<id>.name` statically from the binding initializer; for
 * such classes that synthesis must NOT return the binding identifier text. Used
 * to gate the NamedEvaluation synthesis sites below (matches test262
 * `*-init-fn-name-class` whose `xCls2 = class { static name() {} }` asserts
 * `xCls2.name !== 'xCls2'`).
 */
export function classExpressionDefinesOwnName(expr: ts.Expression): boolean {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isClassExpression(e)) return false;
  if (e.name) return true; // named class expression keeps its own name
  return e.members.some((m) => {
    if (
      !ts.isPropertyDeclaration(m) &&
      !ts.isMethodDeclaration(m) &&
      !ts.isGetAccessorDeclaration(m) &&
      !ts.isSetAccessorDeclaration(m)
    ) {
      return false;
    }
    const isStatic = m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword) ?? false;
    return isStatic && m.name !== undefined && ts.isIdentifier(m.name) && m.name.text === "name";
  });
}

const LOGICAL_ASSIGNMENT_TOKENS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * (#2201) ES §13.15.2 NamedEvaluation for the logical-assignment operators
 * (`&&=`, `||=`, `??=`): when the LHS is a bare IdentifierReference and the RHS
 * is an *anonymous* function/arrow/class definition, the resulting function
 * inherits the LHS identifier as its `.name`.
 *
 * This compiler resolves `.name` statically from a binding's initializer, which
 * misses the logical-assignment form (`var value = 1; value &&= function(){}`)
 * because the variable's initializer is not the function. Here we scan the
 * declaration's source for a logical-assignment `<id> &&=/||=/??= <fn>` targeting
 * the same symbol and apply NamedEvaluation. A *named* function/class RHS keeps
 * its own name (the LHS identifier is ignored, per spec).
 *
 * Returns the inferred `.name` string, or undefined when no qualifying
 * logical-assignment is found.
 */
export function resolveLogicalAssignmentName(
  ctx: CodegenContext,
  id: ts.Identifier,
  sym: ts.Symbol,
): string | undefined {
  const sourceFile = id.getSourceFile();
  let resolved: string | undefined;
  const visit = (node: ts.Node): void => {
    if (resolved !== undefined) return;
    if (
      ts.isBinaryExpression(node) &&
      LOGICAL_ASSIGNMENT_TOKENS.has(node.operatorToken.kind) &&
      ts.isIdentifier(node.left) &&
      ctx.checker.getSymbolAtLocation(node.left) === sym
    ) {
      let rhs: ts.Expression = node.right;
      while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
      if (isAnonymousFunctionDefinition(rhs)) {
        resolved = id.text;
        return;
      }
      if (ts.isFunctionExpression(rhs) && rhs.name) {
        resolved = rhs.name.text;
        return;
      }
      if (ts.isClassExpression(rhs) && rhs.name) {
        resolved = rhs.name.text;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return resolved;
}

/**
 * (#2201) True when `node` is a `<id>.name` read whose receiver `<id>` is the
 * target of a logical-assignment NamedEvaluation (`id &&=/||=/??= <fn>`). Such a
 * read lowers (via the property-access `.name` static resolver above) to a
 * native-string ref, but the receiver's *TS* type is `number`/`any`, so an
 * equality like `id.name === "x"` would otherwise fall through to `ref.eq`
 * (struct identity → always false). Used by the binary-op equality dispatch to
 * route it to content-based string equality — mirrors the catch-bound Error
 * `.message`/`.name`/`.stack` handling (#2192).
 */
export function isLogicalAssignNamedEvalNameRead(ctx: CodegenContext, node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (node.name.text !== "name") return false;
  const recv = node.expression;
  if (!ts.isIdentifier(recv)) return false;
  const sym = ctx.checker.getSymbolAtLocation(recv);
  if (!sym) return false;
  return resolveLogicalAssignmentName(ctx, recv, sym) !== undefined;
}

/**
 * (#2743 b) Is `expr` a syntactic `Symbol.iterator` member access? Used by the
 * vec computed-get to route `vec[Symbol.iterator]` to %Array.prototype.values%
 * instead of coercing the Symbol key to a numeric index (which ToNumber-throws
 * "Cannot convert a Symbol value to a number"). Matches the same syntactic gate
 * `getWellKnownSymbolId` uses (`Symbol.iterator` as a bare identifier member),
 * so a locally-shadowed `Symbol` is not special-cased here either.
 */
function isSymbolIteratorKey(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Symbol" &&
    expr.name.text === "iterator"
  );
}

const DESCRIPTOR_FLAG_ACCESSOR = 1 << 4;

export function runtimeAccessorDescriptorKey(
  ctx: CodegenContext,
  receiver: ts.Expression,
  propName: string,
): string | undefined {
  if (!ts.isIdentifier(receiver)) return undefined;
  // (#3403) definedPropertyFlags is per-declaration keyed; sidecar stays bare.
  const dpfKey = `${integrityVarKey(ctx, receiver)}:${propName}`;
  const bareKey = `${receiver.text}:${propName}`;
  const flags = ctx.definedPropertyFlags.get(dpfKey);
  if (flags !== undefined && (flags & DESCRIPTOR_FLAG_ACCESSOR) !== 0 && ctx.sidecarDefinedPropertyKeys.has(bareKey)) {
    return bareKey;
  }

  // (#3782) A function-constructor instance can have a same-named inferred
  // struct field even though Object.defineProperties installed that name on
  // its prototype at runtime. The whole-program fnctor analysis already
  // resolves descriptor-map keys; route those reads through the native
  // prototype sidecar before the inferred field fast path.
  const receiverTypeName = ctx.fnctorEscapeGate?.receiverStruct.get(receiver) ?? ctx.oracle.declaredNameOf(receiver);
  const receiverOwner = receiverTypeName?.startsWith("__fnctor_")
    ? receiverTypeName.slice("__fnctor_".length)
    : receiverTypeName;
  if (receiverOwner && ctx.fnctorEscapeGate?.protoMethodWriteOnce.runtimeDefined.get(receiverOwner)?.has(propName)) {
    return bareKey;
  }
  if (
    ctx.standalone &&
    [...(ctx.fnctorEscapeGate?.protoMethodWriteOnce.runtimeDefined.values() ?? [])].some((keys) => keys.has(propName))
  ) {
    return bareKey;
  }
  if (ctx.standalone) {
    let installedOnFnctorPrototype = false;
    const visitPrototypeDescriptors = (node: ts.Node): void => {
      if (installedOnFnctorPrototype) return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Object" &&
        node.expression.name.text === "defineProperties" &&
        ts.isPropertyAccessExpression(node.arguments[0]) &&
        node.arguments[0].name.text === "prototype"
      ) {
        const descriptors = node.arguments[1];
        if (descriptors && ts.isIdentifier(descriptors)) {
          const declaration = ctx.oracle.variableDeclarationOf(descriptors);
          const initializer = declaration?.initializer;
          if (
            initializer &&
            ts.isObjectLiteralExpression(initializer) &&
            initializer.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
                property.name.text === propName,
            )
          ) {
            installedOnFnctorPrototype = true;
            return;
          }
        }
      }
      ts.forEachChild(node, visitPrototypeDescriptors);
    };
    visitPrototypeDescriptors(receiver.getSourceFile());
    if (installedOnFnctorPrototype) return bareKey;
  }

  // The source fallback below exists for module globals whose function bodies
  // are emitted before the second module-init pass rebuilds descriptor state.
  // Function-local class instances are compiled in statement order and may use
  // the native classAccessorSet path; forcing those through __extern_get would
  // bypass their compiled getter/setter functions.
  if (!ctx.moduleGlobals.has(receiver.text)) return undefined;

  // (#3374) Function bodies can be emitted before the second module-init pass
  // has rebuilt the descriptor bookkeeping above. Recognize the same static
  // Object.defineProperty accessor shape from the source so a read following a
  // rejected strict write still invokes the installed getter instead of reading
  // the widened struct's placeholder slot.
  const receiverSymbol = ctx.checker.getSymbolAtLocation(receiver);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "defineProperty" &&
      node.arguments.length >= 3
    ) {
      const objectArg = skipTransparentExpressions(node.arguments[0]!);
      const keyArg = skipTransparentExpressions(node.arguments[1]!);
      const descriptorArg = skipTransparentExpressions(node.arguments[2]!);
      const sameReceiver =
        ts.isIdentifier(objectArg) &&
        (receiverSymbol
          ? ctx.checker.getSymbolAtLocation(objectArg) === receiverSymbol
          : objectArg.text === receiver.text);
      const definedKey =
        ts.isStringLiteral(keyArg) || ts.isNumericLiteral(keyArg)
          ? keyArg.text
          : resolveComputedKeyExpression(ctx, keyArg);
      const isAccessor =
        ts.isObjectLiteralExpression(descriptorArg) &&
        descriptorArg.properties.some((property) => {
          if (!property.name) return false;
          if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) return false;
          return property.name.text === "get" || property.name.text === "set";
        });
      if (sameReceiver && definedKey === propName && isAccessor) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(receiver.getSourceFile());
  return found ? bareKey : undefined;
}

export function emitRuntimeDescriptorGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  propName: string,
  accessNode: ts.Expression,
  forceExternref = false,
): ValType | null {
  const accessType = ctx.checker.getTypeAtLocation(accessNode);
  const accessWasm = resolveWasmType(ctx, accessType);
  // (#2071-adjacent, ES5 defineProperty lane) STANDALONE keeps the honest
  // externref: this path reads RUNTIME descriptor state, and an accessor whose
  // [[Get]] was later redefined (even to undefined, §6.2.5.6 present-undefined)
  // can produce a value the checker's static member type never saw — narrowing
  // here dragged a canonical `undefined` through `__unbox_number` to NaN, so
  // `typeof obj.prop` answered "number" after `{get: undefined}` (15.2.3.6-4-498
  // family). A numeric consumer re-narrows through its own coercion.
  const resultType: ValType =
    !forceExternref && !ctx.standalone && (accessWasm.kind === "f64" || accessWasm.kind === "i32")
      ? accessWasm
      : { kind: "externref" };
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
    fctx.body.push({ op: "extern.convert_any" });
  } else if (recvType.kind === "ref") {
    fctx.body.push({ op: "extern.convert_any" });
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
export function isBindResultExpr(ctx: CodegenContext, expr: ts.Expression): boolean {
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
  // (#2937) The evolved checker type of a poisoned `$Object`-hash-consumer
  // `{}` var never resolves to a struct — receivers of that type route through
  // the externref host-MOP path (see resolveWasmType's matching guard).
  if (ctx.objectHashConsumerTypes.has(tsType)) return undefined;
  const exactClassExpression = exactClassExpressionTypeName(ctx, tsType);
  if (exactClassExpression) return exactClassExpression;
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
 * (#2837) True if `expr` is a property-access chain whose ROOT identifier is a
 * growable-object-literal var. Such a var is an externref `$Object`, so reading a
 * member off it (`o.inner`) yields a nested externref `$Object` too — therefore a
 * further member access (`o.inner.get = fn`, the acorn descriptor write) must ALSO
 * route through the externref host path, not the receiver's static struct type
 * (which would `struct.set`/`drop` the out-of-shape field). Scoped to
 * `growableObjectLiteralVars` (not all externref vars) to keep the #2837 change
 * from perturbing unrelated accessor/Proxy member dispatch.
 */
export function chainRootIsGrowable(ctx: CodegenContext, expr: ts.Expression): boolean {
  let e: ts.Expression = expr;
  for (;;) {
    while (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e)
    ) {
      e = (e as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
    }
    if (ts.isPropertyAccessExpression(e)) {
      e = e.expression;
      continue;
    }
    break;
  }
  return ts.isIdentifier(e) && ctx.growableObjectLiteralVars.has(e.text);
}

/**
 * (#671 W1) Is this direct member receiver the exact declaration selected by
 * the IR `with` planner? Unlike `chainRootIsGrowable`, this is deliberately
 * declaration-keyed: opening `outer.target` must not change a shadowed
 * `target` in another function.
 */
export function isIrWithOpenObjectTargetReceiver(ctx: CodegenContext, expr: ts.Expression): boolean {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  if (!ts.isIdentifier(e)) return false;
  const key = resolveWidenedVarKey(ctx, e);
  return key !== undefined && ctx.irWithOpenObjectTargetKeys.has(key);
}

/**
 * Resolve a struct name for a property access/assignment target expression,
 * with fallbacks for widened variables and `this` in function constructors.
 */
export function resolveStructNameForExpr(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: ts.Expression,
  // (#2838 L5) The member being accessed off `expression`, when known. A PRIVATE
  // identifier (`this.#x`) must keep its exact static struct resolution (brand-
  // checked WasmGC private dispatch — the host MOP can never see it), so the L5
  // `__anon`-`this` override is suppressed for private accesses.
  accessedMember?: ts.MemberName,
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
  // (#2838 L5) `this`-receiver: override the TS type with the runtime truth ONLY
  // for the descriptor-literal LIE — otherwise behave EXACTLY as the original path
  // below (no behavior change for any genuine struct, class instance, or static
  // receiver). Inside a runtime-installed accessor getter
  // (`Object.defineProperties(Proto, { f:{ get: function(){ return this.flags } } })`)
  // TS contextually types the getter's `this` as the descriptor literal object
  // (`{configurable:boolean}` → `__anon_N`), so `resolveStructName` would lower
  // `this.<x>` against that WRONG struct and read a default slot (the round-5/6
  // "getter fires but returns 0/null" bug). When — and only when — the TS type of
  // `this` resolves to such an `__anon` descriptor, use the fctx `this` local's
  // actual ref type instead (a dynamic getter's local is externref →
  // `resolveThisStructName` undefined → fully dynamic host MOP, which consults the
  // runtime-installed accessor). For every other `this` (class instance methods,
  // STATIC methods whose `this` is the class object, real fnctor methods) this
  // guard does NOT trigger and the unchanged original resolution runs — critical
  // for brand-checked private/static class-element dispatch, which must keep its
  // exact struct resolution.
  // (#2838 L5) `this`-receiver: override the TS type with the runtime truth ONLY
  // for the descriptor-literal LIE on a PUBLIC member — otherwise behave EXACTLY
  // as the original path below. Inside a runtime-installed accessor getter/setter
  // (`Object.defineProperties(Proto, { f:{ get/set: function(){ … this.x … } } })`)
  // TS contextually types `this` as the descriptor literal object
  // (`{configurable:boolean}` → `__anon_N`), so `resolveStructName` would lower
  // `this.<x>` against that WRONG struct and read/write a default slot (the
  // round-5/6 "getter fires but returns 0/null" bug, and the setter-write analog).
  // When the TS type of `this` resolves to such an `__anon` descriptor, use the
  // fctx `this` local's actual ref type instead (a dynamic accessor's local is
  // externref → `resolveThisStructName` undefined → fully dynamic host MOP). This
  // is SUPPRESSED for a private member (`this.#x`): a static/instance method whose
  // `this` also TS-resolves to `__anon` must keep its exact struct resolution so
  // brand-checked private dispatch is not diverted to the host MOP (which cannot
  // see private elements). Every non-`__anon` `this` falls through unchanged.
  if (bareIdent.kind === ts.SyntaxKind.ThisKeyword && !(accessedMember && ts.isPrivateIdentifier(accessedMember))) {
    const tsName = resolveStructName(ctx, ctx.checker.getTypeAtLocation(expression));
    // Match ONLY the descriptor-literal anon struct (`__anon_<n>`), NOT an
    // anonymous CLASS struct (`__anonClass_<n>`). A class with static private
    // elements TS-resolves `this` to `__anonClass_0`; that is a genuine struct
    // whose brand-checked private/static dispatch must keep its exact resolution —
    // matching it diverted the static private setter `this.#x = v` to the host MOP
    // (`__extern_set_strict`), the #2325 regression. Descriptor literals are
    // `__anon_<n>` (the acorn `prototypeAccessors` getter's `this`).
    if (tsName !== undefined && tsName.startsWith("__anon_")) {
      return resolveThisStructName(ctx, fctx);
    }
    // else: fall through to the original behavior unchanged.
  }
  // (#2837) A member access on a chain rooted at a growable-object-literal var
  // (`o.inner` / `o.inner.get`) operates on a nested externref `$Object` →
  // force the externref host path so out-of-shape writes/reads land.
  if (chainRootIsGrowable(ctx, expression)) {
    return undefined;
  }
  const objType = ctx.checker.getTypeAtLocation(expression);
  let typeName = resolveStructName(ctx, objType);
  if (!typeName && ts.isIdentifier(expression)) {
    // (#3364) resolve to the receiver's declaration key, not the bare name.
    const key = resolveWidenedVarKey(ctx, expression);
    if (key !== undefined) typeName = ctx.widenedVarStructMap.get(key);
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
    // (#2837) member access on a chain rooted at a growable-object-literal var
    // → nested externref `$Object`, force the host path.
    if (chainRootIsGrowable(ctx, expression)) {
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
export function emitGetterCallWithDummy(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  getterName: string,
  funcIdx: number,
): ValType | null {
  if (!emitDummyStruct(ctx, fctx, className)) return null;
  fctx.body.push({ op: "call", funcIdx });
  // Determine return type from the getter's function type
  const funcDef = definedFuncAt(ctx, funcIdx);
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
  const detail =
    line > 0 && col > 0
      ? `Cannot access property on null or undefined at ${line}:${col}`
      : "Cannot access property on null or undefined";
  // (#4262) In no-JS-host mode throw a REAL `$Error_struct` TypeError instead
  // of a bare string whose text merely begins with "TypeError: ".
  //
  // The string form made `catch (e) { e instanceof TypeError }` answer false
  // and made the upstream harness's `assert.throws(TypeError, fn)` reject the
  // throw before it ever compares constructors (`typeof thrown !== 'object'`
  // short-circuits to "Thrown value was not an object!"). Measured on the ES5
  // standalone failing set: 19 `e instanceof TypeError` files plus 2
  // `assert.throws(TypeError, …)` files carry exactly this signature.
  //
  // `forceInModuleCtor` is load-bearing, not an optimisation: it resolves
  // `__new_TypeError` purely through `ctx.funcMap` after
  // `emitWasiErrorConstructor` has minted it, so NO `ensureLateImport` runs.
  // That matters because this builder is called from inside half-built `then:`
  // arrays with no `fctx` to flush against — an import registration here would
  // be the #1839/#117/#1886 index-shift trap. A defined function minted via
  // `mintDefinedFunc` carries a STABLE handle (#1916 S3) that no shifter
  // renumbers, so appending one mid-body is safe.
  //
  // The rendered text is UNCHANGED: `__error_to_string` (#2962, §20.5.3.4)
  // renders `$name + ": " + $message`, and `$name` is "TypeError" — so an
  // uncaught throw still surfaces as "TypeError: Cannot access property on null
  // or undefined at L:C" and the runner's signature classification is stable.
  // Hence the "TypeError: " prefix moves OUT of the message here.
  //
  // JS-host mode keeps the string throw (its `__new_TypeError` is an `env`
  // import, which cannot be registered from here) — the gc lane is
  // byte-identical.
  if (noJsHost(ctx)) {
    return buildThrowJsErrorInstrs(ctx, "TypeError", detail, { forceInModuleCtor: true });
  }
  const message = `TypeError: ${detail}`;
  // Register the literal: in legacy mode this adds a `string_constants` global
  // import; in nativeStrings mode it just records the value with sentinel -1
  // so call sites can materialize it inline (#1174).
  addStringConstantGlobal(ctx, message);
  const tagIdx = ensureExnTag(ctx);
  return [...stringConstantExternrefInstrs(ctx, message), { op: "throw", tagIdx }];
}

/**
 * Emit a null check on the ref currently on the stack. If null, throws
 * TypeError via the exception tag. If non-null, the ref remains on the stack.
 * The `refType` should be the nullable ref type of the value on the stack.
 *
 * Stack: [ref_null T] -> [ref_null T]  (non-null at runtime after this point)
 *
 * (#4157) `proof` lets a caller that KNOWS the receiver's pre-coercion ValType
 * and source expression offer them for the provably-non-null test. When it
 * holds the whole sequence is skipped — the value is already on the stack,
 * which is exactly this function's postcondition.
 */
export function emitNullCheckThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  refType: ValType,
  node?: ts.Node,
  proof?: ReceiverProofHint,
): void {
  const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;
  if (receiverProofHolds(ctx, fctx, proof, (e) => isProvablyNonNull(e, ctx.checker))) return;

  const tmp = allocTempLocal(fctx, refType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  if (backupLocal !== undefined) {
    // A guarded cast backup exists: the null might be from a failed ref.cast
    // (wrong struct type), not from a genuinely null value.  Only throw
    // TypeError when the ORIGINAL pre-cast value was also NULLISH (#789).
    //
    // (#4489) "Nullish", not "null": under the #2106 S1 regime `undefined` is a
    // tag-1 `$AnyValue` singleton, which is a NON-null reference. Testing only
    // `ref.is_null` here reads a real `undefined` as "some other struct type —
    // don't throw", and the caller's `struct.get` on the null cast result then
    // TRAPS. A wasm trap is not catchable by wasm exception handling, so
    // `try { f(); } catch (e) { e instanceof TypeError }` — the shape of
    // `language/statements/function/S13_A17_T1.js` — dies instead of passing.
    // This was already reachable for FUNCTION-scope `var f = function(){}`
    // called before its initializer (the #737 hoister has seeded `undefined`
    // there for years, measured trapping on both sides of #4489's A/B); seeding
    // module globals made module scope reach it too, which is how the corpus
    // sweep caught it.
    const savedForNullish = pushBody(fctx);
    const widened = emitIsNullishAnyAt(ctx, fctx, backupLocal);
    const nullishTest: Instr[] = widened ? fctx.body : [{ op: "local.get", index: backupLocal }, { op: "ref.is_null" }];
    popBody(fctx, savedForNullish);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...nullishTest,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: typeErrorThrowInstrs(ctx, node),
          else: [], // wrong struct type — don't throw
        },
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
 * (#2655) Symmetric WRITE counterpart to the read-side multi-struct dispatch
 * (`findAlternateStructsForField` + `struct.get` chain at the `__extern_get`
 * fallback). The member-READ path resolves `any`/`externref` receivers that are
 * actually typed WasmGC structs via `struct.get <slot>`; the member-WRITE path
 * historically went straight to `__extern_set`, which `_safeSet` routes to a
 * JS-side SIDECAR map — it CANNOT write the WasmGC struct slot. Result: reads
 * see the slot, writes update the sidecar, and the two diverge (acorn's
 * `this.pos += 1` loop never advances → infinite loop).
 *
 * This emits, for each struct candidate that has a field named `propName`:
 *   local.get <recvAnyLocal>
 *   ref.test <structTypeIdx>
 *   (if (then  local.get recvAny; ref.cast struct; local.get <valExtLocal>;
 *              <coerce externref -> fieldType>; struct.set struct <slot> )
 *       (else  <next candidate, or the externSetFallback> ))
 *
 * `recvAnyLocal` must hold the receiver as `anyref` (caller does
 * `local.get objExt; any.convert_extern; local.set recvAny`). `valExtLocal`
 * holds the value as `externref` (boxed). `externSetFallback` is the terminal
 * else-arm (the existing `__extern_set`/`__extern_set_strict` sequence) — still
 * required for genuine host externrefs and dynamic-only (sidecar) properties.
 *
 * Returns `true` if at least one struct.set arm was emitted (caller must NOT
 * also emit its own `__extern_set` — it's already the else-arm here), or `false`
 * when there are no struct candidates (caller emits its `__extern_set` as
 * before).
 */
export function emitAlternateStructSetDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvExtLocal: number,
  valExtLocal: number,
  propName: string,
  strict: boolean,
): boolean {
  // (#2664) Route the write through a DEFERRED-FILL dispatcher
  // `__set_member_<name>(recv, val)` instead of inlining the `ref.test`/
  // `struct.set` candidate chain here. The inline chain froze its struct-
  // candidate set at THIS write's compile time; a field-writing closure compiled
  // before a later-registered struct type for the same logical object (acorn's
  // Parser gets two struct shapes — `$__anon_5` then `$__fnctor_Parser`) only got
  // the earlier candidate's arm, so the real instance failed every `ref.test` and
  // the write leaked to the sidecar while reads used the slot → non-termination.
  // The dispatcher is FILLED at finalize (`fillMemberSetDispatch`) when the full
  // struct-type table is known, so every write site enumerates the COMPLETE
  // candidate set regardless of compile order. The dispatcher's terminal else-arm
  // is the `__extern_set_strict` (strict) / `__extern_set` (non-strict) sidecar —
  // so the caller need NOT emit its own fallback. The MUTABLE-only filter and the
  // immutable boxed-wrapper (#2657) handling live in the fill.
  const dispIdx = reserveMemberSetDispatch(ctx, propName, strict, fctx);
  if (dispIdx === undefined) return false;
  // recv is externref; the dispatcher does `any.convert_extern` + `ref.test`
  // internally and forwards the externref recv to the sidecar fallback.
  fctx.body.push({ op: "local.get", index: recvExtLocal });
  fctx.body.push({ op: "local.get", index: valExtLocal });
  fctx.body.push({ op: "call", funcIdx: dispIdx });
  return true;
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
): {
  structTypeIdx: number;
  fieldIdx: number;
  fieldType: ValType;
  mutable: boolean;
  presenceSlot?: PresenceSlot;
  shapeId?: number;
  shapeFieldIdx?: number;
}[] {
  const result: {
    structTypeIdx: number;
    fieldIdx: number;
    fieldType: ValType;
    mutable: boolean;
    presenceSlot?: PresenceSlot;
    shapeId?: number;
    shapeFieldIdx?: number;
  }[] = [];
  for (const [typeName, fields] of ctx.structFields) {
    const sIdx = ctx.structMap.get(typeName);
    if (sIdx === undefined || sIdx === excludeTypeIdx) continue;
    // (#3927) A hot/cold-split fnctor's `__cold` tail is a private payload, not
    // a receiver shape: an arm keyed on `ref.test $…__cold` is dead at best and
    // — because WasmGC canonicalizes structurally identical structs — capable
    // of matching the WRONG shape at worst. Cold fields are reached through the
    // owner's `$cold` slot (`findColdStructsForField`).
    if (typeName.endsWith("__cold")) continue;
    // (#3927 per-type layouts) Same reasoning, doubled. The `__resid` carrier
    // is a private payload like the cold tail. The `__lay<k>` siblings ARE
    // receivers, but two layouts with identical field kinds share ONE
    // canonical wasm type, so a bare `ref.test` candidate arm would read
    // another field's slot; layout arms need the `$shape` stamp guard and are
    // appended explicitly by the dispatcher fills (`layoutFieldReadArm` /
    // `residFieldReadArm` in fnctor-layout-emit.ts). Their field KINDS still
    // feed the Phase-3 narrowing vote via `findFnctorLayoutStructsForField` /
    // `findFnctorResidStructsForField` — hiding a carrier from the arms is
    // correct; hiding it from the vote is the #4217 `generator` defect.
    if (typeName.endsWith("__resid") || isFnctorLayoutStructName(typeName)) continue;
    const fIdx = fields.findIndex((f) => f.name === propName);
    if (fIdx !== -1) {
      const shapeId = ctx.shapeIdByStructName.get(typeName);
      const shapeFieldIdx = shapeId !== undefined ? fields.findIndex((f) => f.name === "$shape") : -1;
      result.push({
        structTypeIdx: sIdx,
        fieldIdx: fIdx,
        fieldType: fields[fIdx]!.type,
        mutable: fields[fIdx]!.mutable,
        ...(presenceSlotOf(fields, propName) ? { presenceSlot: presenceSlotOf(fields, propName)! } : {}),
        ...(shapeId !== undefined && shapeFieldIdx >= 0 ? { shapeId, shapeFieldIdx } : {}),
      });
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
  proof?: ReceiverProofHint,
): void {
  // For result type in the if block, normalize ref to ref_null so the null branch is valid
  const resultType: ValType =
    fieldType.kind === "ref" ? { kind: "ref_null", typeIdx: (fieldType as any).typeIdx } : fieldType;
  // (#4157) Ask once, up front: a receiver whose wasm value cannot be null
  // makes both null arms below dead.
  const provenNonNull = receiverProofHolds(ctx, fctx, proof, (e) => isProvablyNonNull(e, ctx.checker));
  let primaryPresenceSlot: PresenceSlot | undefined;
  if (propName) {
    for (const [structName, fields] of ctx.structFields) {
      if (ctx.structMap.get(structName) !== typeIdx) continue;
      if (fields[fieldIdx]?.presenceTracked) primaryPresenceSlot = presenceSlotOf(fields, propName);
      break;
    }
  }
  const absentValueInstrs = (): Instr[] =>
    resultType.kind === "externref"
      ? (undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }])
      : defaultValueInstrs(resultType);

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
    if (
      objType.kind === "ref_null" &&
      (objType as { typeIdx: number }).typeIdx === typeIdx &&
      (!ctx.standalone || (fctx as any).__lastGuardedCastBackup === undefined)
    ) {
      const tmp = allocLocal(fctx, `__ng_${fctx.locals.length}`, objType);
      // (#4157) Proven non-null: emit the else-arm directly. The `if` block's
      // value type IS `resultType`, so the arm alone leaves exactly the same
      // one value on the stack that the block would have.
      const readInstrs: Instr[] =
        primaryPresenceSlot !== undefined
          ? [
              { op: "local.get", index: tmp },
              ...presenceTestInstrs(typeIdx, primaryPresenceSlot),
              {
                op: "if",
                blockType: { kind: "val", type: resultType },
                then: [
                  { op: "local.get", index: tmp },
                  { op: "struct.get", typeIdx, fieldIdx },
                ],
                else: absentValueInstrs(),
              },
            ]
          : [
              { op: "local.get", index: tmp },
              { op: "struct.get", typeIdx, fieldIdx },
            ];
      if (provenNonNull) {
        fctx.body.push({ op: "local.set", index: tmp });
        fctx.body.push(...readInstrs);
        return;
      }
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val" as const, type: resultType },
        then: typeErrorThrowInstrs(ctx),
        else: readInstrs,
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
        // null = this shape cannot produce `resultType`; skip the arm.
        const altRead = alternateFieldArmRead(ctx, fctx, alt, resultType, srcLocal);
        if (!altRead) return buildFallback(srcLocal, altIdx + 1);
        return [
          { op: "local.get", index: srcLocal },
          { op: "ref.test", typeIdx: alt.structTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...(alt.presenceSlot !== undefined
                ? ([
                    { op: "local.get", index: srcLocal },
                    { op: "ref.cast", typeIdx: alt.structTypeIdx },
                    ...presenceTestInstrs(alt.structTypeIdx, alt.presenceSlot),
                    {
                      op: "if",
                      blockType: { kind: "val", type: resultType },
                      then: altRead,
                      else: absentValueInstrs(),
                    },
                  ] satisfies Instr[])
                : altRead),
              { op: "local.set", index: resultLocal },
            ],
            else: buildFallback(srcLocal, altIdx + 1),
          },
        ];
      }
      // No more inline alternates. (#2674) The inline `alternates` set was frozen
      // at THIS read's compile time — a struct type registered later (acorn's
      // `$__fnctor_Parser`) is missing, so a read of the real (later-type)
      // instance would give up to the default here → stale `undefined` while the
      // #2664 deferred WRITE hit the slot (read/write divergence → the acorn
      // expression-parse non-termination). Route the terminal through the
      // deferred-fill `__get_member_<name>` dispatcher, which enumerates the
      // COMPLETE candidate set at finalize. Coerce its uniform externref result
      // to `resultType`. Falls back to the default only if the dispatcher can't
      // be reserved.
      // (#2043 hardening) Pass fctx so the dispatcher's late-import additions
      // flush against THIS body before we bake `getDispIdx` into the detached
      // return array + run the follow-on coercion (see member-get-dispatch.ts).
      const getDispIdx = propName ? reserveMemberGetDispatch(ctx, propName, fctx) : undefined;
      if (getDispIdx !== undefined) {
        return [
          { op: "local.get", index: srcLocal },
          { op: "extern.convert_any" },
          { op: "call", funcIdx: getDispIdx },
          ...coercionInstrs(ctx, { kind: "externref" }, resultType, fctx),
          { op: "local.set", index: resultLocal },
        ];
      }
      // No dispatcher — return default value (legacy behaviour).
      return [...defaultValueInstrs(resultType), { op: "local.set", index: resultLocal }];
    };

    // Check if emitGuardedRefCast saved a pre-cast backup (#792).
    // When the guarded cast failed (wrong struct type), the value on
    // the stack is ref.null but the backup anyref still holds the
    // original value which may match an alternate struct type.
    const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;

    // Null check: if the value is genuinely null, throw TypeError (#728)
    // But if the backup is available and non-null, use it for multi-struct dispatch
    //
    // (#4157) The whole block is `blockType: empty` with an empty else, so when
    // the receiver is proven non-null it contributes nothing and is skipped
    // wholesale. `provenNonNull` already excludes the guarded-cast case, which
    // is the one where this null does NOT mean "null receiver".
    if (!provenNonNull) {
      fctx.body.push({ op: "local.get", index: tmpAny });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then:
          backupLocal !== undefined
            ? ([
                // Value is null — could be wrong struct type or genuinely null.
                // Check the backup anyref to distinguish.
                { op: "local.get", index: backupLocal },
                { op: "ref.is_null" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  // Backup is also null → genuinely null, throw TypeError
                  then: typeErrorThrowInstrs(ctx),
                  // Backup is non-null → wrong struct type, try primary + alternates on backup
                  else: [
                    { op: "local.get", index: backupLocal },
                    { op: "ref.test", typeIdx },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        ...(primaryPresenceSlot !== undefined
                          ? ([
                              { op: "local.get", index: backupLocal },
                              { op: "ref.cast", typeIdx },
                              ...presenceTestInstrs(typeIdx, primaryPresenceSlot),
                              {
                                op: "if",
                                blockType: { kind: "val", type: resultType },
                                then: [
                                  { op: "local.get", index: backupLocal },
                                  { op: "ref.cast", typeIdx },
                                  { op: "struct.get", typeIdx, fieldIdx },
                                ],
                                else: absentValueInstrs(),
                              },
                            ] satisfies Instr[])
                          : ([
                              { op: "local.get", index: backupLocal },
                              { op: "ref.cast", typeIdx },
                              { op: "struct.get", typeIdx, fieldIdx },
                            ] satisfies Instr[])),
                        { op: "local.set", index: resultLocal },
                      ],
                      else: buildFallback(backupLocal, 0),
                    },
                  ],
                },
              ] satisfies Instr[])
            : typeErrorThrowInstrs(ctx),
        else: [],
      });
    }

    // Non-null path: try primary struct type on the original value
    fctx.body.push({ op: "local.get", index: tmpAny });
    fctx.body.push({ op: "ref.test", typeIdx });

    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...(primaryPresenceSlot !== undefined
          ? ([
              { op: "local.get", index: tmpAny },
              { op: "ref.cast", typeIdx },
              ...presenceTestInstrs(typeIdx, primaryPresenceSlot),
              {
                op: "if",
                blockType: { kind: "val", type: resultType },
                then: [
                  { op: "local.get", index: tmpAny },
                  { op: "ref.cast", typeIdx },
                  { op: "struct.get", typeIdx, fieldIdx },
                ],
                else: absentValueInstrs(),
              },
            ] satisfies Instr[])
          : ([
              { op: "local.get", index: tmpAny },
              { op: "ref.cast", typeIdx },
              { op: "struct.get", typeIdx, fieldIdx },
            ] satisfies Instr[])),
        { op: "local.set", index: resultLocal },
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
    else: [
      { op: "local.get", index: tmp },
      { op: "struct.get", typeIdx, fieldIdx },
    ],
  });
}

/**
 * (#3039) Resolve a name to a DIRECT boxed captured global — a
 * transitively-captured mutable local that a method-shorthand / class-method /
 * class-accessor body reads or writes itself. `promoteAccessorCapturesToGlobals`
 * aliases the ref-cell BOX in a module global and records the inner value type
 * in `ctx.capturedBoxGlobals`. Returns the entry only when `valType` is present:
 * transitive-fn box entries (used only by closure materialization in calls.ts)
 * leave it undefined and must NOT be dereferenced by the scalar read/write
 * sites. The read/write sites (identifiers.ts / assignment.ts /
 * unary-updates.ts) consult this FIRST — before `capturedGlobals` — so a boxed
 * capture derefs the cell instead of treating the global as holding the value.
 */
export function getCapturedBoxGlobal(
  ctx: CodegenContext,
  name: string,
): { globalIdx: number; refCellTypeIdx: number; valType: ValType } | undefined {
  const e = ctx.capturedBoxGlobals?.get(name);
  if (e && e.valType) {
    return e as { globalIdx: number; refCellTypeIdx: number; valType: ValType };
  }
  return undefined;
}

/**
 * (#3039) Emit a null-guarded READ of a boxed captured global. Leaves the inner
 * value on the stack and returns its type. Mirrors the `boxedCaptures`
 * (local-box) read in identifiers.ts, sourcing the box ref from a module global
 * instead of a local slot. The box is initialised to null and set by the
 * enclosing function at object/class construction, so an uninitialised cell
 * yields the type default (never traps) — matching the local-box semantics.
 */
export function emitCapturedBoxGlobalRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  entry: { globalIdx: number; refCellTypeIdx: number; valType: ValType },
): ValType {
  fctx.body.push({ op: "global.get", index: entry.globalIdx });
  emitNullGuardedStructGet(
    ctx,
    fctx,
    { kind: "ref_null", typeIdx: entry.refCellTypeIdx },
    entry.valType,
    entry.refCellTypeIdx,
    0,
    undefined /* propName */,
    false /* throwOnNull — ref cells use default for uninitialized captures */,
  );
  return entry.valType;
}

/**
 * (#3039) Emit a null-guarded WRITE through a boxed captured global. The value
 * to store must already sit in `valLocalIdx` (typed as `entry.valType`). Mirrors
 * the `boxedCaptures` (local-box) write in assignment.ts: if the box ref is null
 * the store is skipped (#702), otherwise `struct.set field 0` writes through the
 * shared cell so the enclosing scope observes the mutation.
 */
export function emitCapturedBoxGlobalWrite(
  fctx: FunctionContext,
  entry: { globalIdx: number; refCellTypeIdx: number },
  valLocalIdx: number,
): void {
  fctx.body.push({ op: "global.get", index: entry.globalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [],
    else: [
      { op: "global.get", index: entry.globalIdx },
      { op: "local.get", index: valLocalIdx },
      { op: "struct.set", typeIdx: entry.refCellTypeIdx, fieldIdx: 0 },
    ],
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
/**
 * (#2101a R5) Emit an own-field READ (`inst.code`) on an externref-backed
 * subclass instance. The storage location depends on the native backing
 * representation (#2917 — `externrefBackedOwnFieldBacking`):
 *
 *   - Error family (`$Error_struct` backing): read through the
 *     `$Error_struct.$props` (fieldIdx 5) open-`$Object` side-slot instead of
 *     the vestigial `$A` struct (which the receiver is NOT). Lowers to:
 *     `props = self.$props; props == null ? undefined : __extern_get(props,
 *     "code")`. message/name/stack never reach here — they are served by the
 *     Error fast-path upstream.
 *   - `extends Object` (#3238, native `$Object` backing): the instance ITSELF
 *     is the open property store — `__extern_get(self, "code")` directly.
 *     Casting it to `$Error_struct` (the pre-#2917 behavior) traps.
 *
 * `className` selects the backing; when omitted (the SuppressedError builtin
 * fast-path caller, whose native instances are `$Error_struct`s — #3234) the
 * Error-struct arm is used.
 *
 * Returns the result ValType on success, or `undefined` when the backing is
 * unknown / helpers are unavailable (caller falls through to the legacy
 * struct read).
 */
export function emitExternrefBackedOwnFieldRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  className?: string,
): ValType | null | undefined {
  const backing = className === undefined ? "error-struct" : externrefBackedOwnFieldBacking(ctx, className);
  if (backing === undefined) return undefined;
  ensureObjectRuntime(ctx);
  const externGetIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (externGetIdx === undefined) return undefined;

  if (backing === "plain-object") {
    // self IS the open `$Object` — `self == null ? undefined :
    // __extern_get(self, propName)`.
    const selfResult = compileExpression(ctx, fctx, expr.expression, { kind: "externref" });
    if (!selfResult) return null;
    if (selfResult.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
    const selfLocal = allocLocal(fctx, `__ownf_rself_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.tee", index: selfLocal });
    addStringConstantGlobal(ctx, propName);
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "ref.null.extern" }],
      else: [
        { op: "local.get", index: selfLocal },
        ...stringConstantExternrefInstrs(ctx, propName),
        { op: "call", funcIdx: externGetIdx },
      ],
    });
    return { kind: "externref" };
  }

  const errStructIdx = getOrRegisterErrorStructType(ctx);

  const selfResult = compileExpression(ctx, fctx, expr.expression, { kind: "externref" });
  if (!selfResult) return null;
  if (selfResult.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });

  // props = self.$props (fieldIdx 5): cast externref → (ref $Error_struct) once.
  const propsLocal = allocLocal(fctx, `__ownf_rprops_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: errStructIdx });
  fctx.body.push({ op: "struct.get", typeIdx: errStructIdx, fieldIdx: 5 });
  fctx.body.push({ op: "local.tee", index: propsLocal });
  // props == null ? undefined : __extern_get(props, propName)
  fctx.body.push({ op: "ref.is_null" });
  addStringConstantGlobal(ctx, propName);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [{ op: "ref.null.extern" }],
    else: [
      { op: "local.get", index: propsLocal },
      ...stringConstantExternrefInstrs(ctx, propName),
      { op: "call", funcIdx: externGetIdx },
    ],
  });
  return { kind: "externref" };
}

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
  let primaryPresenceSlot: PresenceSlot | undefined;
  let primaryShapeId: number | undefined;
  let primaryShapeFieldIdx: number | undefined;
  if (propName) {
    for (const [structName, fields] of ctx.structFields) {
      if (ctx.structMap.get(structName) !== structTypeIdx) continue;
      if (fields[fieldIdx]?.presenceTracked) primaryPresenceSlot = presenceSlotOf(fields, propName);
      primaryShapeId = ctx.shapeIdByStructName.get(structName);
      if (primaryShapeId !== undefined) {
        const shapeFieldIdx = fields.findIndex((field) => field.name === "$shape");
        if (shapeFieldIdx >= 0) primaryShapeFieldIdx = shapeFieldIdx;
      }
      break;
    }
  }
  const absentValueInstrs = (): Instr[] =>
    resultType.kind === "externref"
      ? (undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }])
      : defaultValueInstrs(resultType);

  // Convert externref -> anyref for struct type testing
  fctx.body.push({ op: "any.convert_extern" });

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
      externGetFallback.push({ op: "local.get", index: tmpAny });
      externGetFallback.push({ op: "extern.convert_any" });
      // Push property name string
      addStringConstantGlobal(ctx, propName);
      externGetFallback.push(...stringConstantExternrefInstrs(ctx, propName));
      externGetFallback.push({ op: "call", funcIdx: getIdx });
      if (ctx.runtimeEvalGlobalFunctionBindings === true) {
        externGetFallback.push(...runtimeEvalSharedValueUnwrapInstrs(ctx, fctx));
      }
      // Coerce externref result to the expected result type
      if (resultType.kind === "f64") {
        const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
        flushLateImportShifts(ctx, fctx);
        if (unboxIdx !== undefined) {
          externGetFallback.push({ op: "call", funcIdx: unboxIdx });
        }
      } else if (resultType.kind === "i32") {
        const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
        flushLateImportShifts(ctx, fctx);
        if (unboxIdx !== undefined) {
          externGetFallback.push({ op: "call", funcIdx: unboxIdx });
          externGetFallback.push({ op: "i32.trunc_sat_f64_s" });
        }
      }
      // For ref/ref_null result types, the externref from __extern_get needs
      // to be converted to anyref and then cast to the expected struct type.
      // If the cast fails (wrong type from JS), fall back to a default value.
      if (resultType.kind === "ref_null") {
        // The __extern_get returns externref; convert to anyref, try ref.cast_null
        const tmpExtResult = allocTempLocal(fctx, { kind: "anyref" });
        externGetFallback.push({ op: "any.convert_extern" });
        externGetFallback.push({ op: "local.tee", index: tmpExtResult });
        externGetFallback.push({ op: "ref.test", typeIdx: (resultType as any).typeIdx });
        externGetFallback.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: tmpExtResult },
            { op: "ref.cast", typeIdx: (resultType as any).typeIdx },
            { op: "local.set", index: resultLocal },
          ],
          else: [...defaultValueInstrs(resultType), { op: "local.set", index: resultLocal }],
        });
        releaseTempLocal(fctx, tmpExtResult);
      } else {
        externGetFallback.push({ op: "local.set", index: resultLocal });
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
      // null = this shape cannot produce `resultType`; skip the arm.
      const altRead = alternateFieldArmRead(ctx, fctx, alt, resultType, tmpAny);
      if (!altRead) return buildFallbackChain(altIdx + 1);
      const altReadAndStore: Instr[] = [
        ...(alt.presenceSlot !== undefined
          ? ([
              { op: "local.get", index: tmpAny },
              { op: "ref.cast", typeIdx: alt.structTypeIdx },
              ...presenceTestInstrs(alt.structTypeIdx, alt.presenceSlot),
              {
                op: "if",
                blockType: { kind: "val", type: resultType },
                then: altRead,
                else: absentValueInstrs(),
              },
            ] satisfies Instr[])
          : altRead),
        { op: "local.set", index: resultLocal },
      ];
      const shapeGuardedAltRead: Instr[] =
        alt.shapeId !== undefined && alt.shapeFieldIdx !== undefined
          ? [
              { op: "local.get", index: tmpAny },
              { op: "ref.cast", typeIdx: alt.structTypeIdx },
              { op: "struct.get", typeIdx: alt.structTypeIdx, fieldIdx: alt.shapeFieldIdx },
              { op: "i32.const", value: alt.shapeId },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: altReadAndStore,
                else: buildFallbackChain(altIdx + 1),
              },
            ]
          : altReadAndStore;
      return [
        { op: "local.get", index: tmpAny },
        { op: "ref.test", typeIdx: alt.structTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: shapeGuardedAltRead,
          else: buildFallbackChain(altIdx + 1),
        },
      ];
    }
    // No more INLINE struct alternates. (#2674) Route the terminal through the
    // deferred-fill `__get_member_<name>` dispatcher (complete candidate set at
    // finalize) so a struct type registered AFTER this read compiled (acorn's
    // `$__fnctor_Parser`) is still resolved — the inline `alternates` froze it
    // out, so a read of the real instance otherwise fell straight to
    // `__extern_get` → `undefined` (the slot is a real struct field, not a
    // sidecar prop). The dispatcher's own terminal IS `__extern_get`, so this
    // strictly extends coverage (all struct candidates, THEN the host read).
    // (#2043 hardening) Pass fctx so the dispatcher's late-import additions flush
    // against THIS body before baking `getDispIdx` into the detached array.
    const getDispIdx = propName ? reserveMemberGetDispatch(ctx, propName, fctx) : undefined;
    if (getDispIdx !== undefined) {
      return [
        { op: "local.get", index: tmpAny },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: getDispIdx },
        ...coercionInstrs(ctx, { kind: "externref" }, resultType, fctx),
        { op: "local.set", index: resultLocal },
      ];
    }
    // No dispatcher — use __extern_get for JS objects, or default value (legacy).
    if (externGetFallback) {
      return externGetFallback;
    }
    return [...defaultValueInstrs(resultType), { op: "local.set", index: resultLocal }];
  };

  const primaryReadAndStore: Instr[] = [
    ...(primaryPresenceSlot !== undefined
      ? ([
          { op: "local.get", index: tmpAny },
          { op: "ref.cast", typeIdx: structTypeIdx },
          ...presenceTestInstrs(structTypeIdx, primaryPresenceSlot),
          {
            op: "if",
            blockType: { kind: "val", type: resultType },
            then: [
              { op: "local.get", index: tmpAny },
              { op: "ref.cast", typeIdx: structTypeIdx },
              { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
            ],
            else: absentValueInstrs(),
          },
        ] satisfies Instr[])
      : ([
          { op: "local.get", index: tmpAny },
          { op: "ref.cast", typeIdx: structTypeIdx },
          { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
        ] satisfies Instr[])),
    { op: "local.set", index: resultLocal },
  ];
  const shapeGuardedPrimaryRead: Instr[] =
    primaryShapeId !== undefined && primaryShapeFieldIdx !== undefined
      ? [
          { op: "local.get", index: tmpAny },
          { op: "ref.cast", typeIdx: structTypeIdx },
          { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: primaryShapeFieldIdx },
          { op: "i32.const", value: primaryShapeId },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: primaryReadAndStore,
            else: buildFallbackChain(0),
          },
        ]
      : primaryReadAndStore;

  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: shapeGuardedPrimaryRead,
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
  // (#2106 S1) Under the `undefinedSingleton` regime standalone `undefined` is
  // a NON-null externref, so the short-circuit must also test the singleton.
  if (undefinedSingletonActive(ctx) && objType.kind === "externref") {
    const s1IsUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
    if (s1IsUndefIdx !== undefined) {
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "call", funcIdx: s1IsUndefIdx });
      fctx.body.push({ op: "i32.or" });
    }
  }

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
          fctx.body.push({ op: "extern.convert_any" }); // recv struct ref → externref
          fctx.body.push({ op: "global.get", index: closureAccGet }); // getter closure (externref)
          const driverIdx = reserveAccessorGetDriver(ctx);
          fctx.body.push({ op: "call", funcIdx: driverIdx });
          elseResultType = { kind: "externref" };
        } else if (ctx.classAccessorSet.has(accessorKey) && getterIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: getterIdx });
          // Determine getter return type
          const funcDef = definedFuncAt(ctx, getterIdx);
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
                      : [{ op: "ref.null.extern" }]) satisfies Instr[]),
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
    // Property could not be resolved statically. The receiver is still on the
    // stack from `local.get tmp`; perform the same runtime member lookup as an
    // ordinary dynamic read. Returning the receiver itself here made
    // `value?.length` compare the value object to the expected length (uuid's
    // parsed Uint8Array namespace therefore never had length 16).
    if (objType.kind !== "externref") {
      coerceType(ctx, fctx, objType, { kind: "externref" });
    }
    const getMemberIdx = reserveMemberGetDispatch(ctx, propName, fctx);
    if (getMemberIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: getMemberIdx });
    } else {
      const getIdx = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      addStringConstantGlobal(ctx, propName);
      flushLateImportShifts(ctx, fctx);
      if (getIdx !== undefined) {
        fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
        fctx.body.push({ op: "call", funcIdx: getIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
    }
    elseResultType = { kind: "externref" };
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
export function receiverIsCatchClauseBinding(ctx: CodegenContext, recv: ts.Expression): boolean {
  if (!ts.isIdentifier(recv)) return false;
  const sym = ctx.checker.getSymbolAtLocation(recv);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  return (
    decl !== undefined && ts.isVariableDeclaration(decl) && decl.parent !== undefined && ts.isCatchClause(decl.parent)
  );
}

/**
 * (#2192 follow-up) Recognize a receiver expression that is itself a caught-Error
 * string-field read — i.e. `<catchBinding>.message` / `.name` / `.stack`. In
 * standalone mode the #2077/#2192 fast path lowers that read to a `$Error_struct`
 * `struct.get` coerced to a native-string ref (`$AnyString`), so at the VALUE
 * level the result IS a string. But the receiver's static TS type is `any` (the
 * catch binding is `any`), so the `.length` / string-method dispatch sites —
 * which gate on `isStringType(<static type>)` — never fire, and
 * `e.message.length` / `e.message.charCodeAt(0)` fall through to the host
 * `__extern_get` path (null standalone → 0). This predicate lets those consumer
 * sites treat such a receiver as string-typed and route through the
 * native-string path.
 *
 * Scope: standalone/WASI only (the fast path that produces a string ref is
 * standalone-gated), `message`/`name`/`stack` only (the fields the read fast path
 * handles), and only when the inner receiver is a catch binding (so a plain
 * `obj.message` on a real object is unaffected — it keeps its own typed path).
 * `.cause` is intentionally NOT covered: it is not a `$Error_struct` field yet
 * (deferred follow-up).
 */
export function receiverIsCaughtErrorStringRead(ctx: CodegenContext, recv: ts.Expression): boolean {
  if (!(ctx.wasi || ctx.standalone)) return false;
  if (!ts.isPropertyAccessExpression(recv)) return false;
  const p = recv.name.text;
  if (p !== "message" && p !== "name" && p !== "stack") return false;
  if (!receiverIsCatchClauseBinding(ctx, recv.expression)) return false;
  const innerType = ctx.checker.getTypeAtLocation(recv.expression);
  return (innerType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/**
 * (#2187) Recognize a receiver IDENTIFIER whose TS static type is `any`/`unknown`
 * but whose compiled local/param **ValType is a native-string ref**
 * (`$AnyString` / `$NativeString`). This is the general "TS type vs local
 * ValType disagreement" case behind the #2072 value-rep family: e.g. a for-of
 * loop var bound from a string-yielding generator (`for (const v of g())`)
 * infers `any` (no lib types in standalone) yet is compiled to a `(ref null
 * $AnyString)` local. Without this, `v.length` / `v.charCodeAt(0)` gate on
 * `isStringType(<static type>)` → false → the read falls to the generic
 * externref/`__extern_get` path and returns 0.
 *
 * Strictly gated: standalone/WASI only (where native string refs exist), only a
 * bare identifier (so a `.foo` property read or a real object keeps its own
 * typed path), only when the TS type is `any`/`unknown` (a concrete non-string
 * type is unaffected), and only when the resolved local ValType is exactly the
 * native string ref type. Returns false for everything else — byte-identical for
 * the common case.
 */
export function receiverIsNativeStringValType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recv: ts.Expression,
): boolean {
  if (!(ctx.wasi || ctx.standalone)) return false;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return false;
  // (#3753 S1c) `this.<field>` inside a typed twin, where #3753 S1b promoted the
  // slot to a native string ref. The value IS a `$AnyString` by construction —
  // the struct field's own wasm type says so — but the receiver's TS type is
  // still `any` (the twin's `this` is untyped in the source), so without this
  // the call fell to the RUNTIME-guarded arm and re-emitted
  // `ref.test` + `ref.cast` + `__str_flatten` on a value already known to be a
  // flat native string. That is the per-character cost #3753 measured: promoting
  // the slot alone moved nothing because the READ never consulted it.
  if (ts.isPropertyAccessExpression(recv) && recv.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const structName = fctx.typedThisStructName;
    if (structName === undefined) return false;
    const fields = ctx.structFields.get(structName);
    const field = fields?.find((f) => f.name === recv.name.text);
    if (field === undefined) return false;
    if (field.presenceTracked) return false; // absence must stay expressible
    if (ctx.classAccessorSet.has(`${structName}_${recv.name.text}`)) return false;
    if (field.type.kind !== "ref" && field.type.kind !== "ref_null") return false;
    const fieldTypeIdx = (field.type as { typeIdx?: number }).typeIdx;
    return fieldTypeIdx === ctx.anyStrTypeIdx || (ctx.nativeStrTypeIdx >= 0 && fieldTypeIdx === ctx.nativeStrTypeIdx);
  }
  if (!ts.isIdentifier(recv)) return false;
  // Only when the static type genuinely lost the string info (`any`/`unknown`).
  // A concrete `string` already routes through the existing isStringType gate;
  // a concrete non-string type must NOT be hijacked.
  const tsType = ctx.checker.getTypeAtLocation(recv);
  if ((tsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return false;
  const localIdx = fctx.localMap.get(recv.text);
  if (localIdx === undefined) return false;
  const localType = getLocalType(fctx, localIdx);
  if (!localType) return false;
  if (localType.kind !== "ref" && localType.kind !== "ref_null") return false;
  const typeIdx = (localType as { typeIdx?: number }).typeIdx;
  return typeIdx === ctx.anyStrTypeIdx || (ctx.nativeStrTypeIdx >= 0 && typeIdx === ctx.nativeStrTypeIdx);
}

/**
 * (#2576, extends #2187) Generalisation of {@link receiverIsNativeStringValType}
 * (which only catches a bare identifier whose *compiled local ValType* is a
 * native string ref) to *any* `any`/`unknown`-typed receiver whose *runtime*
 * value may be a native `$AnyString` even though no local ValType says so —
 * object property values (`o.v`), generator yield reads, catch bindings, indexed
 * element reads (`Object.values(o)[0]`), nested reads (`o.a.b`). These compile to
 * an opaque `externref`, so the value can only be recognised at runtime: callers
 * MUST emit a `ref.test $AnyString` guard (see
 * {@link emitGuardedNativeStringLength} and `compileGuardedNativeStringMethodCall`)
 * and keep the prior behaviour in the else arm for non-string values.
 *
 * Narrow scope: `any`/`unknown` only (NOT `object`/`{}`, NOT unions containing
 * `string`), native-string mode only (host/gc mode's generic `__extern_get`
 * already returns the correct length from the real JS value).
 */
export function receiverMayBeNativeStringAtRuntime(ctx: CodegenContext, recv: ts.Expression): boolean {
  if (!(ctx.wasi || ctx.standalone)) return false;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return false;
  const t = ctx.checker.getTypeAtLocation(recv);
  return (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/**
 * (#2576, extends #2187) Emit a runtime-guarded native-string `.length` read for
 * an `any`-typed receiver whose value is already on the stack as an `externref`.
 * The externref is saved to a temp; on a `ref.test $AnyString` hit the value is
 * cast to `$AnyString` and its `len` (field 0, valid for FlatString & ConsString
 * — no flatten needed for length) is read; on a miss the caller-supplied builder
 * produces the prior generic behaviour (e.g. `__extern_length` for an
 * array-in-`any`, or `i32.const 0`). The builder receives the externref temp's
 * local index so it can re-push the original externref. Both arms produce i32.
 */
export function emitGuardedNativeStringLength(
  ctx: CodegenContext,
  fctx: FunctionContext,
  buildElseInstrs: (recvExternLocal: number) => Instr[],
): void {
  const recvExtern = allocLocal(fctx, `__strlen_ext_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvExtern });
  fctx.body.push({ op: "local.get", index: recvExtern });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [
      { op: "local.get", index: recvExtern },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      { op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 },
    ],
    else: buildElseInstrs(recvExtern),
  });
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
/**
 * (#2681/#2686 A3) Route a pinned-struct dynamic `recv.<field>` READ through the
 * finalize-filled `__get_member_<name>` dispatcher (member-get-dispatch.ts). The
 * caller has already established that `recv` resolves to a registered/approved
 * `__fnctor_<F>` struct (a lifted-method `this`, or a single-return-inferred
 * local). Returns `externref` when it routed the read, or `undefined` to let the
 * normal dispatch handle it (reserved accessor / method-typed access).
 *
 * Funcidx discipline (member-get-dispatch.ts header): the receiver is compiled
 * FIRST so its own late-import additions settle, THEN the dispatcher is reserved
 * (which flushes its index-shift against `fctx`), THEN the call is baked — no
 * import addition between reserve and the baked `funcIdx`, and the `call`
 * instruction lives in the tracked `fctx.body` so any later module-wide shift
 * reaches it.
 */
export function tryEmitPinnedStructMemberGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  pinnedStructName?: string,
): ValType | undefined {
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
  // A method/function-typed access keeps its closure/funcref lowering (calls.ts /
  // the dispatch-on-call path); `__get_member_<name>` would box it as a value.
  const accessType = ctx.checker.getTypeAtLocation(expr);
  if (accessType.getCallSignatures && accessType.getCallSignatures().length > 0) return undefined;
  // Standalone's member dispatcher crosses the uniform externref boundary, but
  // an own field on the pinned fnctor still has an exact native representation.
  // Recover it after the call so downstream native-string/number/struct
  // operations do not lose their static carrier (Acorn's `this.input` feeding
  // RegExp.exec is the canonical case). Prototype/accessor misses have no own
  // field entry and deliberately stay externref.
  const pinnedFieldType =
    ctx.standalone && pinnedStructName !== undefined
      ? ctx.structFields.get(pinnedStructName)?.find((field) => field.name === propName)?.type
      : undefined;
  const finishPinnedRead = (): ValType => {
    if (pinnedFieldType !== undefined) {
      coerceType(ctx, fctx, { kind: "externref" }, pinnedFieldType);
      return pinnedFieldType;
    }
    return { kind: "externref" };
  };

  // Commit: compile the receiver to an externref exactly once, leaving it ON THE
  // WASM STACK across the dispatcher reservation. The receiver is compiled FIRST
  // so its OWN late-import additions settle before the dispatcher funcIdx is
  // reserved/baked; the reservation does NOT touch the value stack (it only
  // registers funcs/imports + flushes funcIdx shifts against `fctx.body`), so the
  // receiver value survives the reserve without needing a scratch local. (#2681
  // fix: the earlier `allocTempLocal` + `local.set/get` stashing orphaned its
  // scratch slot when this read was emitted inside a SWAPPED/speculative body
  // — `local index out of range` in `__module_init`. A stack-resident receiver
  // has no local to orphan.)
  const objResult = compileExpression(ctx, fctx, expr.expression);
  // (#4155 Phase 2) Struct-typed receiver + own data slot → one `struct.get`
  // instead of the externref hop + `__get_member_<name>` ladder. Flag-gated
  // (declines are byte-identical); flag-independent census under
  // JS2WASM_FNCTOR_TYPED_READS_DEBUG.
  const fnctorTypedGet = tryEmitFnctorTypedFieldGet(ctx, fctx, expr, propName, objResult, () =>
    typeErrorThrowInstrs(ctx, expr),
  );
  if (fnctorTypedGet !== undefined) return fnctorTypedGet;
  if (objResult && objResult.kind !== "externref") {
    coerceType(ctx, fctx, objResult, { kind: "externref" });
  } else if (!objResult) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  const getDispIdx = reserveMemberGetDispatch(ctx, propName, fctx);
  if (getDispIdx === undefined) {
    // Dispatcher unavailable (no `__extern_get` import registerable) — degrade to
    // a plain dynamic read of the (already-evaluated, stack-resident) receiver.
    // Standalone / host both register the dispatcher in practice, so this is
    // defensive only. Receiver is on the stack → push the prop key, then call
    // `__extern_get(recv, prop)`.
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getIdx === undefined) {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    addStringConstantGlobal(ctx, propName);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
    fctx.body.push({ op: "call", funcIdx: getIdx });
    return finishPinnedRead();
  }
  // Receiver is on the stack; the dispatcher takes (recv) → call directly.
  fctx.body.push({ op: "call", funcIdx: getDispIdx });
  return finishPinnedRead();
}

export function tryEmitDeleteAwareDynamicGet(
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

  // (#2681/#2686) Reads to a RECONSTRUCTED-fnctor receiver (acorn's Parser/Node —
  // `this`/flow-mapped) are routed through the `__get_member_<name>` struct
  // dispatcher by an EARLIER pinned-read path (`tryEmitPinnedStructMemberGet`,
  // compilePropertyAccess), so those hit the native slot. This delete-aware path
  // is the GENERAL `any`-receiver read in a delete-using module, where the
  // receiver is typically a PLAIN object literal lowered to an anonymous
  // `$__anon_N` struct. Routing THAT through the dispatcher's `struct.get` arm
  // would read the field SLOT directly, IGNORING the delete tombstone — the exact
  // #2179 bug this path exists to fix (`delete o.a; o.a` must read `undefined`,
  // not the stale slot). So the general delete-aware read MUST stay on the bare
  // tombstone-aware `__extern_get`; only the narrowly-pinned reconstructed-fnctor
  // read uses the slot dispatcher.
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (getIdx === undefined) return undefined;

  // (#2800) MODULE-INIT correctness. gc/host runs `__module_init` via the Wasm
  // `start` section, which executes INSIDE `WebAssembly.instantiate` — BEFORE the
  // host wires the struct getters via `__setExports`. The host `__extern_get`
  // reads a WasmGC struct field through `callbackState.getExports()?.__sget_<f>`,
  // so at init it sees no exports and returns `undefined` for EVERY struct field.
  // Every top-level `new X(objLiteral)` then stores null for fields read off its
  // object-literal argument (acorn's `this.binop = conf.binop || null` in the
  // `types$1` TokenType table → every operator's precedence becomes null →
  // "Unexpected token" on the first binary expression), while the IDENTICAL read
  // at RUNTIME works. Reserve the deferred-fill `__get_member_<name>` dispatcher
  // (a HOST-FREE ref.test+struct.get over the complete finalize-time candidate
  // set, with `__extern_get` as its own terminal) and branch on the
  // `__in_module_init` flag: during init read the slot via the dispatcher (no
  // exports needed; nothing has been `delete`d yet, so the tombstone is moot), at
  // runtime keep the tombstone-aware host `__extern_get`. Falls back to the bare
  // host read when the dispatcher/flag can't be set up (byte-identical legacy).
  // The `__in_module_init` gate is a gc/host concern only: the host start-section
  // timing is what breaks `__extern_get`'s struct read at init. WASI/standalone
  // have no host `__extern_get` (and this whole function is already gated
  // `!ctx.standalone`); keep WASI on the legacy bare read so `__module_init`'s
  // lazy-init guard wrap stays untouched.
  const getMemberIdx = ctx.wasi ? undefined : reserveMemberGetDispatch(ctx, propName, fctx);
  addStringConstantGlobal(ctx, propName);
  flushLateImportShifts(ctx, fctx);

  // Evaluate the receiver, coerce to externref.
  const objResult = compileExpression(ctx, fctx, expr.expression);
  if (objResult && objResult.kind !== "externref") {
    coerceType(ctx, fctx, objResult, { kind: "externref" });
  } else if (!objResult) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  if (getMemberIdx === undefined) {
    // No dispatcher available — legacy bare tombstone-aware host read.
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
    fctx.body.push({ op: "call", funcIdx: getIdx });
    return { kind: "externref" };
  }

  // `__in_module_init ? __get_member_<name>(recv) : __extern_get(recv, "prop")`.
  // The flag-read `global.get` index is a PLACEHOLDER patched at finalize by
  // `finalizeInModuleInitFlag` (after all import globals settle).
  const flagGet = recordInModuleInitFlagRead(ctx);
  const recvLocal = allocLocal(fctx, `__dadg_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });
  fctx.body.push(flagGet);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } as ValType },
    then: [
      { op: "local.get", index: recvLocal },
      { op: "call", funcIdx: getMemberIdx },
    ],
    else: [
      { op: "local.get", index: recvLocal },
      ...stringConstantExternrefInstrs(ctx, propName),
      { op: "call", funcIdx: getIdx },
    ],
  });
  return { kind: "externref" };
}

/**
 * (#2731) Symmetric mirror of `tryEmitDeleteAwareDynamicGet` for the WRITE side.
 *
 * In a module that contains a member-`delete`, `ctx.moduleUsesDelete` routes
 * `any`/`unknown`-receiver property READS through the tombstone-aware host
 * `__extern_get` (above). The corresponding WRITE had no symmetric gate, so
 * `o.x = 9` still took the native `struct.set` fast-path
 * (`emitAlternateStructSetDispatch`), which **bypasses `_safeSet`** — the host
 * function where the delete-tombstone (`_wasmStructDeletedKeys`) is cleared on
 * re-assignment (`runtime.ts`). Result: `delete o.x; o.x = 9` left the tombstone
 * set, so every tombstone-consulting reader (`__extern_get`, `__for_in_has`,
 * `_wasmStructHasOwn`, `__object_keys`) suppressed the re-added key
 * (`o.x === undefined`, `"x" in o === false`, for-in dropped `x`).
 *
 * This reroutes the `any`-receiver write through the strict host setter
 * `__extern_set_strict` → `_safeSet`, which clears the tombstone, writes the
 * sidecar, AND mirrors the native field via `__sset_<key>` — so read/write stay
 * symmetric. Returns the assignment-result type when handled, else `undefined`
 * (caller falls through to the native struct-set dispatch). Gated identically to
 * the read side: `moduleUsesDelete && !standalone`, `any`/`unknown` receiver,
 * non-reserved-accessor, non-callable property. Delete-free modules are
 * untouched (`moduleUsesDelete` false → byte-identical).
 */
export function tryEmitDeleteAwareDynamicSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  objType: ts.Type,
  propName: string,
): ValType | undefined {
  if (!ctx.moduleUsesDelete || ctx.standalone) return undefined;
  // The receiver must be a shape-inferred dynamic struct that `delete` can
  // tombstone: `any`/`unknown` (the read side's case) OR a shape-inferred
  // ANONYMOUS object/type literal (`var o = { … }` / `(o: { a: T })`). The
  // actual test262 cases use the latter — a concrete inferred object-literal
  // type (`SymbolFlags.ObjectLiteral`), NOT `any` — and its native `struct.set`
  // re-add leaves the delete-tombstone set so for-in's per-visit `__for_in_has`
  // drops the re-added key. EXCLUDE class instances (`SymbolFlags.Class`),
  // arrays, and named interfaces — those are not the deleted-then-readded
  // dynamic-object shape and keep their fast native writes.
  const isAnyOrUnknown = (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
  const sym = objType.getSymbol();
  const isAnonObjectLiteral = !!(sym && sym.flags & (ts.SymbolFlags.ObjectLiteral | ts.SymbolFlags.TypeLiteral));
  if (!isAnyOrUnknown && !isAnonObjectLiteral) return undefined;
  if (
    propName === "length" ||
    propName === "constructor" ||
    propName === "__proto__" ||
    propName === "prototype" ||
    propName === "name"
  ) {
    return undefined;
  }
  // A method/function-typed write keeps its closure/funcref lowering.
  const accessType = ctx.checker.getTypeAtLocation(target);
  if (accessType.getCallSignatures && accessType.getCallSignatures().length > 0) return undefined;

  const setIdx = ensureLateImport(
    ctx,
    "__extern_set_strict",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx === undefined) return undefined;

  // Evaluate the receiver (spec order: reference before value), coerce to externref.
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (objResult && objResult.kind !== "externref") {
    coerceType(ctx, fctx, objResult, { kind: "externref" });
  } else if (!objResult) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const objLocal = allocLocal(fctx, `__daset_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Evaluate the value, coerce/box to externref.
  const valResult = compileExpression(ctx, fctx, value);
  if (valResult && valResult.kind !== "externref") {
    coerceType(ctx, fctx, valResult, { kind: "externref" });
  } else if (!valResult) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const valLocal = allocLocal(fctx, `__daset_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valLocal });

  // RUNTIME arm — __extern_set_strict(obj, "prop", val) → _safeSet (clears
  // tombstone, writes sidecar, mirrors __sset_<key>). Bare call — NOT the
  // struct.set dispatcher.
  //
  // (#2681/#2686) An EARLIER pinned-write path (`tryEmitPinnedStructMemberSet`,
  // assignment.ts) already routes writes to a RECONSTRUCTED-fnctor receiver
  // (acorn's Parser/Node — `this`/flow-mapped) through the `__set_member_<name>`
  // struct dispatcher, so those hit the native slot symmetrically with the pinned
  // READ. This delete-aware path is the GENERAL `any`-receiver write in a
  // delete-using module, where the receiver is typically a PLAIN object literal
  // lowered to an anonymous `$__anon_N` struct. Routing THAT through the
  // dispatcher's `struct.set` arm at RUNTIME overwrites the field SLOT in place,
  // which bypasses the delete+re-add ORDERING the JS-host sidecar tracks
  // (`delete o.p; o.p = v` must re-insert `p` at the END — `for-in` order, #2179/
  // #2731). So the general delete-aware runtime write MUST stay on the bare
  // sidecar `_safeSet`; only the narrowly-pinned reconstructed-fnctor write uses
  // the slot dispatcher. (The broad runtime reroute here regressed
  // `for-in/order-simple-object`.)
  //
  // (#2805) MODULE-INIT correctness — the symmetric WRITE side of #2800. gc/host
  // runs `__module_init` via the Wasm `start` section, INSIDE
  // `WebAssembly.instantiate`, BEFORE the host wires the struct setters via
  // `__setExports`. The runtime host write above threads `__extern_set_strict` →
  // `_safeSet` → `getExports()?.__sset_<key>`, so at init `getExports()` is
  // undefined and the field write is SILENTLY DROPPED — a top-level
  // `new X({...})` whose ctor does `this.<f> = conf.<f>` on an `any`-typed `this`
  // stores nothing (the struct keeps its 0/null default), while the IDENTICAL
  // construction at RUNTIME works. Mirror #2800's read-side gate: branch on the
  // `__in_module_init` flag and, DURING INIT, write the slot host-free via the
  // `__set_member_<name>` dispatcher (a `ref.test`+`struct.set` over the complete
  // finalize-time candidate set; #2664) — no exports needed, and nothing has been
  // `delete`d yet on a freshly-built object so the for-in re-add ordering the
  // runtime arm preserves is moot. At runtime keep the sidecar `__extern_set_strict`.
  //
  // gc/host only: WASI/standalone have no host `__extern_set_strict` (this
  // function already returns early for `ctx.standalone`), and WASI's
  // `__module_init` lazy-init wrap must stay untouched — so WASI keeps the legacy
  // bare sidecar write.
  //
  // The dispatcher is reserved HERE — AFTER both operands are evaluated into
  // locals — deliberately. The `value` expression (e.g. `conf.zz || 0`) can
  // itself reserve a `__get_member_<name>` dispatcher and pull late imports that
  // shift the DEFINED-function index space; reserving `__set_member_<name>` after
  // all that, with NOTHING emitted between its reserve+flush and the bake below,
  // guarantees `setMemberIdx` is post-shift and each property's write bakes its
  // OWN distinct funcIdx. Reserving it BEFORE the value eval (the #2800 write-side
  // prototype) left the local stale-low so `this.label` and `this.zz` baked the
  // SAME `call funcIdx` (a funcIdx desync). `setIdx` is an IMPORT (its index is
  // stable once added — new imports insert at the import-section end and shift
  // only defined funcs), so baking it late is safe.
  const setMemberIdx = ctx.wasi ? undefined : reserveMemberSetDispatch(ctx, propName, /*strict*/ true, fctx);
  addStringConstantGlobal(ctx, propName);
  flushLateImportShifts(ctx, fctx);

  if (setMemberIdx === undefined) {
    // WASI / no dispatcher — legacy bare tombstone-aware host write (byte-identical).
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
    fctx.body.push({ op: "local.get", index: valLocal });
    fctx.body.push({ op: "call", funcIdx: setIdx });
    fctx.body.push({ op: "local.get", index: valLocal });
    return { kind: "externref" };
  }

  // `__in_module_init ? __set_member_<name>(recv, val) : __extern_set_strict(recv, "prop", val)`.
  // The flag-read `global.get` index is a PLACEHOLDER patched at finalize by
  // `finalizeInModuleInitFlag` (after all import globals settle) — shared with the
  // read-side gate via the same `ctx.inModuleInitFlagReads` list.
  const flagGet = recordInModuleInitFlagRead(ctx);
  fctx.body.push(flagGet);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: objLocal },
      { op: "local.get", index: valLocal },
      { op: "call", funcIdx: setMemberIdx },
    ],
    else: [
      { op: "local.get", index: objLocal },
      ...stringConstantExternrefInstrs(ctx, propName),
      { op: "local.get", index: valLocal },
      { op: "call", funcIdx: setIdx },
    ],
  });

  // `=` evaluates to the assigned value.
  fctx.body.push({ op: "local.get", index: valLocal });
  return { kind: "externref" };
}

/**
 * (#2026 PR-2) `.constructor` identity on an externref / `any`-typed instance.
 *
 * The static arm (`compileInstanceMember`, gated on `ctx.classSet.has(typeName)`)
 * already makes `new A().constructor === A` hold for a STATICALLY-typed receiver
 * by routing to the `__class_<Name>` singleton (`emitLazyClassObjectGet`). But
 * when the instance flows through an `any`/externref binding (e.g. returned from
 * `function id(x: any): any { return x }`), `typeName` is not a known class, that
 * arm misses, and `.constructor` fell to the generic `__extern_get` read which
 * returns a plain value that never `===` the class object — so
 * `a.constructor === A` was `false`.
 *
 * This recovers identity at runtime by the SAME tag mechanism #2026 PR-1's
 * `emitDynamicNewFallback` uses for dynamic `new`: read the instance's class
 * `__tag` (struct field 0 on every class-root struct), then a flat
 * `tag == classTag` if/else chain selects the matching `__class_<Name>`
 * singleton (`emitLazyClassObjectGet`) — making both sides of `=== A`
 * reference-identical. No host import; standalone-safe. No match (a non-class
 * externref, or null) yields a null externref (the prior generic-read behaviour
 * for a missing `.constructor`), so nothing regresses.
 *
 * Discrimination MUST be by `__tag`, never by struct type alone: WasmGC
 * iso-recursive canonicalization merges structurally-identical class structs, so
 * a `ref.test $A` is also true for a same-shape `$B` instance (#2009). The tag
 * value is the unique class id.
 *
 * Returns the emitted result type (`externref`) when handled, else `undefined`.
 */
export function tryEmitConstructorViaTag(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  objType: ts.Type,
): ValType | undefined {
  // Candidate classes: WasmGC-struct-backed with a class-object singleton (same
  // filter as emitDynamicNewFallback — externref-backed builtin subclasses have
  // no `$ClassName` struct / `__tag` to read).
  const candidates: string[] = [];
  for (const className of ctx.classObjectGlobals.keys()) {
    if (ctx.classBuiltinParentMap.has(className)) continue;
    if (ctx.structMap.get(className) === undefined) continue;
    if (ctx.classTagMap.get(className) === undefined) continue;
    candidates.push(className);
  }
  if (candidates.length === 0) return undefined;

  // Only take over when the static class arm cannot: the receiver's type is not
  // a concrete known class (those keep the zero-overhead static path at
  // `compileInstanceMember`). `any`/`unknown`/a non-class object type reaches
  // here; a concretely-typed class instance does not.
  const sym = objType.getSymbol() ?? objType.aliasSymbol;
  const typeName = sym?.name ?? ctx.anonTypeMap.get(objType);
  if (typeName && ctx.classSet.has(typeName)) return undefined;

  // Evaluate the receiver once into an anyref local for the tag read.
  const objResult = compileExpression(ctx, fctx, expr.expression, { kind: "externref" });
  if (objResult && objResult.kind !== "externref") {
    coerceType(ctx, fctx, objResult, { kind: "externref" });
  } else if (!objResult) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "any.convert_extern" });
  const instLocal = allocLocal(fctx, `__ctoridn_inst_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.set", index: instLocal });

  // Read the class `__tag` (field 0) once. -1 = no class instance (yields null
  // externref). One `ref.test`/`struct.get 0` per distinct struct shape;
  // canonicalization makes the first shape-compatible test expose a valid field-0
  // layout for the instance.
  const distinctStructIdxs = [...new Set(candidates.map((c) => ctx.structMap.get(c)!))];
  const tagLocal = allocLocal(fctx, `__ctoridn_tag_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: -1 });
  fctx.body.push({ op: "local.set", index: tagLocal });
  for (const structIdx of distinctStructIdxs) {
    fctx.body.push({ op: "local.get", index: tagLocal });
    fctx.body.push({ op: "i32.const", value: -1 });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({ op: "local.get", index: instLocal });
    fctx.body.push({ op: "ref.test", typeIdx: structIdx });
    fctx.body.push({ op: "i32.and" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: instLocal },
        { op: "ref.cast", typeIdx: structIdx },
        { op: "struct.get", typeIdx: structIdx, fieldIdx: 0 },
        { op: "local.set", index: tagLocal },
      ],
      else: [],
    });
  }

  // Result local: seeded with the GENERIC `.constructor` read of the receiver,
  // so a non-user-class receiver (a host object, a TypedArray, a string, etc.)
  // keeps its real constructor — the tag dispatch below only OVERRIDES this when
  // a user-class `__tag` matches.
  //
  // Why this seed is load-bearing (#2026 PR-2 regression fix): this arm fires for
  // ANY `any`/`unknown`-typed `.constructor` access whenever the module declares
  // at least one tag-bearing user class. The test262 runner injects
  // `class Test262Error` into essentially every program, so that condition holds
  // for nearly every test. Seeding `resLocal` with a bare `ref.null.extern` made
  // `Object.getPrototypeOf(Int8Array.prototype).constructor` (the `TypedArray`
  // intrinsic shim, `any`-typed) evaluate to NULL, so every subsequent
  // `TA.prototype.*` / `new TA(...)` trapped "Cannot access property on null or
  // undefined" — cascading to ~478 TypedArray tests (net -479). The fix restores
  // the pre-PR fall-through: no class-tag match ⇒ the original generic read.
  const resLocal = allocLocal(fctx, `__ctoridn_res_${fctx.locals.length}`, { kind: "externref" });
  // (#3130) Standalone/WASI seed via the NATIVE `__extern_get` (the object
  // runtime's defined reader), not a hard null. This arm fires for EVERY
  // `any`-typed `.constructor` read once the module declares one tag-bearing
  // user class — the test262 harness injects `class Test262Error`, so that is
  // essentially every standalone program — and the old null seed meant the
  // read NEVER reached the runtime reader. With fillExternGetErrorProps the
  // native reader answers `.constructor` on a native `$Error_struct` with the
  // SAME `__builtin_<Name>` carrier the bare identifier reads, so
  // `reason.constructor === TypeError` (§27.2.1.3.2 resolve-settled-*-self)
  // is genuine identity. For every other receiver the native reader preserves
  // the old behaviour ($Object without a `constructor` prop / non-object →
  // miss), so nothing regresses. Plain strictNoHostImports (gc, no-host)
  // keeps the null seed unchanged.
  let externGetIdx: number | undefined;
  if (ctx.standalone || ctx.wasi) {
    ensureObjectRuntime(ctx);
    externGetIdx = ctx.funcMap.get("__extern_get");
  } else if (!ctx.strictNoHostImports) {
    externGetIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
  }
  if (externGetIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    // __extern_get(extern.convert_any(instLocal), "constructor")
    fctx.body.push({ op: "local.get", index: instLocal });
    fctx.body.push({ op: "extern.convert_any" });
    addStringConstantGlobal(ctx, "constructor");
    fctx.body.push(...stringConstantExternrefInstrs(ctx, "constructor"));
    fctx.body.push({ op: "call", funcIdx: externGetIdx });
    fctx.body.push({ op: "local.set", index: resLocal });
  } else {
    // No-host gc mode without the runtime reader: preserve the prior behaviour
    // for a non-class receiver (null externref).
    fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "local.set", index: resLocal });
  }

  // Flat tag-equality dispatch: tag == classTag → emitLazyClassObjectGet(class).
  for (const className of candidates) {
    const classTag = ctx.classTagMap.get(className)!;
    const arm: Instr[] = [];
    const savedBody = fctx.body;
    fctx.body = arm;
    if (emitLazyClassObjectGet(ctx, fctx, className)) {
      fctx.body.push({ op: "local.set", index: resLocal });
    } else {
      // No singleton emitted (shouldn't happen — classObjectGlobals has it):
      // leave resLocal null. This clears the DETACHED `arm` buffer (fctx.body is
      // `arm` here via the manual swap above), not a speculative-compile probe.
      fctx.body.length = 0; // not-a-probe-rollback (#1919): detached arm buffer
    }
    fctx.body = savedBody;
    if (arm.length === 0) continue;
    fctx.body.push({ op: "local.get", index: tagLocal });
    fctx.body.push({ op: "i32.const", value: classTag });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: arm, else: [] });
  }

  fctx.body.push({ op: "local.get", index: resLocal });
  return { kind: "externref" };
}

/**
 * (#2901) True iff `expr` is syntactically `Object.getPrototypeOf(<wired view>.prototype)`
 * — the inner half of the test262-runner `%TypedArray%`-intrinsic shim.
 */
export function isGetProtoOfWiredViewProtoCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr) || expr.arguments.length < 1) return false;
  const callee = expr.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    callee.name.text !== "getPrototypeOf"
  ) {
    return false;
  }
  const a0 = expr.arguments[0]!;
  return (
    ts.isPropertyAccessExpression(a0) &&
    a0.name.text === "prototype" &&
    ts.isIdentifier(a0.expression) &&
    isWiredTypedArrayViewName(a0.expression.text)
  );
}

/**
 * (#3054 B2) If `recvExpr` is an identifier local whose resolved type is a
 * registered `$__ta_view_<name>` (a shared-backing TypedArray-over-buffer view,
 * B1), return that view's typeIdx; else undefined. Discriminates the B2 accessor
 * arm at COMPILE time by the receiver's LOCAL ValType (set by `inferTaViewType`),
 * so native TypedArrays / plain arrays / non-buffer programs never reach it.
 */
export function taViewReceiverTypeIdx(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvExpr: ts.Expression,
): number | undefined {
  if (!ts.isIdentifier(recvExpr)) return undefined;
  const localIdx = fctx.localMap.get(recvExpr.text);
  if (localIdx === undefined) return undefined;
  const localType =
    localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;
  if (
    (localType?.kind === "ref" || localType?.kind === "ref_null") &&
    localType.typeIdx !== undefined &&
    isTaViewTypeIdx(ctx, localType.typeIdx)
  ) {
    return localType.typeIdx;
  }
  return undefined;
}

/**
 * Dynamic member READ off an open-object carrier. The established standalone
 * growable-object case keeps its reserved-accessor/callable exclusions. The
 * #671 W1 case is stricter: the exact planner-selected declaration has already
 * abandoned its checker-derived closed shape, so every public direct member
 * read must return the raw MOP value in both lanes. In particular, a host
 * harness can otherwise contribute an unrelated numeric `p1` field candidate
 * and make a string read run through `__unbox_number` ("x1" → NaN).
 */
function tryOpenObjectDynamicGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | null | undefined {
  const irWithTarget = isIrWithOpenObjectTargetReceiver(ctx, expr.expression);
  if (!irWithTarget && !ctx.standalone) return undefined;
  if (!irWithTarget && !chainRootIsGrowable(ctx, expr.expression)) return undefined;
  if (
    !irWithTarget &&
    (propName === "length" ||
      propName === "constructor" ||
      propName === "__proto__" ||
      propName === "prototype" ||
      propName === "name")
  ) {
    return undefined;
  }
  // Callable props keep their dedicated lowerings. Routed through the oracle
  // (#1930): `signatureOf` is `undefined` exactly when the checker type has no
  // call signature — the same gate tryEmitDeleteAwareDynamicGet expresses via
  // the raw checker's `getCallSignatures().length > 0`.
  if (!irWithTarget && ctx.oracle.signatureOf(expr) !== undefined) return undefined;
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (getIdx === undefined) return undefined;
  addStringConstantGlobal(ctx, propName);
  flushLateImportShifts(ctx, fctx);
  const recvType = compileExpression(ctx, fctx, expr.expression);
  if (!recvType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (recvType.kind !== "externref") {
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  }
  // §13.3 member access on null/undefined throws TypeError (keep parity with
  // the default read path's null guard).
  const recvTmp = allocTempLocal(fctx, { kind: "externref" });
  emitExternRecvNullGuard(ctx, fctx, recvTmp, recvType, expr.expression, expr, "growable-get:recv");
  fctx.body.push({ op: "local.get", index: recvTmp });
  releaseTempLocal(fctx, recvTmp);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
  fctx.body.push({ op: "call", funcIdx: getIdx });
  return { kind: "externref" };
}

/**
 * Read `<proven fnctor>.<dynamic-object-field>.<prop>` through the canonical
 * standalone `$Object` lookup directly.
 *
 * The generic member-read finalizer cannot see the value provenance of the
 * intermediate externref, so it emits a call-site closed-struct candidate
 * ladder before reaching `__extern_get`. Fields such as acorn's
 * `Parser.options` are initialized by a function proven to return an open
 * `$Object`; `__extern_get` already contains the complete native-struct
 * fallback and, importantly, its per-(receiver,key) cache runs before that
 * ladder. Calling it directly therefore removes duplicate dispatch without
 * narrowing semantics if the mutable field is later replaced.
 */
function tryKnownFnctorDynamicObjectCarrierGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  // Narrow rollback switch used by the Acorn exact A/B benchmark.
  if (process.env.JS2WASM_TYPED_OPEN_CARRIER_READS === "0") return undefined;
  if (!ctx.standalone) return undefined;
  if (!ts.isPropertyAccessExpression(expr.expression)) return undefined;
  const carrierRead = expr.expression;
  const carrierOwner =
    carrierRead.expression.kind === ts.SyntaxKind.ThisKeyword
      ? (fctx.typedThisStructName ?? resolveReceiverStruct(ctx, fctx, carrierRead.expression))
      : resolveReceiverStruct(ctx, fctx, carrierRead.expression);
  let carrierField = carrierOwner
    ? ctx.structFields.get(carrierOwner)?.find((field) => field.name === carrierRead.name.text)
    : undefined;
  // Constructor-parameter flow can lose its concrete fnctor owner even though
  // the field provenance remains unique module-wide (Acorn's
  // `Node(parser).parser.options`). Calling the canonical getter is semantics-
  // preserving for every receiver representation; the name-level proof merely
  // keeps this performance shortcut scoped to fields that really carry an open
  // object somewhere in the program.
  if (carrierField?.dynamicObjectCarrier !== true) {
    const matching = [...ctx.structFields.values()]
      .flat()
      .filter((field) => field.name === carrierRead.name.text && field.dynamicObjectCarrier === true);
    if (matching.length === 1) carrierField = matching[0];
  }
  if (carrierField?.dynamicObjectCarrier !== true || carrierField.type.kind !== "externref") return undefined;
  if (
    propName === "length" ||
    propName === "constructor" ||
    propName === "__proto__" ||
    propName === "prototype" ||
    propName === "name"
  ) {
    return undefined;
  }
  if (ctx.oracle.signatureOf(expr) !== undefined) return undefined;

  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (getIdx === undefined) return undefined;
  addStringConstantGlobal(ctx, propName);
  flushLateImportShifts(ctx, fctx);
  const recvType = compileExpression(ctx, fctx, carrierRead);
  if (!recvType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (recvType.kind !== "externref") {
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  }
  const recvTmp = allocTempLocal(fctx, { kind: "externref" });
  emitExternRecvNullGuard(ctx, fctx, recvTmp, recvType, carrierRead, expr, "carrier-get:recv");
  fctx.body.push({ op: "local.get", index: recvTmp });
  releaseTempLocal(fctx, recvTmp);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
  fctx.body.push({ op: "call", funcIdx: getIdx });
  return { kind: "externref" };
}

/**
 * (#4157) `recvType` is the receiver's ValType BEFORE the
 * `coerceType(…externref)` the callers apply: a non-nullable `(ref $T)` is
 * widened with `extern.convert_any`, which cannot introduce a null.
 */
function emitExternRecvNullGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvTmp: number,
  recvType: ValType | null,
  recvExpr: ts.Expression,
  throwNode: ts.Node,
  site: string,
): void {
  emitReceiverNullGuard(
    ctx,
    fctx,
    recvTmp,
    { site, compiled: recvType, expr: recvExpr, syntacticNonNull: isProvablyNonNull(recvExpr, ctx.checker) },
    () => typeErrorThrowInstrs(ctx, throwNode),
  );
}

/**
 * (#4500 Slice A) `this.p` / `globalThis.p` where `p` is a **`var`-declared**
 * script global — read the wasm module global that actually stores it.
 *
 * A `var` global lives in `ctx.moduleGlobals` (a wasm global), while the realm
 * global OBJECT is separate storage. The checker types `this`/`globalThis` as
 * `typeof globalThis`, which resolves to the static global-interface struct, so
 * every member fast path answers from that struct's declared fields — and a
 * `var` global has no field there. Measured 2026-08-15, script form, identical
 * on `--target standalone`, `--target wasi` AND gc:
 *
 *     var p1 = 7;  this.p1 === 7           // FALSE — reads `undefined`
 *     var p1 = 7;  typeof this.p1          // 'number'  (!)
 *
 * The `typeof` disagreeing with the value is the tell: `typeof` answers from the
 * struct's declared field TYPE while the value read falls to the struct's
 * missing-field fallback. Both must come from the module global instead — which
 * is what this arm does, so the two agree by construction.
 *
 * Returns `undefined` (fall through, byte-identical) unless the receiver
 * provably IS the realm global object AND the name is a `var`-declared module
 * global. `receiverIsRealmGlobalObject` already refuses module sources, shadowed
 * `globalThis`, and non-top-level `this`.
 */
function tryEmitRealmGlobalModuleGlobalRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  const globalIdx = ctx.moduleGlobals.get(propName);
  if (globalIdx === undefined) return undefined;
  if (!receiverIsRealmGlobalObject(ctx, fctx, expr.expression)) return undefined;
  fctx.body.push({ op: "global.get", index: globalIdx });
  return ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type ?? { kind: "externref" };
}

/**
 * (#4491) The BRACKET spelling of the #4500 Slice A arm above — `this["p"]` /
 * `globalThis["p"]` where `p` is a `var`-declared script global.
 *
 * §13.3.3 makes the two spellings the same [[Get]], and the compiler's own
 * global-object model makes them disagree: the dot form has read the module
 * global since Slice A, while the bracket form kept falling to the
 * `typeof globalThis` struct and answered `undefined`. Measured on this head:
 *
 *     var count = 0;   this.count      // 0          — Slice A
 *     var count = 0;   this["count"]   // undefined  — this arm
 *
 * Only a key the compiler can resolve to a fixed string qualifies; a genuinely
 * dynamic key (`this[k]`) keeps the existing dynamic read, which consults the
 * real global object. Declining is byte-identical.
 */
function tryEmitRealmGlobalModuleGlobalElementRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | undefined {
  if (!receiverIsRealmGlobalObject(ctx, fctx, expr.expression)) return undefined;
  const key = resolveComputedKeyExpression(ctx, expr.argumentExpression);
  if (key === undefined) return undefined;
  const globalIdx = ctx.moduleGlobals.get(key);
  if (globalIdx === undefined) return undefined;
  fctx.body.push({ op: "global.get", index: globalIdx });
  return ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type ?? { kind: "externref" };
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

  // ES5 §15.3.5.4 poison properties.
  //
  // Strict function objects have throwing `caller` and `arguments` accessors.
  // A sloppy function's `caller` additionally throws while its immediate
  // active caller is strict.  The latter uses the activation-local strictness
  // snapshot installed by function-poison-pill.ts; it is intentionally limited
  // to a proven self-reference, because `otherFn.caller` must reflect
  // *otherFn*'s activation rather than the current function's caller.
  const functionPoisonResult = tryCompileFunctionPoisonRead(ctx, fctx, expr);
  if (functionPoisonResult !== undefined) return functionPoisonResult;

  // Descriptor accessors are runtime state even when shape analysis widened
  // the receiver with a same-named field. Consult them before any struct-field
  // fast path so the getter remains observable after a rejected assignment.
  if (runtimeAccessorDescriptorKey(ctx, expr.expression, propName) !== undefined) {
    const runtimeResult = emitRuntimeDescriptorGet(ctx, fctx, expr.expression, propName, expr);
    if (runtimeResult !== null) return runtimeResult;
  }

  // (#3366 follow-up) A dynamic destructuring member write records its
  // identifier/property pair in the sidecar set. Read that value before any
  // static receiver-family shortcut can infer a field from the default
  // initializer's type; the destructured source may instead be any callable or
  // host object and must stay externref.
  if (ts.isIdentifier(expr.expression)) {
    const sidecarKey = `${expr.expression.text}:${propName}`;
    if (ctx.sidecarDefinedPropertyKeys.has(sidecarKey)) {
      const runtimeResult = emitRuntimeDescriptorGet(ctx, fctx, expr.expression, propName, expr, true);
      if (runtimeResult !== null) return runtimeResult;
    }
  }

  // (#4500 Slice A) `this.p` / `globalThis.p` for a `var`-declared global reads
  // the module global that stores it. Placed AFTER the runtime
  // accessor-descriptor and sidecar checks above, so genuine runtime state on
  // the global object still wins (e.g. a `defineProperty` accessor installed
  // over the name), and before the struct-shaped fast paths below, which are
  // exactly the ones that answer `undefined` from the global-interface struct.
  {
    const __r = tryEmitRealmGlobalModuleGlobalRead(ctx, fctx, expr, propName);
    if (__r !== undefined) return __r;
  }

  {
    const __r = tryDynamicReceiverRuntimeDispatchReads(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryConstructorPrototypeIdentity(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryOpenObjectDynamicGet(ctx, fctx, expr, propName);
    if (__r !== undefined) return __r;
  }

  {
    const __r = tryKnownFnctorDynamicObjectCarrierGet(ctx, fctx, expr, propName);
    if (__r !== undefined) return __r;
  }

  {
    const __r = tryPinnedAndDeleteAwareDynamicGet(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryBuiltinNamespaceDeferredReads(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  // (#3610) `<Builtin>.prototype.<brandedGetter>` — the prototype object never
  // carries the [[ViewedArrayBuffer]] / [[ArrayBufferData]] / [[DataView]]
  // internal slot the getter requires, so the spec's step-1 RequireInternalSlot
  // throws unconditionally. Must run BEFORE `tryBufferViewAttributeReads`, whose
  // arms key on the TS type NAME (`Uint8Array.prototype` has type `Uint8Array`)
  // and would `ref.cast` the prototype object to the backing vec — an
  // UNCATCHABLE `illegal cast` trap where a catchable TypeError is required.
  {
    const __r = tryBuiltinPrototypeGetterBrandThrow(ctx, fctx, expr, propName);
    if (__r !== undefined) return __r;
  }

  {
    const __r = tryBufferViewAttributeReads(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryStandaloneBuiltinAndWasiMemberReads(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryNativeErrorMemberRead(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryPrivateIdentifierRead(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = trySuperAndImportMetaRead(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryGlobalThisAndProcessRead(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryIdentifierNamespaceAndStaticReceiverRead(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  // (#4460) `class { static m() {} }.m` — same static-member emission as the
  // identifier band above, for a receiver that is an in-place class expression.
  {
    const __r = tryClassExpressionStaticMemberRead(ctx, fctx, expr, propName);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryPrototypeMethodAndArityReads(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryLengthAndNameReads(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryNamespaceConstantAndSymbolReads(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  {
    const __r = tryStringLengthIteratorAndExternClassReads(ctx, fctx, expr, propName, objType);
    if (__r !== PA_FALLTHROUGH) return __r;
  }

  // (#4483) LAST arm before the legacy tail: a provably-absent property of a
  // `number`/`boolean` primitive is `undefined` (§9.1 + §10.5), not the tail's
  // `ref.null.extern` placeholder. Placed here so every arm above keeps its
  // claim on the shapes it already handles; declines for every other receiver.
  {
    const __r = tryEmitPrimitiveAbsentPropertyRead(ctx, fctx, expr, propName);
    if (__r !== undefined) return __r;
  }

  return finalizeStructAndDynamicMemberGet(ctx, fctx, expr, propName, objType);
}

/**
 * Read a property as its boxed JavaScript value for a nullish comparison.
 *
 * Whole-program field inference may otherwise narrow a dynamic read to i32/f64.
 * That is valid for a matching struct, but an unrelated receiver can miss and
 * produce `undefined`; unboxing that miss to 0/false destroys the distinction
 * observed by `value == null` / `value != null`.
 */
export function canCompilePropertyAccessForNullishObservation(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): boolean {
  if (expr.questionDotToken) return false;
  const receiver = expr.expression;
  const receiverIsLocalDynamicValue =
    receiver.kind === ts.SyntaxKind.ThisKeyword ||
    (ts.isIdentifier(receiver) &&
      (fctx.localMap.has(receiver.text) ||
        (fctx.boxedCaptures?.has(receiver.text) ?? false) ||
        ctx.moduleGlobals.has(receiver.text) ||
        ctx.capturedGlobals.has(receiver.text)));
  if (!receiverIsLocalDynamicValue) return false;
  const receiverFact = ctx.oracle.typeFactOf(receiver).kind;
  return receiverFact === "any" || receiverFact === "unknown";
}

export function compilePropertyAccessForNullishObservation(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null {
  if (!canCompilePropertyAccessForNullishObservation(ctx, fctx, expr)) {
    return compilePropertyAccess(ctx, fctx, expr);
  }
  if (expr.questionDotToken) return compilePropertyAccess(ctx, fctx, expr);

  const propName = ts.isPrivateIdentifier(expr.name) ? "__priv_" + expr.name.text.slice(1) : expr.name.text;
  const getMemberIdx = reserveMemberGetDispatch(ctx, propName, fctx);
  const getIdx =
    getMemberIdx === undefined
      ? ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }])
      : undefined;
  const isUndefinedIdx = ensureExternIsUndefinedImport(ctx);
  flushLateImportShifts(ctx, fctx);

  const recvType = compileExpression(ctx, fctx, expr.expression);
  if (!recvType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (recvType.kind !== "externref") {
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  }
  const recvLocal = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: recvLocal });
  fctx.body.push({ op: "ref.is_null" });
  if (isUndefinedIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "call", funcIdx: isUndefinedIdx });
    fctx.body.push({ op: "i32.or" });
  }
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: typeErrorThrowInstrs(ctx, expr),
    else: [],
  });
  fctx.body.push({ op: "local.get", index: recvLocal });
  releaseTempLocal(fctx, recvLocal);
  if (getMemberIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: getMemberIdx });
    return { kind: "externref" };
  }
  if (getIdx !== undefined) {
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
    fctx.body.push({ op: "call", funcIdx: getIdx });
    return { kind: "externref" };
  }
  fctx.body.push({ op: "drop" });
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

export function compileExternPropertyGet(
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

  // (#3231) Native DisposableStack `.disposed` accessor in standalone /
  // nativeStrings mode → the struct's `disposed` flag instead of the
  // `DisposableStack_get_disposed` host import.
  if (className === "DisposableStack" && propName === "disposed" && ctx.nativeStrings) {
    addUnionImports(ctx);
    const disposedResult = tryCompileNativeDisposableStackDisposedGet(ctx, fctx, expr.expression);
    if (disposedResult !== undefined) return disposedResult as ValType;
  }

  // (#3234) Native SuppressedError `.error` / `.suppressed` reads in standalone /
  // nativeStrings mode → read from the `$Error_struct.$props` (fieldIdx 5) backing
  // object (where the dispose driver stores them via `__extern_set`) instead of the
  // `SuppressedError_get_error` / `SuppressedError_get_suppressed` host imports.
  // Identity-preserving: the stored externref is returned verbatim, so
  // `se.error === originalError` holds via `ref.eq`.
  if (className === "SuppressedError" && (propName === "error" || propName === "suppressed") && ctx.nativeStrings) {
    const ownFieldResult = emitExternrefBackedOwnFieldRead(ctx, fctx, expr, propName);
    if (ownFieldResult !== undefined) return ownFieldResult;
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
  fctx.body.push({ op: "i32.lt_u" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" as const },
    then: [
      { op: "local.get", index: vecLocal },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
      { op: "local.get", index: idxLocal },
      { op: "local.get", index: valLocal },
      { op: "array.set", typeIdx: arrTypeIdx },
    ],
    else: [],
  });
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

/**
 * (#2785) The TYPE-AWARE box ValType for an F1 plain-array OOB→`undefined` read,
 * reconstructed from the RECEIVER's TS element type. The boolean/symbol BRAND is
 * structural-only and is ERASED in `arrDef.element` (arrays dedupe by structure,
 * so `number[]` / `boolean[]` / `symbol[]` all share one `$vec_i32` struct — the
 * storage kind alone cannot tell them apart). So the box helper must be chosen
 * from the element's SEMANTIC type, recovered here from the TS type (the same
 * discipline `arrayElementIsBoolean` uses for `Array.prototype.join`).
 *
 * Returns the branded ValType F1 should box with, or `null` to DEFER (fall
 * through to the unchanged shared-helper read — bounds-checked type-default OOB,
 * never traps).
 *
 * Widened (F1 fires):
 *   - `f64` element → `{ kind:"f64" }` — `number[]`, unambiguous → `__box_number`
 *     (the existing, byte-identical path).
 *   - `i32` element whose receiver element TS type is genuinely `boolean` →
 *     `{ kind:"i32", boolean:true }` → `__box_boolean`. Re-enables the
 *     `boolean[]` arm #2766 deferred.
 *   - (HOST ONLY) `i32` element whose receiver element TS type is genuinely
 *     `symbol` → `{ kind:"i32", symbol:true }` → `__box_symbol` (#2792), via the
 *     identity-stable host symbol cache. The brand fires only for a genuine
 *     i32-storage `symbol[]`; `symbols-omitted` stays green regardless (that
 *     canary's `Object.values(any)` result is an externref array, so F1 defers).
 *
 * Deferred (returns `null`, unchanged from current main):
 *   - (STANDALONE) `symbol[]` — a native standalone `__box_symbol` needs a new
 *     `__box_symbol_struct` carrier; registering one unconditionally in
 *     `addUnionImportsAsNativeFuncs` shifted standalone type/func indices and
 *     broke ~311 unrelated tests with `illegal cast` traps in
 *     `__obj_find`/`__extern_set` (the type-index-shift / DCE-remap hazard).
 *     Carved to a follow-up; standalone `symbol[]` reads the i32 handle as before.
 *   - `i32` element that is NOT provably boolean or symbol — packed `number[]`
 *     (i32/i8/i16), or any other handle rep;
 *   - `externref` / `ref` / object elements.
 * Conservative: any checker failure, or a union whose non-nullish members are
 * not ALL boolean (or not ALL symbol), defers.
 */
function f1ElementBoxType(ctx: CodegenContext, expr: ts.ElementAccessExpression, elementType: ValType): ValType | null {
  if (elementType.kind === "f64") return { kind: "f64" };
  if (elementType.kind !== "i32") return null;
  let t: ts.Type;
  try {
    t = ctx.checker.getTypeAtLocation(expr);
  } catch {
    return null;
  }
  const parts = t.isUnion?.() ? t.types : [t];
  const valueParts = parts.filter((p) => (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
  if (valueParts.length === 0) return null;
  if (valueParts.every((p) => (p.flags & ts.TypeFlags.BooleanLike) !== 0)) {
    return { kind: "i32", boolean: true };
  }
  // (#2792) `symbol[]` — every value part is a Symbol. The element is an i32
  // handle; reconstruct the `symbol` brand (erased in `arrDef.element` by vec
  // dedup) so `coerceType(i32 → externref)` boxes via `__box_symbol` (the
  // identity-stable host symbol cache) rather than `__box_number`, which would
  // surface a Number for an OOB-safe symbol read.
  //
  // HOST MODE ONLY. Standalone defers `symbol[]` (returns null → the shared
  // bounded read, exactly as #2785 left it). A native standalone `__box_symbol`
  // would need a new `__box_symbol_struct` carrier; registering one
  // unconditionally in `addUnionImportsAsNativeFuncs` shifted standalone
  // type/func indices and broke ~311 unrelated standalone tests with
  // `illegal cast` traps in `__obj_find`/`__extern_set` (the
  // type-index-shift / DCE-remap hazard — see #2792 notes). The host arm is
  // index-safe (the js-host lane had zero regressions), so it ships; standalone
  // `symbol[]` is carved to a follow-up that can add the carrier without the
  // broad index shift.
  if (
    !noJsHost(ctx) &&
    valueParts.every((p) => (p.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) !== 0)
  ) {
    return { kind: "i32", symbol: true };
  }
  return null;
}

/**
 * (#2760 — hybrid type-soundness floor F1) SAFE plain-array OOB read for a
 * PRIMITIVE element (`f64` `number[]` / `i32` `boolean[]`): push the in-bounds
 * element **boxed to externref**, or JS `undefined` when the index is out of
 * bounds. An `f64`/`i32` cannot represent `undefined`, so the JS-correct (SAFE)
 * lowering of a read whose index is NOT provably in-bounds is the
 * boxed-or-undefined externref — never the type-default sentinel (sNaN / 0).
 * Per the hybrid invariant, the unboxed fast path is kept for the *proven*
 * in-bounds read (`isSafeBoundsEliminated`, the counted-loop proof) at the call
 * site; only the unproven read pays the box.
 *
 * **Call-site-owned policy, NOT a shared-helper flip.** The shared
 * `emitBoundsCheckedArrayGet` default is deliberately left untouched — its
 * `$__subview`, typed-array, and array-method internal callers keep their own
 * OOB semantics. Flipping the shared `useUndefinedSentinel` default was the S2
 * leak that regressed `Array.prototype.map`-on-array-like (#2198). This helper
 * is reached only from the two `compileElementAccessBody` plain-array value-read
 * call sites, gated on a genuine (non-typed-array) array receiver.
 *
 * Stack in:  [arrayref(non-null $arr), i32 index]
 * Stack out: [externref]
 */
function emitPlainArrayUndefinedOobGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrTypeIdx: number,
  elementType: ValType,
  // (#2785) The TYPE-AWARE box ValType. The array's storage kind (`elementType`)
  // is structurally dedup'd (so a `boolean[]` and a `number[]` share one
  // `$vec_i32` struct — the `boolean` brand is ERASED in `arrDef.element`), but
  // the box helper MUST be chosen by the element's SEMANTIC type. The call site
  // reconstructs the brand from the receiver TS type (`f1ElementBoxType`) and
  // passes it here as `boxType` (e.g. `{ kind:"i32", boolean:true }` for a
  // `boolean[]`), which `coerceType` reads to pick `__box_boolean` over
  // `__box_number`. Defaults to `elementType` (the byte-identical f64/number
  // path), so existing callers are unchanged.
  boxType: ValType = elementType,
  // (#2773 S7) Optional LOGICAL-length bound (see emitBoundsCheckedArrayGet):
  // a grown vec's backing capacity exceeds its length, so the in-bounds test
  // must use the vec's length field or an index in [length, capacity) reads
  // the boxed element DEFAULT (0/false) instead of `undefined`. Cloned per
  // push (never alias one Instr object into the body twice).
  lengthBoundInstrs?: Instr[],
): void {
  // Save index + array ref (consumed by the bounds test AND the bounded read).
  const idxLocal = allocLocal(fctx, `__oobu_idx_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__oobu_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: idxLocal });
  fctx.body.push({ op: "local.set", index: arrLocal });

  // (1) inBounds = (unsigned) idx < bound. A negative index wraps to a huge
  // unsigned value > any length, so it falls into the OOB (undefined) arm too.
  // (#2773 S7) bound = logical length when supplied, else backing capacity.
  const inBoundsLocal = allocLocal(fctx, `__oobu_in_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: idxLocal });
  if (lengthBoundInstrs) {
    fctx.body.push(...lengthBoundInstrs.map((i) => ({ ...i })));
  } else {
    fctx.body.push({ op: "local.get", index: arrLocal });
    fctx.body.push({ op: "array.len" });
  }
  fctx.body.push({ op: "i32.lt_u" });
  fctx.body.push({ op: "local.set", index: inBoundsLocal });

  // (2) Bounded native read (OOB → type-default, never traps), then box to
  // externref — emitted IMPERATIVELY on `fctx.body` so the box / undefined
  // late-imports (`__box_number`/`__box_boolean`/`__get_undefined`) register and
  // index-shift through the normal path. (An earlier version baked these funcIdxs
  // into detached branch `Instr[]`, which desynced indices — a duplicate
  // `__box_number` import and a wrong Math.pow arg value.) The branches of the
  // final select below carry ONLY `local.get`, so nothing inside them can shift.
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "local.get", index: idxLocal });
  emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elementType, ctx, false);
  let elementIsUndefinedLocal: number | undefined;
  if (ctx.usesArrayHoles && elementType.kind === "f64") {
    const rawValueLocal = allocLocal(fctx, `__oobu_raw_${fctx.locals.length}`, { kind: "f64" });
    elementIsUndefinedLocal = allocLocal(fctx, `__oobu_hole_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: rawValueLocal });
    fctx.body.push({ op: "local.get", index: rawValueLocal });
    emitIsUndefF64(fctx.body);
    fctx.body.push({ op: "local.set", index: elementIsUndefinedLocal });
    fctx.body.push({ op: "local.get", index: rawValueLocal });
  }
  // The value on the stack has the STORAGE kind (`elementType`, i8/i16 widened
  // to i32 by the read). Box it via the SEMANTIC `boxType` (which carries the
  // boolean/symbol brand) — its `.kind` agrees with the stack value's kind
  // (f64→f64, boolean i32→i32), so `coerceType`'s `from.kind` lines up while the
  // brand drives the helper choice (#2785).
  const boxFrom: ValType = boxType.kind === "i8" || boxType.kind === "i16" ? { kind: "i32" } : boxType;
  coerceType(ctx, fctx, boxFrom, { kind: "externref" });
  const boxedLocal = allocLocal(fctx, `__oobu_box_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: boxedLocal });

  // (3) `undefined` into a local (host `__get_undefined`, or `ref.null.extern`
  // under standalone where undefined ≡ null — both via emitUndefined).
  emitUndefined(ctx, fctx);
  const undefLocal = allocLocal(fctx, `__oobu_undef_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: undefLocal });

  // (4) result = inBounds ? boxedValue : undefined. Pure local.get branches.
  fctx.body.push({ op: "local.get", index: inBoundsLocal });
  if (elementIsUndefinedLocal !== undefined) {
    fctx.body.push({ op: "local.get", index: elementIsUndefinedLocal });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({ op: "i32.and" });
  }
  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: { kind: "externref" } },
    then: [{ op: "local.get", index: boxedLocal }],
    else: [{ op: "local.get", index: undefLocal }],
  });
}

/**
 * SAFE plain-array OOB read for a WasmGC reference element. The typed carrier
 * cannot encode the standalone `$undefined` singleton, so widen the unproven
 * read to externref: a present non-null element is converted at the boundary,
 * while an OOB index (and a nullable in-bounds hole) returns JS `undefined`.
 *
 * Like the primitive sibling above, this is call-site-owned. Array-method,
 * subview, typed-array, and proven-in-bounds reads retain their existing
 * representation and byte path.
 *
 * Stack in:  [arrayref(non-null $arr), i32 index]
 * Stack out: [externref]
 */
function emitReferenceArrayUndefinedOobGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrTypeIdx: number,
  elementType: Extract<ValType, { kind: "ref" | "ref_null" }>,
  lengthBoundInstrs?: Instr[],
): void {
  const idxLocal = allocLocal(fctx, `__oobr_idx_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__oobr_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: idxLocal });
  fctx.body.push({ op: "local.set", index: arrLocal });

  // Materialise the singleton before constructing detached branch bodies so
  // any late helper registration and function-index shift happens in-order.
  emitUndefined(ctx, fctx);
  const undefLocal = allocLocal(fctx, `__oobr_undef_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: undefLocal });

  const valueLocal =
    elementType.kind === "ref_null" ? allocLocal(fctx, `__oobr_value_${fctx.locals.length}`, elementType) : undefined;
  const presentValue: Instr[] =
    valueLocal === undefined
      ? [
          { op: "local.get", index: arrLocal },
          { op: "local.get", index: idxLocal },
          { op: "array.get", typeIdx: arrTypeIdx },
          { op: "extern.convert_any" },
        ]
      : [
          { op: "local.get", index: arrLocal },
          { op: "local.get", index: idxLocal },
          { op: "array.get", typeIdx: arrTypeIdx },
          { op: "local.tee", index: valueLocal },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "local.get", index: undefLocal }],
            else: [{ op: "local.get", index: valueLocal }, { op: "extern.convert_any" }],
          },
        ];

  fctx.body.push({ op: "local.get", index: idxLocal });
  if (lengthBoundInstrs) {
    fctx.body.push(...lengthBoundInstrs.map((instr) => ({ ...instr })));
  } else {
    fctx.body.push({ op: "local.get", index: arrLocal });
    fctx.body.push({ op: "array.len" });
  }
  fctx.body.push({ op: "i32.lt_u" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: presentValue,
    else: [{ op: "local.get", index: undefLocal }],
  });
}

/**
 * (#2798 — hybrid type-soundness audit Row 9) SAFE typed-array OOB read: push the
 * in-bounds element **boxed to a JS number externref**, or JS `undefined` when
 * the index is out of bounds (the *view length* is the bound, per the
 * integer-indexed exotic object semantics — TC39 §10.4.5 `[[Get]]` of an
 * out-of-range CanonicalNumericIndexString returns `undefined`).
 *
 * **Dedicated sibling of `emitPlainArrayUndefinedOobGet`, NOT a reuse.** Row 9
 * was deliberately carved out of #2760's plain-array F1 (`oobUndefined` requires
 * `classifyTypedArrayType(...) === "other"`). A typed-array read is *entangled*
 * with the shared `emitBoundsCheckedArrayGet` helper (#2198 S2 blast radius), so
 * this stays a **call-site-owned** policy — the shared helper default is
 * untouched, and `emitPlainArrayUndefinedOobGet` is left byte-identical. Three
 * reasons it cannot reuse the plain-array helper:
 *   1. **Signedness** — a packed `i8`/`i16` element reads with view-name-driven
 *      `array.get_s`/`array.get_u`. `emitPlainArrayUndefinedOobGet` calls the
 *      shared helper WITHOUT `signedness`, whose storage-kind heuristic
 *      (i8→get_u, i16→get_s) miscompiles `Int8Array` / `Uint16Array`. We thread
 *      `signedness` (the view name's, via `typedArrayPackedSignedness`) here.
 *   2. **Unsigned i32** — `Uint32Array` reads the full 32 bits as an UNSIGNED JS
 *      number (`f64.convert_i32_u`), not the signed conversion the box path uses.
 *   3. Typed-array elements are always `number` (the recognized views exclude
 *      BigInt64Array/BigUint64Array), so the box is plain `__box_number` —
 *      standalone-native (identical to R1's `number[]` floor), needing NO new
 *      carrier (unlike #2792's `symbol[]`). Ships host + standalone.
 *
 * Stack in:  [arrayref(non-null backing $arr), i32 index]
 * Stack out: [externref]
 */
function emitTypedArrayUndefinedOobGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrTypeIdx: number,
  // Storage kind of the packed/boxed element (i8/i16/i32 for integer views, f32
  // defensive, f64 for float views and host-mode integer views).
  elementType: ValType,
  // View-name-driven signedness (`"s"` Int*, `"u"` Uint*); undefined for float
  // views. Drives both the bounded read's extension AND the i32→f64 conversion.
  signedness: "s" | "u" | undefined,
): void {
  // Save index + array ref (consumed by the bounds test AND the bounded read).
  const idxLocal = allocLocal(fctx, `__taoob_idx_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__taoob_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: idxLocal });
  fctx.body.push({ op: "local.set", index: arrLocal });

  // (1) inBounds = (unsigned) idx < array.len — a negative index wraps to a huge
  // unsigned value > any length, so it falls into the OOB (undefined) arm.
  const inBoundsLocal = allocLocal(fctx, `__taoob_in_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_u" });
  fctx.body.push({ op: "local.set", index: inBoundsLocal });

  // (2) Bounded native read (OOB → type-default, never traps) WITH the view-name
  // signedness so a packed i8/i16 read sign/zero-extends correctly. Emitted
  // imperatively so the box/undefined late-imports register and index-shift
  // through the normal path (same discipline as emitPlainArrayUndefinedOobGet).
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "local.get", index: idxLocal });
  emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elementType, ctx, false, signedness);

  // Convert the storage value to a JS number (f64). i8/i16 are already
  // sign/zero-extended into a small-range i32 by the read, so `convert_i32_s` is
  // correct for both signed and unsigned narrow views. i32 storage is the full
  // 32 bits: unsigned for `Uint32Array` (`signedness === "u"`), signed for
  // `Int32Array`. f32 promotes; f64 is already a number.
  if (elementType.kind === "i8" || elementType.kind === "i16") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (elementType.kind === "i32") {
    fctx.body.push({ op: signedness === "u" ? "f64.convert_i32_u" : "f64.convert_i32_s" });
  } else if (elementType.kind === "f32") {
    fctx.body.push({ op: "f64.promote_f32" });
  }
  // Box the f64 to an externref number (host `__box_number`; standalone native).
  coerceType(ctx, fctx, { kind: "f64" }, { kind: "externref" });
  const boxedLocal = allocLocal(fctx, `__taoob_box_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: boxedLocal });

  // (3) `undefined` into a local (host `__get_undefined`, or `ref.null.extern`
  // under standalone where undefined ≡ null — both via emitUndefined).
  emitUndefined(ctx, fctx);
  const undefLocal = allocLocal(fctx, `__taoob_undef_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: undefLocal });

  // (4) result = inBounds ? boxedValue : undefined. Pure local.get branches.
  fctx.body.push({ op: "local.get", index: inBoundsLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: { kind: "externref" } },
    then: [{ op: "local.get", index: boxedLocal }],
    else: [{ op: "local.get", index: undefLocal }],
  });
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
  fctx.body.push({ op: "any.convert_extern" });
  const anyTmp = allocTempLocal(fctx, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyTmp });

  // Build the test/cast chain inside-out: the innermost else is the host path.
  const buildArm = (i: number): Instr[] => {
    if (i >= targetTypeIdxs.length) {
      // No compiled type matched → genuine host externref. Run the host path.
      const hostBody: Instr[] = [];
      const saved = fctx.body;
      fctx.body = hostBody;
      fctx.body.push({ op: "local.get", index: externrefTmp });
      elseEmit();
      fctx.body = saved;
      return hostBody;
    }
    const tIdx = targetTypeIdxs[i]!;
    const thenBody: Instr[] = [];
    const saved = fctx.body;
    fctx.body = thenBody;
    fctx.body.push({ op: "local.get", index: anyTmp });
    fctx.body.push({ op: "ref.cast", typeIdx: tIdx });
    thenEmit({ kind: "ref", typeIdx: tIdx });
    fctx.body = saved;
    return [
      { op: "local.get", index: anyTmp },
      { op: "ref.test", typeIdx: tIdx },
      {
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: thenBody,
        else: buildArm(i + 1),
      },
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
export function thisReceiverGuardTargets(
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

  // (#2051) Same nullable-primitive widening as `compileOptionalPropertyAccess`:
  // when the whole-chain static type is a nullable primitive (`number |
  // undefined` etc., collapsed by `resolveWasmType` to a bare f64/i32 that can't
  // represent `undefined`), widen the result to externref so the short-circuit
  // arm carries host `undefined` (`emitUndefined`) and the non-null arm boxes the
  // element value (`__box_number`/`__box_boolean` via the existing coerceType).
  // The else arm here ends in an `array.get`/`struct.get` (not a `call`), so —
  // unlike the optional-CALL arm (#2051 call-arm, deferred) — there is no
  // late-import index-shift hazard from pulling in the box helper after the read.
  // Boxes into a plain externref, NOT AnyValue, so the #1888 tag-5 ABI is intact.
  const widenToUndefinedExternref =
    (resultType.kind === "f64" || resultType.kind === "i32") && isNullablePrimitiveType(tsResultType);
  if (widenToUndefinedExternref) {
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
      // (#2051) externref result (incl. the nullable-primitive widening above) →
      // host `undefined` so `=== undefined` / `typeof` / `+` read it correctly.
      emitUndefined(ctx, fctx);
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
    // (#2051) externref result → host `undefined`. Build via a body-swap because
    // `emitUndefined` pushes to `fctx.body` and may flush late imports.
    const savedForThen = fctx.body;
    fctx.body = [];
    emitUndefined(ctx, fctx);
    thenInstrs = fctx.body;
    fctx.body = savedForThen;
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
  // (#2760 F1) value-context hint — forwarded to compileElementAccessBody so the
  // primitive OOB→undefined widening is suppressed in a numeric (f64/i32) context.
  expectedType?: ValType,
): ValType | null {
  // Optional chaining: a?.[i] (#2050). Short-circuits on a nullish base — the
  // index expression must NOT evaluate and the result must be undefined-
  // equivalent (§13.3.9 Optional Chains). Mirrors compileOptionalPropertyAccess.
  if (expr.questionDotToken) {
    return compileOptionalElementAccess(ctx, fctx, expr);
  }

  const functionPoisonResult = tryCompileFunctionPoisonRead(ctx, fctx, expr);
  if (functionPoisonResult !== undefined) return functionPoisonResult;

  // (#4491) `this["p"]` / `globalThis["p"]` on a `var`-declared script global —
  // the bracket twin of the #4500 Slice A dot arm.
  const realmGlobalElementRead = tryEmitRealmGlobalModuleGlobalElementRead(ctx, fctx, expr);
  if (realmGlobalElementRead !== undefined) return realmGlobalElementRead;

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

  // (#2933) Reflective read of a `Math`/`Number` namespace static CONSTANT via a
  // statically-resolvable computed key: `Math["PI"]`, `Number["MAX_SAFE_INTEGER"]`,
  // `const k = "PI"; Math[k]`. Fold to the SAME `f64.const` the syntactic dot read
  // (`Math.PI`) emits. Without this, standalone returns `0` for the computed form
  // (the generic dynamic computed read cannot resolve a namespace member — the
  // namespace has no `$Object` sidecar), and even host mode round-trips through
  // `__extern_get`. Gated on a resolvable key + a real namespace-constant name, so
  // non-constant keys (`Math[i]`) and non-constant members (`Math["max"]`) fall
  // through unchanged. Observationally identical in host mode.
  {
    const nsRecv = skipTransparentExpressions(expr.expression);
    if (ts.isIdentifier(nsRecv)) {
      const nsName = nsRecv.text;
      if (nsName === "Math" || nsName === "Number") {
        const isShadowed = fctx.localMap.has(nsName) || (fctx.boxedCaptures?.has(nsName) ?? false);
        if (!isShadowed) {
          const key = resolveComputedKeyExpression(ctx, expr.argumentExpression);
          if (key !== undefined) {
            const folded = tryEmitBuiltinNamespaceConstantValue(fctx, nsName, key);
            if (folded !== undefined) return folded;
          }
        }
      }
    }
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
          const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "static"));
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

  // #1910 R4 — String-wrapper integer-indexed read `w[i]` in standalone.
  // `new String("ab")[0]` is a String-exotic indexed own property (§10.4.3.x
  // CanonicalNumericIndexString) returning the 1-char substring at that index.
  // The wrapper is a `$Object` carrying its [[StringData]] native string in the
  // FLAG_INTERNAL slot, which the generic `$Object` index path can't read, so it
  // null-derefs. Recover the slot string via `__to_primitive(recv, "string")`,
  // then reuse the existing native `__str_charAt(flat, i)` helper (§22.1.3.1
  // semantics — out-of-range yields ""). Standalone + nativeStrings only; the
  // host path keeps its own String-exotic indexer.
  //
  // (#3304) ALSO fires for a PRIMITIVE-string receiver (`"XYZ"[2]`,
  // `s[s.length - 1]` — §10.4.3.5 StringGetOwnProperty via the String exotic
  // wrapper the spec conjures for member access). Neither this arm (wrapper-
  // only) nor #3027 below (non-numeric keys only) matched, so a numeric index
  // on a plain string fell to the generic `__extern_get` dynamic read — which
  // has no `$NativeString` arm and answered null (`s[2] === "Z"` → false;
  // `s[2].length` null-derefed). The oracle-side string predicate is the same
  // one #3027 uses; the emission is unchanged (`__to_primitive` of a primitive
  // string is identity per §7.1.1 step 1, so the wrapper slot-read doubles as
  // a pass-through).
  if (ctx.standalone && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    const recvWrapTsType = ctx.checker.getTypeAtLocation(expr.expression);
    if (
      (isStringWrapperType(recvWrapTsType) || ctx.oracle.staticJsTypeOf(expr.expression) === "string") &&
      isNumericIndexExpression(ctx, expr.argumentExpression, fctx)
    ) {
      // (#4232) …with §10.4.3.5 bounds, not §22.1.3.1 charAt bounds: an index
      // outside `[0, len)` — or a non-canonical one like `NaN` / `1.5` — is
      // `undefined`, not `""`. The arm used to end at `__str_charAt` and
      // return `ref $NativeString`, a type in which `undefined` is not even
      // representable; string-exotic-index.ts carries the guard (mirroring
      // #3973's, which already got this right for `any` receivers) and returns
      // `externref`.
      const exotic = emitStringExoticIndexGet(ctx, fctx, expr.expression, expr.argumentExpression);
      if (exotic) return exotic;
    }

    // (#3973) Same read, but the receiver is only KNOWN to be a string at
    // RUNTIME (`any`/`unknown` static type). Full rationale, spec shape and the
    // `moduleUsesDynTaView` deferral are documented in string-element-read.ts.
    if (
      !ctx.moduleUsesDynTaView &&
      isNumericIndexExpression(ctx, expr.argumentExpression, fctx) &&
      receiverMayBeNativeStringAtRuntime(ctx, expr.expression)
    ) {
      const guarded = emitGuardedNativeStringElementGet(ctx, fctx, expr.expression, expr.argumentExpression);
      if (guarded) return guarded;
    }
  }

  // (#3027) Computed non-numeric key on a string/String-wrapper-typed
  // receiver — `"str"["length"]`, `new String("x")["length"]`. Native-strings
  // mode has no `$Object` sidecar for a bare string or wrapper receiver, so
  // the generic "non-vec, non-tuple struct" fallback further below
  // (`extern.convert_any` + host `__extern_get`) always returns null for a
  // computed string-property read — there is no host to ask, and the struct
  // shape (len/off/data) never matches a property name like "length". The
  // dot form (`"str".length`) already dispatches correctly through
  // `compilePropertyAccess`; recompile this access as the equivalent dot form
  // (same receiver, same statically-resolved key) so it takes that exact path
  // instead of duplicating the logic here. Numeric keys are handled above
  // (#1910 R4) or by the array/vec paths below; only fires for a
  // non-numeric, statically-resolvable key.
  if (
    ctx.nativeStrings &&
    ctx.anyStrTypeIdx >= 0 &&
    !isNumericIndexExpression(ctx, expr.argumentExpression, fctx) &&
    // (#1930) Query the receiver's static string-ness via the TypeOracle, not
    // the raw checker. `isStringType` matched BOTH a primitive string and the
    // `String` wrapper object; the oracle equivalents are
    // `staticJsTypeOf === "string"` (primitive) OR `builtinReceiverOf ===
    // "String"` (`new String(x)` wrapper), which together cover the same set.
    (ctx.oracle.staticJsTypeOf(expr.expression) === "string" ||
      ctx.oracle.builtinReceiverOf(expr.expression) === "String")
  ) {
    const key = resolveComputedKeyExpression(ctx, expr.argumentExpression);
    if (key !== undefined) {
      const syntheticProp = ts.factory.createPropertyAccessExpression(expr.expression, key);
      ts.setTextRange(syntheticProp, expr);
      (syntheticProp as unknown as { parent: ts.Node }).parent = expr.parent;
      return compilePropertyAccess(ctx, fctx, syntheticProp);
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
            fctx.body.push({ op: "ref.null.extern" });
          }
        },
        () => {
          const hostResult = compileElementAccessBody(ctx, fctx, expr, { kind: "externref" });
          if (hostResult && hostResult.kind !== "externref") {
            coerceType(ctx, fctx, hostResult, resultType);
          } else if (!hostResult) {
            fctx.body.push({ op: "ref.null.extern" });
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
    return compileElementAccessBody(ctx, fctx, expr, nonNullObjType, expectedType);
  }

  // Null-guard for externref: null[x] and undefined[x] throw TypeError (#775)
  if (objType.kind === "externref") {
    if (!isProvablyNonNull(expr.expression, ctx.checker)) {
      emitNullCheckThrow(ctx, fctx, objType, expr);
    }
  }

  return compileElementAccessBody(ctx, fctx, expr, objType, expectedType);
}

/**
 * (#2166 PR-C2) True when an element-access index expression is *provably*
 * numeric, so a standalone externref read can route through the positional
 * `__extern_get_idx(v, f64)` instead of the string-keyed `__extern_get`.
 *
 * Conservative on purpose: a numeric literal (`a[1]`), or a static type that is
 * number-like with no string/symbol component, qualifies. An `any`/`unknown`/
 * `string`/union/symbol-keyed index does NOT (it may be a genuine string
 * property key, which `__extern_get` must keep handling). False on any checker
 * error.
 */
export function isNumericIndexExpression(ctx: CodegenContext, index: ts.Expression, fctx?: FunctionContext): boolean {
  // Strip parens / `as` wrappers so `a[(i)]` / `a[i as number]` still match.
  let inner: ts.Expression = index;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
    inner = inner.expression;
  }
  if (ts.isNumericLiteral(inner)) return true;
  // The checker may infer a function-scoped var from a later numeric
  // initializer even though a preceding for-in writes property-key strings
  // into it. Its actual boxed slot is authoritative at computed access sites.
  if (ts.isIdentifier(inner) && fctx?.forInIdentifierVars?.has(inner.text)) return false;
  let t: ts.Type;
  try {
    t = ctx.checker.getTypeAtLocation(inner);
  } catch {
    return false;
  }
  // A union (e.g. `number | string`) or `any`/`unknown` is ambiguous — keep the
  // string-key path. Only a pure number-like type routes positionally.
  if (t.isUnion?.()) return false;
  const ambiguous = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike | ts.TypeFlags.ESSymbolLike;
  if ((t.flags & ambiguous) !== 0) return false;
  return (t.flags & ts.TypeFlags.NumberLike) !== 0;
}

/**
 * (#2773) True when an element-access index is a **dynamic `any`/`unknown`-typed**
 * expression — the callback `idx` param of an `Array.prototype.{map,forEach,…}`
 * callback passed as a *named function declaration* (TS does not contextually
 * type such params → they are implicit `any`). This is the complement of
 * {@link isNumericIndexExpression}: a statically-numeric index routes through the
 * `#2784` native-vec read; a dynamic `any` index needs the runtime-guarded
 * `__vec_len`/`__vec_get` read (property-access dynamic arm) so that `obj[idx]`
 * on a native WasmGC vec coerced to `externref` returns the real element instead
 * of the host `__extern_get` `undefined` (the vec is opaque to the host).
 *
 * A pure `string`/`symbol` key (a genuine property name, not an array index) and
 * a union type are EXCLUDED — they stay on the string-keyed `__extern_get`.
 */
export function isAnyTypedIndexExpression(ctx: CodegenContext, index: ts.Expression): boolean {
  let inner: ts.Expression = index;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
    inner = inner.expression;
  }
  // A numeric literal is statically numeric → handled by the #2784 path.
  if (ts.isNumericLiteral(inner)) return false;
  // Route through the oracle (#1930): `typeFactOf` yields `{kind:"any"}` /
  // `{kind:"unknown"}` for an implicit-any index and `{kind:"union"}` for a
  // union (⇒ excluded), so the check is exactly "the index type is `any`/
  // `unknown`". A string/symbol key resolves to a different fact kind ⇒ excluded.
  const fact = ctx.oracle.typeFactOf(inner);
  return fact.kind === "any" || fact.kind === "unknown";
}

/**
 * (#3169) True when an expression's receiver chain is rooted at the
 * MATERIALIZED `arguments` object (`arguments`, `arguments[2]`,
 * `arguments[2][arguments[1]]`, `(arguments[0]).x[y]`, …). Used to exclude
 * such reads from the standalone dynamic-index positional retry — the
 * materialized arguments state is not reliably positional for
 * 0-declared-param HOF callbacks, so those reads keep the byte-exact legacy
 * `__extern_get` behaviour (arguments fidelity is a separate follow-on).
 */
function isArgumentsRootedExpression(fctx: FunctionContext, node: ts.Expression): boolean {
  let cur: ts.Expression = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = (cur as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.TypeAssertion).expression;
      continue;
    }
    if (ts.isElementAccessExpression(cur) || ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    break;
  }
  return ts.isIdentifier(cur) && cur.text === "arguments" && fctx.localMap.has("arguments");
}

/** Inner element access logic — assumes objType is on the stack and non-null */
export function compileElementAccessBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
  objType: ValType,
  // (#2760 F1) The value-context hint the caller is reading this element into.
  // When it is a NUMERIC kind (f64/i32) the primitive OOB→undefined widening is
  // suppressed: in a numeric context `undefined` is not observable anyway (it
  // coerces to NaN/0, which is the JS-correct `ToNumber(undefined)`), and — more
  // importantly — widening would box→externref and add a late import *during*
  // argument compilation, shifting a funcIdx a numeric-consuming caller may have
  // already captured (e.g. `Math.pow(a[i], …)` grabs `Math_pow` before compiling
  // its args). Keeping the unboxed f64/i32 in numeric context avoids that.
  expectedType?: ValType,
): ValType | null {
  // Externref element access: obj[key] → host import __extern_get(obj, externref) → externref
  if (objType.kind === "externref") {
    // (#2784 S3) Native-vec-aware element read. A numeric `recv[i]` on an
    // `any`/externref receiver that is actually a NATIVE vec (a reconstructed-
    // fnctor `T[]` field read as externref — acorn's `this.scopeStack[i]`) MUST use
    // the WASM `__vec_get` (native `array.get`), NOT the host `__extern_get`. The
    // host can't read the opaque WasmGC vec, so a host string-keyed read of a
    // native vec returns null → the element's struct identity is lost (the #2784
    // storage split, symmetric with the `.push` fix in calls.ts). Guard: ref.test
    // the vec carriers; on hit call `__vec_get(recv, i32(idx))`, else the host
    // `__extern_get(recv, boxed-idx)`. Host/gc only (standalone's `__extern_get_idx`
    // already ref.tests `$ObjVec`); numeric index only (a string key is a genuine
    // property, never a vec index).
    if (!ctx.standalone && ctx.vecTypeMap.size > 0 && isNumericIndexExpression(ctx, expr.argumentExpression, fctx)) {
      // recv externref is on the stack → recvLocal (allocated FIRST so the local
      // numbering of recv / idx / anyTmp is unchanged from before #3007).
      const recvLocal = allocLocal(fctx, `__nve_recv_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: recvLocal });
      // (#3007) index → f64 → idxLocal, compiled BEFORE the fast-path funcIdxs are
      // captured. A computed index lowers reads that can register late imports and shift every DEFINED-function
      // index — including `__vec_get`. The pre-#3007 order captured `__vec_get`
      // BEFORE this compile, so the index's imports left it stale; the desynced
      // `then` arm emitted an invalid instruction stream (`f64.convert_i32_s` on
      // the externref receiver → "expected i32, found externref", invalid Wasm).
      // Resolving imports and `__vec_get` AFTER the index compile (single flush)
      // keeps every funcIdx live through emission. For a non-import-adding
      // index (e.g. a literal) the import order is identical, so valid output is
      // byte-for-byte unchanged.
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
      const idxLocal = allocLocal(fctx, `__nve_idx_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: idxLocal });
      const extGetIdx = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      const boxNumIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      const vgIdx = resolveVecHostBridgeHelper(ctx, "get") ?? reserveVecMethodHelper(ctx, "get");
      if (vgIdx !== undefined && extGetIdx !== undefined && boxNumIdx !== undefined) {
        // isVec = OR of ref.test over the registered vec carriers.
        const anyTmp = allocLocal(fctx, `__nve_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
        fctx.body.push({ op: "local.get", index: recvLocal });
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "local.set", index: anyTmp });
        let emitted = false;
        for (const vi of new Set(ctx.vecTypeMap.values())) {
          fctx.body.push({ op: "local.get", index: anyTmp });
          fctx.body.push({ op: "ref.test", typeIdx: vi });
          if (emitted) fctx.body.push({ op: "i32.or" });
          emitted = true;
        }
        // THEN: __vec_get(recv, i32(idx)).
        const thenStart = fctx.body.length;
        fctx.body.push({ op: "local.get", index: recvLocal });
        fctx.body.push({ op: "local.get", index: idxLocal });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        fctx.body.push({ op: "call", funcIdx: vgIdx });
        const thenInstrs = fctx.body.splice(thenStart);
        // ELSE: __extern_get(recv, box(idx)).
        const elseStart = fctx.body.length;
        fctx.body.push({ op: "local.get", index: recvLocal });
        fctx.body.push({ op: "local.get", index: idxLocal });
        fctx.body.push({ op: "call", funcIdx: boxNumIdx });
        fctx.body.push({ op: "call", funcIdx: extGetIdx });
        const elseInstrs = fctx.body.splice(elseStart);
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: thenInstrs,
          else: elseInstrs,
        });
        return { kind: "externref" };
      }
      // (#3007) Defensive fallback — recv/idx were consumed into locals above, so
      // if the fast-path imports are somehow unavailable we must not fall through
      // to the generic path (which expects recv on the stack). Emit the generic
      // host read from the stored locals. Unreachable in host mode (the box/extern
      // imports are always registerable), so this changes no valid output.
      fctx.body.push({ op: "local.get", index: recvLocal });
      if (boxNumIdx !== undefined && extGetIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: idxLocal });
        fctx.body.push({ op: "call", funcIdx: boxNumIdx });
        fctx.body.push({ op: "call", funcIdx: extGetIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    // (#2773) DYNAMIC-index native-vec element read. The #2784 arm above only
    // fires for a STATICALLY-numeric index. When the index is a dynamic
    // `any`/`unknown` expression — the untyped `idx` param of an
    // `Array.prototype.{map,forEach,filter,reduce,…}` callback passed as a NAMED
    // function declaration (TS does not contextually type such params) — the
    // receiver `obj` (the callback's 3rd `array` arg) is a native WasmGC vec
    // coerced to `externref`, opaque to the host. The old fallback below routes
    // `obj[idx]` to the host `__extern_get`, which cannot read the vec → returns
    // `undefined`, so `obj[idx] !== val` in the "callbackfn called with correct
    // parameters" test262 family is wrongly true. Route through the native
    // `__vec_len` (0 for a non-vec ⇒ doubles as the vec-vs-host-object
    // discriminator AND the in-bounds guard) + `__vec_get` (per-element-kind read
    // → boxed carrier externref; already maps `$Hole → undefined`). For a non-vec
    // receiver, an OOB index, or a non-integer/string key the guard is false and
    // we fall to the host `__extern_get(recv, key)` — byte-for-byte the same
    // observable result the old path produced for those cases (a host object read
    // / `undefined`), so this arm only *adds* the correct native-vec answer.
    // Host/gc only: standalone has its own `__extern_get_idx` `$ObjVec` path.
    if (!ctx.standalone && ctx.vecTypeMap.size > 0 && isAnyTypedIndexExpression(ctx, expr.argumentExpression)) {
      // recv externref is on the stack → recvLocal (allocated FIRST so local
      // numbering is stable through the index compile, per #3007).
      const recvLocal = allocLocal(fctx, `__dyn_recv_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: recvLocal });
      // Compile the key as externref FIRST (preserves a string key's identity for
      // the host fallback) BEFORE capturing helper funcIdxs — the key's own
      // lowering may register late imports that shift them (#3007). Single flush.
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
      const keyLocal = allocLocal(fctx, `__dyn_key_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: keyLocal });
      // (#3511) Symbol-safe index probe: `__any_to_index` returns NaN (not throw)
      // for a Symbol/BigInt key, so `obj[symbol]` falls to `__extern_get(recv,
      // key)` below instead of throwing "Cannot convert a Symbol value to a
      // number". Numeric/string keys match `__unbox_number` byte-for-byte.
      const unboxIdx = ensureLateImport(ctx, "__any_to_index", [{ kind: "externref" }], [{ kind: "f64" }]);
      const extGetIdx = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      const vgIdx = resolveVecHostBridgeHelper(ctx, "get") ?? reserveVecMethodHelper(ctx, "get");
      const vlIdx = resolveVecHostBridgeHelper(ctx, "len") ?? reserveVecMethodHelper(ctx, "len");
      if (unboxIdx !== undefined && extGetIdx !== undefined && vgIdx !== undefined && vlIdx !== undefined) {
        const idxF64 = allocLocal(fctx, `__dyn_idxf_${fctx.locals.length}`, { kind: "f64" });
        const idxI32 = allocLocal(fctx, `__dyn_idxi_${fctx.locals.length}`, { kind: "i32" });
        // idxF64 = Number(key); idxI32 = truncated integer. Number(non-numeric
        // string) is NaN, and i32.trunc_sat(NaN) = 0 — the integer round-trip
        // check below rejects it so a genuine string key never mis-indexes.
        fctx.body.push({ op: "local.get", index: keyLocal });
        fctx.body.push({ op: "call", funcIdx: unboxIdx });
        fctx.body.push({ op: "local.tee", index: idxF64 });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        fctx.body.push({ op: "local.set", index: idxI32 });
        // cond = idxI32 >= 0 && idxI32 < __vec_len(recv) && f64(idxI32) === idxF64
        fctx.body.push({ op: "local.get", index: idxI32 });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.ge_s" });
        fctx.body.push({ op: "local.get", index: idxI32 });
        fctx.body.push({ op: "local.get", index: recvLocal });
        fctx.body.push({ op: "call", funcIdx: vlIdx });
        fctx.body.push({ op: "i32.lt_s" });
        fctx.body.push({ op: "i32.and" });
        fctx.body.push({ op: "local.get", index: idxI32 });
        fctx.body.push({ op: "f64.convert_i32_s" });
        fctx.body.push({ op: "local.get", index: idxF64 });
        fctx.body.push({ op: "f64.eq" });
        fctx.body.push({ op: "i32.and" });
        // then: __vec_get(recv, idxI32) — in-bounds native element (boxed carrier)
        const thenInstrs: Instr[] = [
          { op: "local.get", index: recvLocal },
          { op: "local.get", index: idxI32 },
          { op: "call", funcIdx: vgIdx },
        ];
        // else: __extern_get(recv, key) — non-vec host object, OOB, or string key
        const elseInstrs: Instr[] = [
          { op: "local.get", index: recvLocal },
          { op: "local.get", index: keyLocal },
          { op: "call", funcIdx: extGetIdx },
        ];
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: thenInstrs,
          else: elseInstrs,
        });
        return { kind: "externref" };
      }
      // Defensive fallback — helpers unavailable (unreachable in host mode). Read
      // via the host from the stored key so the stack stays balanced.
      fctx.body.push({ op: "local.get", index: recvLocal });
      fctx.body.push({ op: "local.get", index: keyLocal });
      if (extGetIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: extGetIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    // (#3169) STANDALONE twin of the #2773 dynamic-`any`-index arm above (which
    // is host/gc-only). The untyped `idx` param of a named-function-declaration
    // HOF callback (`function cb(val, idx, obj) { obj[idx] … }`) is implicit
    // `any`, so `isNumericIndexExpression` is false and the read previously fell
    // to the string-keyed `__extern_get(recv, boxed-number-key)` — which finds
    // nothing on a vec/`$ObjVec`/closed-struct receiver and answered `undefined`
    // (the test262 "callbackfn called with correct parameters" `-c-ii` family:
    // `obj[idx] !== val` wrongly true).
    //
    // ORDER: the legacy `__extern_get(recv, key)` runs FIRST and stays
    // authoritative — some producers (the materialized `arguments` object) key
    // their `$Object` entries by BOXED NUMBER, which `__extern_get` finds
    // directly but a `number_toString` re-canonicalized key would MISS, so
    // positional-first regressed the `arguments[2][arguments[1]]` c-ii-13
    // family. Only a MISS (null / undefined) with a NUMERIC, non-string key
    // retries through the positional `__extern_get_idx(recv, f64)` — the
    // standalone reader that dispatches vecs, `$ObjVec`, array-like `$Object`
    // (canonical `number_toString` key, #2551) AND the #3169 closed-struct
    // array-like arms. A genuine string key keeps the byte-exact old result
    // (the string gate below); so does every read the old path answered.
    // Standalone only (NOT wasi: the `$Object` delegation arm inside
    // `__extern_get_idx` is `ctx.standalone`-gated, same reasoning as the
    // #2166 numeric arm below).
    if (
      ctx.standalone &&
      isAnyTypedIndexExpression(ctx, expr.argumentExpression) &&
      // EXCLUSION — a read whose receiver chain is rooted at the materialized
      // `arguments` object (`arguments[i]`, `arguments[2][arguments[1]]`, …)
      // keeps the legacy `__extern_get` path untouched. The materialized
      // arguments state is not reliably positional for 0-declared-param
      // callbacks (the HOF inline loop pushes only the DECLARED params, so
      // `arguments` there is synthesized, order-fragile state); the positional
      // retry surfaced half-correct values that flipped the vacuously-passing
      // `arguments[2][arguments[1]] === arguments[0]` c-ii-13 family to real
      // failures. Real arguments-fidelity work is a follow-on; this arm only
      // targets HOF callback params (`obj[idx]`) and other genuine receivers.
      !isArgumentsRootedExpression(fctx, expr.expression)
    ) {
      // recv externref is on the stack → recvLocal (allocated FIRST so local
      // numbering is stable through the key compile, per #3007).
      const recvLocal = allocLocal(fctx, `__sdyn_recv_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: recvLocal });
      // Compile the key as externref FIRST (preserves a string key's identity
      // for the string-keyed read) BEFORE capturing helper funcIdxs — the
      // key's own lowering may register late imports that shift them (#3007).
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
      const keyLocal = allocLocal(fctx, `__sdyn_key_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: keyLocal });
      const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      const getIdxFn = ensureLateImport(
        ctx,
        "__extern_get_idx",
        [{ kind: "externref" }, { kind: "f64" }],
        [{ kind: "externref" }],
      );
      const extGetIdx = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      // Miss gate: under the #2106 S1 singleton regime a missing property reads
      // back as the (non-null) undefined singleton, so `ref.is_null` alone
      // under-detects the miss; `__extern_is_undefined` covers it (same gate as
      // the member-get dispatcher's #2963 miss test).
      const isUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      if (unboxIdx !== undefined && getIdxFn !== undefined && extGetIdx !== undefined) {
        const resLocal = allocLocal(fctx, `__sdyn_res_${fctx.locals.length}`, { kind: "externref" });
        const idxF64 = allocLocal(fctx, `__sdyn_idxf_${fctx.locals.length}`, { kind: "f64" });
        // res = __extern_get(recv, key) — the legacy read, byte-exact.
        fctx.body.push({ op: "local.get", index: recvLocal });
        fctx.body.push({ op: "local.get", index: keyLocal });
        fctx.body.push({ op: "call", funcIdx: extGetIdx });
        fctx.body.push({ op: "local.set", index: resLocal });
        // miss = res == null || __extern_is_undefined(res)
        fctx.body.push({ op: "local.get", index: resLocal });
        fctx.body.push({ op: "ref.is_null" });
        if (isUndefIdx !== undefined) {
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } as ValType },
            then: [{ op: "i32.const", value: 1 }],
            else: [
              { op: "local.get", index: resLocal },
              { op: "call", funcIdx: isUndefIdx },
            ],
          });
        }
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // idxF64 = Number(key); NaN (non-numeric key) → keep the miss.
            { op: "local.get", index: keyLocal },
            { op: "call", funcIdx: unboxIdx },
            { op: "local.tee", index: idxF64 },
            { op: "local.get", index: idxF64 },
            { op: "f64.eq" }, // not-NaN ⇒ numeric key
            // …AND the key is not a genuine STRING. The native `__unbox_number`
            // is the ToNumber engine, so a numeric-looking string key ("1e3",
            // "01") would unbox non-NaN and retry positionally under a
            // canonically DIFFERENT key (get_idx re-stringifies 1000 as
            // "1000" ≠ "1e3"). String keys keep the exact old miss.
            ...[ctx.anyStrTypeIdx, ctx.nativeStrTypeIdx]
              .filter((t) => t >= 0)
              .flatMap((strTypeIdx): Instr[] => [
                { op: "local.get", index: keyLocal },
                { op: "any.convert_extern" },
                { op: "ref.test", typeIdx: strTypeIdx },
                { op: "i32.eqz" },
                { op: "i32.and" },
              ]),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: recvLocal },
                { op: "local.get", index: idxF64 },
                { op: "call", funcIdx: getIdxFn },
                { op: "local.set", index: resLocal },
              ],
            },
          ],
        });
        fctx.body.push({ op: "local.get", index: resLocal });
        if (ctx.runtimeEvalGlobalFunctionBindings === true) {
          emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
        }
        return { kind: "externref" };
      }
      // Defensive fallback — helpers unavailable. Read via the string-keyed
      // path from the stored locals so the stack stays balanced.
      fctx.body.push({ op: "local.get", index: recvLocal });
      fctx.body.push({ op: "local.get", index: keyLocal });
      if (extGetIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: extGetIdx });
        if (ctx.runtimeEvalGlobalFunctionBindings === true) {
          emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
        }
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    // (#2166 PR-C2) A NUMERIC index on a standalone externref must go through
    // `__extern_get_idx(v, f64)`, not the string-keyed `__extern_get`. The
    // wrapped value can be an `$ObjVec` (the externref array vector produced by
    // `Object.values`/`Object.entries`, by `JSON.parse` of an array, and by the
    // array-method machinery) whose elements are positional, not string-keyed —
    // `__extern_get(v, "1")` finds nothing and returns null, so `v[1]` read 0.
    // `__extern_get_idx` ref.tests `$ObjVec` and returns `data[i]`; for an
    // array-like `$Object` it delegates to `__extern_get(v, ToString(i))` (its
    // #2036 arm), so it is a correct superset of the string-key path for a
    // numeric index — but ONLY in `--target standalone`: that `$Object`
    // delegation arm is gated on `objArrayLikeArms = ctx.standalone` in
    // object-runtime.ts, so under `--target wasi` `__extern_get_idx` returns the
    // null sentinel for a genuine `$Object`, which would break a plain-object
    // numeric read. Hence this is scoped to `ctx.standalone` only (NOT wasi);
    // wasi and host mode keep the existing `__extern_get` path. A non-numeric
    // (string/symbol/computed) key always stays on `__extern_get`.
    if (ctx.standalone && isNumericIndexExpression(ctx, expr.argumentExpression, fctx)) {
      // (#3057) A boxed `$__ta_dyn_view` (dynamic `new <ctorVar>(rab)`) reaches this
      // arm as an `any`/externref receiver with a numeric index. Its element kind is
      // a RUNTIME field, so `__extern_get_idx` can't byte-decode it (reads returned
      // 0 — #3054 D+E banked this). Route through the runtime-kind byte codec, which
      // `ref.test $__ta_dyn_view` FIRST and — crucially — falls through to the EXACT
      // `__extern_get_idx` path below for any non-dyn-view receiver (plain arrays /
      // `$ObjVec` / `$Object`), so plain-array `any[i]` is unaffected. Gated on the
      // module pre-scan (`moduleUsesDynTaView`) so a helper compiled before the
      // construct still routes correctly; byte-inert when the module has no
      // dynamic TA view.
      if (ctx.moduleUsesDynTaView) {
        const dynR = emitTaDynViewElementGet(ctx, fctx, expr.argumentExpression, (e, h) =>
          compileExpression(ctx, fctx, e, h),
        );
        if (dynR) return dynR;
      }
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
      const getIdxFn = ensureLateImport(
        ctx,
        "__extern_get_idx",
        [{ kind: "externref" }, { kind: "f64" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (getIdxFn !== undefined) {
        fctx.body.push({ op: "call", funcIdx: getIdxFn });
        if (ctx.runtimeEvalGlobalFunctionBindings === true) {
          emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
        }
        return { kind: "externref" };
      }
      return null;
    }
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
      if (ctx.runtimeEvalGlobalFunctionBindings === true) {
        emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
      }
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
      if (ctx.runtimeEvalGlobalFunctionBindings === true) {
        emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
      }
      return { kind: "externref" };
    }
    return null;
  }

  const typeIdx = (objType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // (#2357/#47) `$__subview` receiver (TypedArray subarray) — read the SHARED
  // parent buffer at `data[byteOffset + i]`. Must run BEFORE the tuple/struct-field
  // check below: a `$__subview` is a 3-field struct {length, data, byteOffset}, so
  // `isVecStructAccess` (exactly 2 fields) is false and the tuple path would
  // mis-handle it. Compile-time discriminated by the receiver typeIdx, so plain
  // arrays (vec struct, not subview) never reach this arm.
  // (#3054 B1) `$__ta_view` receiver (shared-backing TypedArray over an
  // ArrayBuffer) — byte-decode `ta[i]` little-endian from the SHARED buffer vec
  // at `byteOffset + i*width`. Must run BEFORE the tuple/struct-field check (a
  // `$__ta_view` is a 3-field {length, buf, byteOffset} struct). Compile-time
  // discriminated by receiver typeIdx, so plain arrays / native TAs never reach
  // this arm.
  if (typeDef?.kind === "struct" && isTaViewTypeIdx(ctx, typeIdx)) {
    const r = emitTaViewElementGet(ctx, fctx, typeIdx, expr.argumentExpression, (e, h) =>
      compileExpression(ctx, fctx, e, h),
    );
    if (r) return r;
  }

  if (typeDef?.kind === "struct" && isSubviewTypeIdx(ctx, typeIdx)) {
    const subArrTypeIdx = getSubviewArrTypeIdx(ctx, typeIdx);
    const subArrDef = ctx.mod.types[subArrTypeIdx];
    if (!subArrDef || subArrDef.kind !== "array") {
      reportErrorNoNode(ctx, "Element access: subview data is not an array");
      return null;
    }
    const svLocal = allocLocal(fctx, `__sv_recv_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
    fctx.body.push({ op: "local.set", index: svLocal });
    // data = sv.data (the SHARED parent backing array, field 1)
    fctx.body.push({ op: "local.get", index: svLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
    // index = sv.byteOffset + i
    fctx.body.push({ op: "local.get", index: svLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 2 }); // byteOffset
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "i32" });
    fctx.body.push({ op: "i32.add" });
    const svValueType: ValType =
      subArrDef.element.kind === "i8" || subArrDef.element.kind === "i16" ? { kind: "i32" } : subArrDef.element;
    emitBoundsCheckedArrayGet(fctx, subArrTypeIdx, subArrDef.element);
    return svValueType;
  }

  // Handle tuple struct — element access with literal index → struct.get
  if (typeDef?.kind === "struct") {
    const isVecStructAccess =
      typeDef.fields[0]?.name === "length" &&
      typeDef.fields[1]?.name === "data" &&
      (typeDef.fields.length === 2 ||
        (typeDef.fields.length === 3 && typeDef.fields[2]?.name === "raw") ||
        // #1914/#2588/#2589 — $__regexp_match_vec: the vec subtype carrying the
        // spec exec/match result fields. Indexed reads use the same
        // {length, data} prefix; index/input/groups/indices are property reads,
        // not elements. Accept the 4-field (#1914) and 6-field (#2588 groups +
        // #2589 indices) shapes.
        (typeDef.fields.length >= 4 && typeDef.fields[2]?.name === "index" && typeDef.fields[3]?.name === "input"));

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
              const elGetterDef = definedFuncAt(ctx, funcIdx);
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

        const sidecarKey = ts.isIdentifier(expr.expression) ? `${expr.expression.text}:${fieldName}` : undefined;
        const isDynamicSidecarRead = sidecarKey !== undefined && ctx.sidecarDefinedPropertyKeys.has(sidecarKey);
        if (runtimeAccessorDescriptorKey(ctx, expr.expression, fieldName) !== undefined || isDynamicSidecarRead) {
          const runtimeResult = emitRuntimeDescriptorGet(
            ctx,
            fctx,
            expr.expression,
            fieldName,
            expr,
            isDynamicSidecarRead,
          );
          if (runtimeResult !== null) return runtimeResult;
        }

        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx >= 0) {
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          return typeDef.fields[fieldIdx]!.type;
        }
      }
      // (#2582/#1712) Non-literal NUMERIC key on a struct whose fields are
      // numeric-named (an object literal `{ 9: …, 10: … }` read via
      // `obj[ecmaVersion]` with a runtime key) → emit a static key-switch of
      // `struct.get` per numeric field instead of the dynamic `__extern_get`.
      //
      // Why this matters: the `__extern_get` path routes through the host
      // runtime's `_safeGet`, which reads the struct field via the
      // `__sget_<key>` EXPORT — but module-init top-level code (acorn's
      // `for (…) buildUnicodeData(list[i])` driving
      // `unicodeBinaryPropertiesOfStrings[ecmaVersion]`) executes inside the
      // Wasm START function, BEFORE `__setExports` wires the exports, so
      // `__sget_9` is unavailable and the read returns `undefined`. Worse,
      // `_safeGet` then falls into the well-known-symbol-ID branch (key 9 ∈
      // [1,15]) and swallows it. A `struct.get` key-switch is exports- and
      // host-independent, so it reads correctly at module-init AND at runtime.
      // Literal-key reads already lower to a direct `struct.get` above; this
      // generalises that to a runtime numeric key over the same fields.
      {
        const numericFields = typeDef.fields
          .map((f: { name?: string; type: ValType }, idx: number) => ({ f, idx }))
          .filter(
            ({ f }: { f: { name?: string; type: ValType } }) =>
              f.name !== undefined && /^(?:0|[1-9][0-9]*)$/.test(f.name),
          );
        const firstFieldType = numericFields[0]?.f.type;
        const uniformReferenceFieldType =
          firstFieldType !== undefined &&
          (firstFieldType.kind === "externref" ||
            firstFieldType.kind === "ref" ||
            firstFieldType.kind === "ref_null") &&
          numericFields.every(({ f }) => {
            if (f.type.kind !== firstFieldType.kind) return false;
            if (f.type.kind === "ref" || f.type.kind === "ref_null") {
              return (
                (firstFieldType.kind === "ref" || firstFieldType.kind === "ref_null") &&
                f.type.typeIdx === firstFieldType.typeIdx
              );
            }
            return true;
          })
            ? firstFieldType
            : undefined;
        const keyType = ctx.checker.getTypeAtLocation(expr.argumentExpression);
        // The key is switch-eligible when it is (or could be) a number: a
        // genuine number/number-literal, OR an `any`/`unknown` key (acorn's
        // `unicodeBinaryPropertiesOfStrings[ecmaVersion]` — `ecmaVersion` is an
        // untyped JS param, so it resolves to `any`). A non-number `any` value
        // coerces to NaN, matches no arm, and yields the missing-key result —
        // exactly what `__extern_get` would return. A STATICALLY string-typed
        // key is excluded so `obj["9"]`-style string property reads keep the
        // dynamic path (string→f64 would mis-coerce to NaN).
        const NUMERIC_KEY_FLAGS = ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral;
        const PERMISSIVE_KEY_FLAGS = NUMERIC_KEY_FLAGS | ts.TypeFlags.Any | ts.TypeFlags.Unknown;
        const keyIsStringy =
          (keyType.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !== 0 &&
          (keyType.flags & NUMERIC_KEY_FLAGS) === 0;
        const keySwitchEligible = (keyType.flags & PERMISSIVE_KEY_FLAGS) !== 0 && !keyIsStringy;
        // Only take the static key-switch when EVERY field is numeric-named and
        // every value has one uniform reference representation. JS-host object
        // literals use externref; standalone Acorn's string-valued tables use
        // `ref $AnyString`. A mixed shape falls through unchanged.
        if (
          numericFields.length > 0 &&
          numericFields.length === typeDef.fields.length &&
          uniformReferenceFieldType !== undefined &&
          keySwitchEligible
        ) {
          // Receiver struct ref is already on the stack — stash it so each
          // switch arm can re-read the same field.
          const recvLocal = allocLocal(fctx, `__numkey_recv_${fctx.locals.length}`, {
            kind: "ref_null",
            typeIdx,
          });
          fctx.body.push({ op: "local.set", index: recvLocal });
          // Key as f64 (numeric reads box through f64; matches the literal path).
          compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
          const keyLocal = allocLocal(fctx, `__numkey_idx_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: keyLocal });
          // Build a nested if/else chain from the innermost (default) outward:
          //   if key==N0 then struct.get F0 else if key==N1 then … else null
          const resultType: ValType =
            uniformReferenceFieldType.kind === "ref"
              ? { kind: "ref_null", typeIdx: uniformReferenceFieldType.typeIdx }
              : uniformReferenceFieldType;
          let chain: Instr[] =
            resultType.kind === "externref"
              ? [{ op: "ref.null.extern" }]
              : [{ op: "ref.null", typeIdx: resultType.typeIdx }];
          for (let i = numericFields.length - 1; i >= 0; i--) {
            const { f, idx } = numericFields[i]!;
            const fieldNum = Number(f.name);
            // Every arm reads the same reference representation. A non-null
            // field is a subtype of the nullable result used for the missing-
            // key default.
            const thenArm: Instr[] = [
              { op: "local.get", index: recvLocal },
              { op: "struct.get", typeIdx, fieldIdx: idx },
            ];
            chain = [
              { op: "local.get", index: keyLocal },
              { op: "f64.const", value: fieldNum },
              { op: "f64.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: resultType },
                then: thenArm,
                else: chain,
              },
            ];
          }
          for (const instr of chain) fctx.body.push(instr);
          return resultType;
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
          if (ctx.runtimeEvalGlobalFunctionBindings === true) {
            emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
          }
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

    // (#4247) READ twin of the element-write routing in assignment.ts: a
    // constant key that is NOT an array index per §10.4.2.2 names an ordinary
    // property in the #3537 expando bag, not an element. Without this the
    // standalone read saturates the key to `i32.max` and misses the bag the
    // write just filled. TypedArray views and `arguments` are not array
    // exotics and keep their own lowering.
    //
    // Both lanes, and the read must stay in lockstep with the write: measured,
    // the gc element read does NOT reach the host property store for a
    // non-index key either — it takes the same vec element lane — so routing
    // the write alone would leave gc reading an element the write no longer
    // set. The pair is what has to agree, in whichever lane.
    if (
      elementAccessTypedArrayName(ctx, expr.expression) === undefined &&
      !(ts.isIdentifier(expr.expression) && expr.expression.text === "arguments")
    ) {
      const namedKey = nonArrayIndexNumericKey(ctx, fctx, expr.argumentExpression);
      if (namedKey !== undefined) {
        const named = emitNonIndexVecElementGet(ctx, fctx, namedKey);
        if (named) return named;
      }
    }

    // (#2743 b) `vec[Symbol.iterator]` is %Array.prototype.values%
    // (§10.4.4.6/§10.4.4.7 + the Array iterator), NOT a numeric index. This
    // covers BOTH `[][Symbol.iterator]` and `arguments[Symbol.iterator]` — both
    // are vec-typed receivers reaching this path. The default vec lowering
    // coerces the key to an i32 index, which ToNumber-throws on a Symbol
    // ("Cannot convert a Symbol value to a number"). Intercept the
    // statically-known `Symbol.iterator` key and return the host intrinsic, so
    // both sites get the SAME identity (`[][Symbol.iterator] ===
    // Array.prototype.values`). Host-mode only: in standalone `Symbol.iterator`
    // lowers to an i32 well-known id and the index path is harmless. The
    // receiver vec ref is on the stack here (nothing emitted since entry), so
    // drop it — `Array.prototype.values` is the shared intrinsic.
    if (!noJsHost(ctx) && isSymbolIteratorKey(expr.argumentExpression)) {
      fctx.body.push({ op: "drop" });
      const valuesIdx = ensureLateImport(ctx, "__array_proto_values", [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (valuesIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: valuesIdx });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      return { kind: "externref" };
    }
    // (#2593) Signedness of a packed i8/i16 typed-array element is driven by the
    // VIEW NAME (Int8/Int16 → sign-extend; Uint8/Uint8Clamped/Uint16 →
    // zero-extend), NOT the storage kind — a signed Int8Array and an unsigned
    // Uint8Array share `i8` storage but read with opposite extension.
    const taSignedness = typedArrayViewSignedness(ctx, expr.expression);
    // (#2760 — hybrid floor F1) An OOB read of a genuine PLAIN array reads JS
    // `undefined`, not the type-default sentinel. The policy applies only to a
    // real array receiver: NOT a typed-array view (kept on its own OOB semantics
    // — the S2 blast radius) and NOT the `$__regexp_match_vec` exotic (its
    // index/input/groups fields are property reads with their own spec
    // semantics; deferred). This F1 slice widens the PRIMITIVE element kinds the
    // type-aware box (#2785) can box correctly — `number[]` (f64), `boolean[]`
    // (branded i32), and `symbol[]` (branded i32, #2792) — via `f1ElementBoxType`
    // below. Other `i32` elements (packed-number / other handle reps) and
    // externref elements keep the shared-helper path; WasmGC `ref` / `ref_null`
    // elements use the dedicated reference-array widen below.
    const isRegexMatchVec = typeDef.fields.length >= 4 && typeDef.fields[2]?.name === "index";
    const numericHint = expectedType?.kind === "f64" || expectedType?.kind === "i32";
    const taClass = classifyTypedArrayType(ctx.checker.getTypeAtLocation(expr.expression), ctx.checker);
    const oobUndefined = !numericHint && taClass === "other" && !isRegexMatchVec;
    // (#2798 — hybrid audit Row 9) A genuine typed-array VIEW OOB element read
    // returns JS `undefined` (the view length is the bound). Mutually exclusive
    // with the plain-array F1 arm above (`taClass !== "other"` vs `=== "other"`).
    // Suppressed in a numeric context (`numericHint`) — the consumer wants a
    // number, so keep the unboxed read — exactly like the plain-array F1 (the R1
    // Math.* lesson). The element is boxed as a JS NUMBER via the dedicated
    // call-site helper (`emitTypedArrayUndefinedOobGet`); the shared
    // `emitBoundsCheckedArrayGet` default and `emitPlainArrayUndefinedOobGet`
    // both stay byte-identical (the #2198 S2 blast-radius discipline).
    const oobUndefinedTypedArray = !numericHint && taClass !== "other";
    // (#2785/#2792) The type-aware box ValType for the F1 widen (null = defer).
    // Boxes `number[]` (f64), `boolean[]` (branded i32), and `symbol[]` (branded
    // i32) correctly; defers packed-number / other i32 / externref. Computed even
    // when `oobUndefined` is false (cheap).
    const f1BoxType = f1ElementBoxType(ctx, expr, arrDef.element);
    // (#4159 S3) Overlay-aware routed READ — rationale, exclusions and the
    // byte-identity argument live in typed-lane-overlay-route.ts. Deliberately
    // NOT exempting `isSafeBoundsEliminated` (architect spec).
    if (
      overlayRouteActive(ctx) &&
      !isRegexMatchVec &&
      taClass === "other" &&
      !isArgumentsRootedExpression(fctx, expr.expression)
    ) {
      const routed = emitOverlayRoutedElementGet(
        ctx,
        fctx,
        expr.argumentExpression,
        isNumericIndexExpression(ctx, expr.argumentExpression, fctx),
        numericHint,
        (e, h) => compileExpression(ctx, fctx, e, h),
      );
      if (routed) return routed;
    }
    // (#2773 S7) Bound the unproven read by the vec's LOGICAL length (field 0),
    // not the backing-array capacity. A grow (`a[idx]=v` / `a.push`) over-allocates
    // (capacity = max(idx+1, cap*2, 4)), and `a.pop()` decrements only the length —
    // so `array.len(data)` over-reports the bound and an index in
    // [length, capacity) silently reads the element DEFAULT (null/0) or a stale
    // popped slot instead of being OOB. That broke the test262 HOF "-c-ii-5"
    // family on iteration 2+ (`kIndex[1]` after `kIndex[0]=1` grew capacity to 4).
    // Tee the vec ref so the length field is available to the bounded-read arms
    // below; skipped on the proven fast path and the TA arm (a typed-array view
    // is fixed-length — capacity === length — so its bytes stay identical).
    const useLenBound = !isSafeBoundsEliminated(fctx, expr) && !oobUndefinedTypedArray;
    let vecLenBoundInstrs: Instr[] | undefined;
    if (useLenBound) {
      const vecRefLocal = allocLocal(fctx, `__vecref_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
      fctx.body.push({ op: "local.tee", index: vecRefLocal });
      vecLenBoundInstrs = [
        { op: "local.get", index: vecRefLocal },
        { op: "struct.get", typeIdx, fieldIdx: 0 }, // logical length
      ];
    }
    // Unwrap: struct.get data field, then index into backing array
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data from vec
    // Keep range-proven counted-loop index arithmetic in i32. Composite
    // expressions such as `i * N + k` otherwise compile through f64 and then
    // truncate back to i32 at every element read.
    compileElementIndexI32(ctx, fctx, expr.argumentExpression);
    const valueType: ValType =
      arrDef.element.kind === "i8" || arrDef.element.kind === "i16" ? { kind: "i32" } : arrDef.element;
    if (isSafeBoundsEliminated(fctx, expr)) {
      // Bounds check elided: loop guard guarantees index < array.length
      const getOp =
        arrDef.element.kind === "i8" || arrDef.element.kind === "i16"
          ? taSignedness === "s"
            ? "array.get_s"
            : taSignedness === "u"
              ? "array.get_u"
              : arrDef.element.kind === "i8"
                ? "array.get_u"
                : "array.get_s"
          : "array.get";
      fctx.body.push({ op: getOp, typeIdx: arrTypeIdx });
      // (#2001 S1) Even bounds-eliminated externref reads must map a `$Hole`
      // slot back to `undefined` — the loop guard proves in-bounds, not present.
      if (ctx.usesArrayHoles && arrDef.element.kind === "externref") emitHoleToUndefined(ctx, fctx);
    } else if (oobUndefined && f1BoxType !== null) {
      // (#2760 F1, #2785 type-aware box) Plain-array OOB → `undefined` for a
      // PRIMITIVE element: widen the SAFE result to externref (box the in-bounds
      // value, OOB → undefined). f64/i32 cannot represent `undefined`, so the
      // JS-correct lowering of an unproven read is the boxed-or-undefined
      // externref. Bounds-eliminated reads keep the unboxed fast path above; only
      // the unproven read pays the box. Call-site-owned policy — the shared
      // `emitBoundsCheckedArrayGet` default is untouched (its subview /
      // typed-array / array-method callers are byte-identical; flipping the
      // shared default was the S2 leak).
      //
      // #2785/#2792 — the element is boxed by its SEMANTIC type, not its Wasm
      // kind: `f1BoxType` (reconstructed from the receiver TS type, since the
      // brand is erased in `arrDef.element`) is `{f64}` for `number[]`
      // (`__box_number`), `{i32, boolean}` for `boolean[]` (`__box_boolean`), or
      // `{i32, symbol}` for `symbol[]` (`__box_symbol`). #2785 re-enabled the
      // `boolean[]` arm #2766 deferred (boxing a boolean as `__box_number` made it
      // the number 1, regressing the standalone map tests); #2792 completes the
      // `symbol[]` arm now that a native standalone `__box_symbol` exists (a symbol
      // handle boxed as `__box_number` would surface a Number). Packed-number /
      // other i32 / externref elements stay deferred (`f1BoxType === null`) and
      // fall through to the shared-helper read below; WasmGC `ref` / `ref_null`
      // elements use the dedicated reference-array widen immediately below.
      emitPlainArrayUndefinedOobGet(ctx, fctx, arrTypeIdx, arrDef.element, f1BoxType, vecLenBoundInstrs);
      return { kind: "externref" };
    } else if (oobUndefined && (arrDef.element.kind === "ref" || arrDef.element.kind === "ref_null")) {
      emitReferenceArrayUndefinedOobGet(ctx, fctx, arrTypeIdx, arrDef.element, vecLenBoundInstrs);
      return { kind: "externref" };
    } else if (oobUndefinedTypedArray) {
      // (#2798 Row 9) Typed-array OOB → JS `undefined`, in-bounds → the element
      // boxed as a JS number. f64/i32 cannot represent `undefined`, so the
      // JS-correct lowering of an unproven typed-array read is the
      // boxed-or-undefined externref. Bounds-eliminated reads above keep the
      // unboxed fast path; only the unproven read pays the box. The helper
      // threads the view-name signedness (so `Int8Array`/`Uint16Array`/
      // `Uint32Array` read with the right extension) and boxes as a number —
      // dedicated, so the shared helper / plain-array helper are untouched.
      emitTypedArrayUndefinedOobGet(ctx, fctx, arrTypeIdx, arrDef.element, taSignedness);
      return { kind: "externref" };
    } else {
      // (#2001 S1) Pass `ctx` so the in-bounds `$Hole → undefined` read-boundary
      // mapping fires for an externref-element (`any[]`) vec. (#2593) Thread the
      // view-name signedness for packed i8/i16 reads.
      //
      // (#2773 S7 — F1 completion for externref elements) A plain-array OOB read
      // of an EXTERNREF element must produce JS `undefined`, not
      // `ref.null.extern`: null makes `typeof a[i]` report "object" and
      // `a[i] === undefined` false, which broke the whole test262 HOF
      // "-c-ii-5" family (`var kIndex = []; … typeof kIndex[idx] ===
      // "undefined"` — the very first probe of the empty tracking array reads
      // null and every callback bails). The primitive elements got this via the
      // type-aware box (#2785/#2792) above; externref needs NO box — the #1396
      // sentinel arm of the shared helper already emits `__get_undefined` on
      // the OOB branch (and keeps the in-bounds `$Hole → undefined` map), so
      // opt in AT THIS CALL SITE only, gated on the same `oobUndefined` policy
      // (plain array, non-numeric consumer, not the regex-match vec). The
      // shared helper DEFAULT stays false (the #2198 S2 blast-radius
      // discipline: subview / typed-array / array-method callers are
      // byte-identical). Standalone is neutral by construction:
      // `ensureGetUndefined` returns undefined under nativeStrings, so the
      // helper falls back to `ref.null.extern` — the standalone undefined
      // convention.
      const externUndefOob =
        oobUndefined && (arrDef.element.kind === "externref" || arrDef.element.kind === "ref_extern");
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, arrDef.element, ctx, externUndefOob, taSignedness, vecLenBoundInstrs);
    }
    // (#2593) `Uint32Array` element read: the i32_byte storage holds the full 32
    // bits; the value as a JS number is the UNSIGNED interpretation (0..2^32-1).
    // `array.get` on an i32 array yields a raw i32 whose default i32→f64 coercion
    // is SIGNED (−1 instead of 4294967295). For an unsigned i32 view convert the
    // i32 to f64 UNSIGNED here and return f64 so no signed re-coerce follows.
    // (Int32Array is signed → the default signed coercion is already correct;
    // i8/i16 already sign/zero-extended into the i32 via array.get_s/_u above.)
    if (arrDef.element.kind === "i32" && taSignedness === "u") {
      fctx.body.push({ op: "f64.convert_i32_u" });
      return { kind: "f64" };
    }
    return valueType;
  }

  if (!typeDef || typeDef.kind !== "array") {
    reportError(ctx, expr, "Element access on non-array type");
    return null;
  }

  // (#2593) View-name-driven signedness for a packed i8/i16 typed-array element.
  const taSignednessArr = typedArrayViewSignedness(ctx, expr.expression);
  // (#2760 F1) Plain-array OOB → JS `undefined` policy. A raw array type has no
  // struct fields, so there is no regex-match-vec exotic to exclude here.
  const numericHintArr = expectedType?.kind === "f64" || expectedType?.kind === "i32";
  const taClassArr = classifyTypedArrayType(ctx.checker.getTypeAtLocation(expr.expression), ctx.checker);
  const oobUndefinedArr = !numericHintArr && taClassArr === "other";
  // (#2798 Row 9) Typed-array VIEW OOB → JS `undefined` (mirrors the vec-struct
  // call site above). Mutually exclusive with the plain-array arm
  // (`taClassArr !== "other"`); suppressed in a numeric context.
  const oobUndefinedTypedArrayArr = !numericHintArr && taClassArr !== "other";
  // (#2785) Type-aware box ValType for the F1 widen (null = defer) — matches the
  // vec-struct call site above.
  const f1BoxTypeArr = f1ElementBoxType(ctx, expr, typeDef.element);
  // Compile range-proven index arithmetic directly in i32; retain the generic
  // numeric conversion for every expression whose range is not proven.
  compileElementIndexI32(ctx, fctx, expr.argumentExpression);
  const valueType: ValType =
    typeDef.element.kind === "i8" || typeDef.element.kind === "i16" ? { kind: "i32" } : typeDef.element;

  if (isSafeBoundsEliminated(fctx, expr)) {
    // Bounds check elided: loop guard guarantees index < array.length
    const getOp =
      typeDef.element.kind === "i8" || typeDef.element.kind === "i16"
        ? taSignednessArr === "s"
          ? "array.get_s"
          : taSignednessArr === "u"
            ? "array.get_u"
            : typeDef.element.kind === "i8"
              ? "array.get_u"
              : "array.get_s"
        : "array.get";
    fctx.body.push({ op: getOp, typeIdx });
    // (#2001 S1) Map a `$Hole` slot back to `undefined` on bounds-eliminated
    // externref reads too (in-bounds ≠ present).
    if (ctx.usesArrayHoles && typeDef.element.kind === "externref") emitHoleToUndefined(ctx, fctx);
  } else if (oobUndefinedArr && f1BoxTypeArr !== null) {
    // (#2760 F1, #2785/#2792 type-aware box) Plain-array OOB → `undefined` for a
    // PRIMITIVE element: widen to a boxed-or-undefined externref, boxed by the
    // element's SEMANTIC type (`f1BoxTypeArr`: `{f64}` number[] → `__box_number`,
    // `{i32, boolean}` boolean[] → `__box_boolean`, `{i32, symbol}` symbol[] →
    // `__box_symbol`). Bounds-eliminated reads above keep the unboxed fast path.
    // Packed-number / other i32 / externref elements stay deferred
    // (`f1BoxTypeArr === null`) and fall through to the shared-helper read
    // below; WasmGC `ref` / `ref_null` elements use the dedicated widen
    // immediately below. See the full note at the vec-struct call site above.
    emitPlainArrayUndefinedOobGet(ctx, fctx, typeIdx, typeDef.element, f1BoxTypeArr);
    return { kind: "externref" };
  } else if (oobUndefinedArr && (typeDef.element.kind === "ref" || typeDef.element.kind === "ref_null")) {
    emitReferenceArrayUndefinedOobGet(ctx, fctx, typeIdx, typeDef.element);
    return { kind: "externref" };
  } else if (oobUndefinedTypedArrayArr) {
    // (#2798 Row 9) Typed-array OOB → JS `undefined`, in-bounds → the element
    // boxed as a JS number. See the full note at the vec-struct call site.
    emitTypedArrayUndefinedOobGet(ctx, fctx, typeIdx, typeDef.element, taSignednessArr);
    return { kind: "externref" };
  } else {
    // (#2001 S1) Pass `ctx` for the in-bounds `$Hole → undefined` mapping.
    // (#2593) Thread the view-name signedness for packed i8/i16 reads.
    // (#2773 S7) F1 completion for externref elements: plain-array OOB reads
    // JS `undefined`, not `ref.null.extern` — same call-site-scoped opt-in as
    // the vec-struct site above (see the full note there). Shared default
    // untouched; standalone neutral (`ensureGetUndefined` → undefined →
    // helper falls back to `ref.null.extern`).
    const externUndefOobArr =
      oobUndefinedArr && (typeDef.element.kind === "externref" || typeDef.element.kind === "ref_extern");
    emitBoundsCheckedArrayGet(fctx, typeIdx, typeDef.element, ctx, externUndefOobArr, taSignednessArr);
  }
  return valueType;
}

/**
 * (#3133) Classify a `.constructor` receiver whose constructor is one of the
 * two namespace-object builtins (`Object` / `Array`) that #3006 deliberately
 * left out of `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES`. Returns the namespace name
 * to route the read to, or `undefined` to decline (fall through to the current
 * lowering). Deliberately conservative:
 *
 * - declines `any` / `unknown` (the #2026 tag-dispatch arm owns those) and
 *   union/intersection receivers;
 * - array/tuple static types (checker-confirmed) → `"Array"` — covers `[1]`,
 *   `Array.prototype` (typed `any[]`), `new Array(n)`;
 * - the `Object` interface itself → `"Object"` — covers `Object.prototype`,
 *   `new Object()`, `Object(x)` results;
 * - anonymous object-literal shapes (`{}` / `{ a: 1 }`) → `"Object"`, but only
 *   when the type is not callable/constructable and does not declare a
 *   USER-written `constructor` member (a user `{ constructor: v }` keeps its
 *   own property read).
 */
export function classifyPlainCtorReceiverNamespace(
  ctx: CodegenContext,
  objType: ts.Type,
): "Object" | "Array" | undefined {
  if (
    (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Union | ts.TypeFlags.Intersection)) !==
    0
  ) {
    return undefined;
  }
  const checkerAny = ctx.checker as unknown as {
    isArrayType?: (t: ts.Type) => boolean;
    isTupleType?: (t: ts.Type) => boolean;
  };
  if (checkerAny.isArrayType?.(objType) || checkerAny.isTupleType?.(objType)) return "Array";
  if ((objType.flags & ts.TypeFlags.Object) === 0) return undefined;
  const symName = objType.getSymbol()?.name;
  if (symName === "Array" || symName === "ReadonlyArray") return "Array";
  if (symName === "Object") return "Object";
  // "__object" = object-LITERAL expression types only. Deliberately NOT
  // "__type" (type-literal annotations like `const o: {} = new A()`), where the
  // annotation says nothing about the runtime constructor.
  if (symName === "__object") {
    if (objType.getCallSignatures().length > 0 || objType.getConstructSignatures().length > 0) return undefined;
    // A user-declared `constructor` member (non-lib declaration) keeps its own
    // property read; a lib-inherited `constructor` (Object.prototype) is fine.
    const ctorProp = objType.getProperty("constructor");
    if (ctorProp !== undefined && (ctorProp.declarations ?? []).some((d) => !d.getSourceFile().isDeclarationFile)) {
      return undefined;
    }
    return "Object";
  }
  return undefined;
}

/**
 * (#3133) Module-wide shadowing guard for the static `.constructor` identity
 * fold: if the module ever ASSIGNS to or DELETES a `.constructor` property
 * (any receiver — syntactic scan, cached per source file), decline the fold so
 * runtime-shadowed reads keep their current dynamic behavior.
 */
const constructorPropTouchCache = new WeakMap<ts.SourceFile, boolean>();
export function moduleTouchesConstructorProp(sourceFile: ts.SourceFile): boolean {
  let touched = constructorPropTouchCache.get(sourceFile);
  if (touched === undefined) {
    touched = false;
    const isCtorMember = (e: ts.Expression): boolean =>
      (ts.isPropertyAccessExpression(e) && e.name.text === "constructor") ||
      (ts.isElementAccessExpression(e) &&
        ts.isStringLiteralLike(e.argumentExpression) &&
        e.argumentExpression.text === "constructor");
    const walk = (node: ts.Node): void => {
      if (touched) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        isCtorMember(node.left)
      ) {
        touched = true;
        return;
      }
      if (ts.isDeleteExpression(node) && isCtorMember(node.expression)) {
        touched = true;
        return;
      }
      ts.forEachChild(node, walk);
    };
    walk(sourceFile);
    constructorPropTouchCache.set(sourceFile, touched);
  }
  return touched;
}
