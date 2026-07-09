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
import { classMemberFuncKey, resolveMethodOwnerClass } from "./class-member-keys.js"; // (#1983) collision-free class-member funcMap keys; (#2963) method-owner chain
import { popBody, pushBody } from "./context/bodies.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "./context/locals.js";
import { snapshotSpeculative, rollbackSpeculative } from "./context/speculative.js";
import { emitDynGet } from "./dyn-read.js"; // (#2580 M2 slice 1)
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitCachedMethodClosureAccess, emitFuncRefAsClosure, getOrCreateFuncRefWrapperTypes } from "./closures.js";
import {
  BUILTIN_STATIC_METHOD_ARITY,
  ensureBuiltinFnMetaType,
  pushBuiltinFnSingletonValueInstrs,
  STANDALONE_STATIC_METHOD_META,
} from "./builtin-fn-meta.js";
import { emitBuiltinConstructorIdentity, isBuiltinConstructorIdentityName } from "./builtin-static-globals.js";
import { emitLazyClassObjectGet, emitLazyProtoGet, findExternInfoForMember } from "./expressions/extern.js";
import {
  classifyPrivateMember,
  emitPrivateBrandPredicate,
  emitThrowTypeError,
  noJsHost,
  resolveDeclaringClassForPrivateName,
} from "./expressions/helpers.js";
import { ensureAnyFromExternHelper, undefinedSingletonActive } from "./any-helpers.js";
import { emitUndefined, patchStructNewForAddedField } from "./expressions/late-imports.js";
import { emitSymbolDescLoad } from "./symbol-native.js";
import {
  addUnionImports,
  classifyTypedArrayType,
  reserveVecMethodHelper,
  resolveWasmType,
  TYPED_ARRAY_NAMES,
  typedArrayPackedSignedness,
  typedArrayVecStorage,
} from "./index.js";
import { emitJsonStringifyValue } from "./json-codec-native.js";
import { tryCompileNativeGeneratorResultProperty } from "./generators-native.js";
import { tryCompileNativeMapSizeGet } from "./map-runtime.js";
import { tryCompileNativeSetSizeGet } from "./set-runtime.js";
import { tryEmitLinearU8ElementGet, tryEmitLinearU8Length } from "./linear-uint8-codegen.js";
import { tryEmitFnctorPrototypeRead } from "./expressions/fnctor-prototype.js";
import { ensureNativeStringHelpers, stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
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
} from "./array-object-proto.js";
import { isBuiltinSubtype, isBuiltinTypeName } from "./builtin-tags.js";
import { getOrRegisterErrorStructType, isWasiErrorName } from "./registry/error-types.js";
import {
  addStringConstantGlobal,
  ensureExnTag,
  localGlobalIdx,
  recordInModuleInitFlagRead,
} from "./registry/imports.js";
import { getOrRegisterDvWindowType } from "./dataview-native.js"; // (#2159/#38) DataView windowing
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
import { classMethodCandidatesForProp, reserveMemberGetDispatch } from "./member-get-dispatch.js";
import { resolveReceiverStruct } from "./fnctor-escape-gate.js"; // (#2681/#2686 A3) pinned-struct read dispatch
import { reserveAccessorGetDriver } from "./accessor-driver.js";
import { S5C_STRUCT_ACCESSOR_CLOSURE } from "./struct-accessor-closure.js";
import { tryCompileTemporalPropertyAccess } from "./temporal-native.js";

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
};

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
  fctx.body.push({ op: "call", funcIdx: classifyIdx } as Instr);
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
function isAnonymousFunctionDefinition(expr: ts.Expression): boolean {
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
function classExpressionDefinesOwnName(expr: ts.Expression): boolean {
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

function getWellKnownSymbolId(name: string): number | undefined {
  return WELL_KNOWN_SYMBOLS[name];
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
const MATH_CONSTANT_VALUES: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
  LN2: Math.LN2,
  LN10: Math.LN10,
  SQRT2: Math.SQRT2,
  SQRT1_2: Math.SQRT1_2,
  LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E,
};
const NUMBER_CONSTANT_VALUES: Record<string, number> = {
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
const TYPED_ARRAY_BYTES_PER_ELEMENT: Record<string, number> = {
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
const BUILTIN_CTOR_ARITY: Record<string, number> = {
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
        fctx.body.push({ op: "f64.const", value: staticArity } as Instr);
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
    fctx.body.push({ op: "ref.func", funcIdx: closure.funcIdx } as Instr);
    fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr);
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
      returnType = { kind: "i32" };
      break;
    case "Reflect.set":
      paramTypes = [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }];
      returnType = { kind: "i32" };
      break;
    case "Reflect.ownKeys":
      paramTypes = [{ kind: "externref" }];
      returnType = { kind: "externref" };
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
      // Native __object_keys — string own keys of the $Object hash-map, per the
      // standalone `Reflect.ownKeys(target)` call path (Symbol/non-enumerable
      // keys are out of scope for the open-object runtime, consistent with it).
      const idx = ensureLateImport(ctx, "__object_keys", [{ kind: "externref" }], [{ kind: "externref" }]);
      if (idx === undefined) return null;
      closureFctx.body.push({ op: "local.get", index: 1 });
      closureFctx.body.push({ op: "call", funcIdx: idx });
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
      closureFctx.body.push({ op: "any.convert_extern" } as Instr);
      closureFctx.body.push({ op: "call", funcIdx: rootIdx });
      closureFctx.body.push({ op: "extern.convert_any" } as Instr);
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

  // (#2896) The value struct is the UNIQUE per-(builtin, method) metadata
  // subtype of the signature wrapper, so the reflective runtime natives can
  // `ref.test` it and answer its spec `name`/`length` own properties. All call
  // paths are unaffected (subtype of the wrapper the lifted func expects).
  const meta = STANDALONE_STATIC_METHOD_META[key];
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
  // (#2937) The evolved checker type of a poisoned `$Object`-hash-consumer
  // `{}` var never resolves to a struct — receivers of that type route through
  // the externref host-MOP path (see resolveWasmType's matching guard).
  if (ctx.objectHashConsumerTypes.has(tsType)) return undefined;
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
function chainRootIsGrowable(ctx: CodegenContext, expr: ts.Expression): boolean {
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
  fctx.body.push({ op: "local.get", index: recvExtLocal } as Instr);
  fctx.body.push({ op: "local.get", index: valExtLocal } as Instr);
  fctx.body.push({ op: "call", funcIdx: dispIdx } as Instr);
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
): { structTypeIdx: number; fieldIdx: number; fieldType: ValType; mutable: boolean }[] {
  const result: { structTypeIdx: number; fieldIdx: number; fieldType: ValType; mutable: boolean }[] = [];
  for (const [typeName, fields] of ctx.structFields) {
    const sIdx = ctx.structMap.get(typeName);
    if (sIdx === undefined || sIdx === excludeTypeIdx) continue;
    const fIdx = fields.findIndex((f) => f.name === propName);
    if (fIdx !== -1) {
      result.push({
        structTypeIdx: sIdx,
        fieldIdx: fIdx,
        fieldType: fields[fIdx]!.type,
        mutable: fields[fIdx]!.mutable,
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
          { op: "local.get", index: srcLocal } as Instr,
          { op: "extern.convert_any" } as Instr,
          { op: "call", funcIdx: getDispIdx } as Instr,
          ...coercionInstrs(ctx, { kind: "externref" }, resultType, fctx),
          { op: "local.set", index: resultLocal } as Instr,
        ];
      }
      // No dispatcher — return default value (legacy behaviour).
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
    then: [] as Instr[],
    else: [
      { op: "global.get", index: entry.globalIdx } as Instr,
      { op: "local.get", index: valLocalIdx } as Instr,
      { op: "struct.set", typeIdx: entry.refCellTypeIdx, fieldIdx: 0 } as Instr,
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
 * (#2101a R5) Emit an own-field READ (`inst.code`) on an externref-backed Error
 * subclass, routing through the `$Error_struct.$props` (fieldIdx 5) open-`$Object`
 * backing instead of the vestigial `$A` struct (which the receiver is NOT).
 *
 * Lowers to: `props = self.$props; props == null ? undefined :
 * __extern_get(props, "code")`, returning the value as externref. message/name/
 * stack never reach here — they are served by the Error fast-path upstream.
 *
 * Returns the result ValType on success, or `undefined` when helpers are
 * unavailable (caller falls through to the legacy struct read).
 */
function emitExternrefBackedOwnFieldRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | null | undefined {
  ensureObjectRuntime(ctx);
  const externGetIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (externGetIdx === undefined) return undefined;
  const errStructIdx = getOrRegisterErrorStructType(ctx);

  const selfResult = compileExpression(ctx, fctx, expr.expression, { kind: "externref" });
  if (!selfResult) return null;
  if (selfResult.kind !== "externref") fctx.body.push({ op: "extern.convert_any" } as Instr);

  // props = self.$props (fieldIdx 5): cast externref → (ref $Error_struct) once.
  const propsLocal = allocLocal(fctx, `__ownf_rprops_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "any.convert_extern" } as Instr);
  fctx.body.push({ op: "ref.cast", typeIdx: errStructIdx } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: errStructIdx, fieldIdx: 5 } as Instr);
  fctx.body.push({ op: "local.tee", index: propsLocal });
  // props == null ? undefined : __extern_get(props, propName)
  fctx.body.push({ op: "ref.is_null" } as Instr);
  addStringConstantGlobal(ctx, propName);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [{ op: "ref.null.extern" } as Instr],
    else: [
      { op: "local.get", index: propsLocal } as Instr,
      ...stringConstantExternrefInstrs(ctx, propName),
      { op: "call", funcIdx: externGetIdx } as Instr,
    ],
  } as Instr);
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
        { op: "local.get", index: tmpAny } as Instr,
        { op: "extern.convert_any" } as Instr,
        { op: "call", funcIdx: getDispIdx } as Instr,
        ...coercionInstrs(ctx, { kind: "externref" }, resultType, fctx),
        { op: "local.set", index: resultLocal } as Instr,
      ];
    }
    // No dispatcher — use __extern_get for JS objects, or default value (legacy).
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
  // (#2106 S1) Under the `undefinedSingleton` regime standalone `undefined` is
  // a NON-null externref, so the short-circuit must also test the singleton.
  if (undefinedSingletonActive(ctx) && objType.kind === "externref") {
    const s1IsUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
    if (s1IsUndefIdx !== undefined) {
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "call", funcIdx: s1IsUndefIdx } as Instr);
      fctx.body.push({ op: "i32.or" } as Instr);
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
          fctx.body.push({ op: "extern.convert_any" } as Instr); // recv struct ref → externref
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
function emitGuardedNativeStringLength(
  ctx: CodegenContext,
  fctx: FunctionContext,
  buildElseInstrs: (recvExternLocal: number) => Instr[],
): void {
  const recvExtern = allocLocal(fctx, `__strlen_ext_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvExtern });
  fctx.body.push({ op: "local.get", index: recvExtern });
  fctx.body.push({ op: "any.convert_extern" } as Instr);
  fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [
      { op: "local.get", index: recvExtern } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
      { op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 } as Instr,
    ],
    else: buildElseInstrs(recvExtern),
  } as Instr);
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
function tryEmitPinnedStructMemberGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
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
  if (objResult && objResult.kind !== "externref") {
    coerceType(ctx, fctx, objResult, { kind: "externref" });
  } else if (!objResult) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
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
      fctx.body.push({ op: "drop" } as Instr);
      fctx.body.push({ op: "ref.null.extern" } as Instr);
      return { kind: "externref" };
    }
    addStringConstantGlobal(ctx, propName);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
    fctx.body.push({ op: "call", funcIdx: getIdx } as Instr);
    return { kind: "externref" };
  }
  // Receiver is on the stack; the dispatcher takes (recv) → call directly.
  fctx.body.push({ op: "call", funcIdx: getDispIdx } as Instr);
  return { kind: "externref" };
}

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
    fctx.body.push({ op: "ref.null.extern" } as Instr);
  }

  if (getMemberIdx === undefined) {
    // No dispatcher available — legacy bare tombstone-aware host read.
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
    fctx.body.push({ op: "call", funcIdx: getIdx } as Instr);
    return { kind: "externref" };
  }

  // `__in_module_init ? __get_member_<name>(recv) : __extern_get(recv, "prop")`.
  // The flag-read `global.get` index is a PLACEHOLDER patched at finalize by
  // `finalizeInModuleInitFlag` (after all import globals settle).
  const flagGet = recordInModuleInitFlagRead(ctx);
  const recvLocal = allocLocal(fctx, `__dadg_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal } as Instr);
  fctx.body.push(flagGet);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } as ValType },
    then: [{ op: "local.get", index: recvLocal } as Instr, { op: "call", funcIdx: getMemberIdx } as Instr],
    else: [
      { op: "local.get", index: recvLocal } as Instr,
      ...stringConstantExternrefInstrs(ctx, propName),
      { op: "call", funcIdx: getIdx } as Instr,
    ],
  } as Instr);
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
    fctx.body.push({ op: "ref.null.extern" } as Instr);
  }
  const objLocal = allocLocal(fctx, `__daset_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Evaluate the value, coerce/box to externref.
  const valResult = compileExpression(ctx, fctx, value);
  if (valResult && valResult.kind !== "externref") {
    coerceType(ctx, fctx, valResult, { kind: "externref" });
  } else if (!valResult) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
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
    fctx.body.push({ op: "call", funcIdx: setIdx } as Instr);
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
      { op: "local.get", index: objLocal } as Instr,
      { op: "local.get", index: valLocal } as Instr,
      { op: "call", funcIdx: setMemberIdx } as Instr,
    ],
    else: [
      { op: "local.get", index: objLocal } as Instr,
      ...stringConstantExternrefInstrs(ctx, propName),
      { op: "local.get", index: valLocal } as Instr,
      { op: "call", funcIdx: setIdx } as Instr,
    ],
  } as Instr);

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
function tryEmitConstructorViaTag(
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
    fctx.body.push({ op: "ref.null.extern" } as Instr);
  }
  fctx.body.push({ op: "any.convert_extern" } as Instr);
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
    fctx.body.push({ op: "ref.test", typeIdx: structIdx } as Instr);
    fctx.body.push({ op: "i32.and" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: instLocal },
        { op: "ref.cast", typeIdx: structIdx } as Instr,
        { op: "struct.get", typeIdx: structIdx, fieldIdx: 0 } as Instr,
        { op: "local.set", index: tagLocal },
      ],
      else: [],
    } as Instr);
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
  const externGetIdx =
    ctx.standalone || ctx.wasi || ctx.strictNoHostImports
      ? undefined
      : ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  if (externGetIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    // __extern_get(extern.convert_any(instLocal), "constructor")
    fctx.body.push({ op: "local.get", index: instLocal });
    fctx.body.push({ op: "extern.convert_any" } as Instr);
    addStringConstantGlobal(ctx, "constructor");
    fctx.body.push(...stringConstantExternrefInstrs(ctx, "constructor"));
    fctx.body.push({ op: "call", funcIdx: externGetIdx } as Instr);
    fctx.body.push({ op: "local.set", index: resLocal });
  } else {
    // Standalone / WASI / no-host: no `__extern_get` import. Preserve the prior
    // behaviour for a non-class receiver (null externref — there is no host
    // constructor object to recover).
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "local.set", index: resLocal });
  }

  // Flat tag-equality dispatch: tag == classTag → emitLazyClassObjectGet(class).
  for (const className of candidates) {
    const classTag = ctx.classTagMap.get(className)!;
    const arm: Instr[] = [];
    const savedBody = fctx.body;
    fctx.body = arm;
    if (emitLazyClassObjectGet(ctx, fctx, className)) {
      fctx.body.push({ op: "local.set", index: resLocal } as Instr);
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
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: arm, else: [] } as Instr);
  }

  fctx.body.push({ op: "local.get", index: resLocal });
  return { kind: "externref" };
}

/**
 * (#2901) True iff `expr` is syntactically `Object.getPrototypeOf(<wired view>.prototype)`
 * — the inner half of the test262-runner `%TypedArray%`-intrinsic shim.
 */
function isGetProtoOfWiredViewProtoCall(expr: ts.Expression): boolean {
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
function taViewReceiverTypeIdx(
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

  // (#2743 a) `arguments.constructor.prototype` → %Object.prototype% (§10.4.4):
  // the arguments object's `.constructor` is %Object%, whose `.prototype` is
  // %Object.prototype%. The arguments object is modeled as a vec, so the inner
  // `arguments.constructor` would resolve to the Array constructor and the outer
  // `.prototype` to %Array.prototype%. Intercept the COMPOUND access and emit the
  // compiler's own `Object.prototype` value-read (a synthetic `Object.prototype`
  // member access — the lowering is name-keyed on `Object`), so it matches the
  // identity a plain `Object.prototype` read produces. Host-mode only.
  if (
    !noJsHost(ctx) &&
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
  // `Object.prototype` member-read in this compiler.) Host-mode only.
  if (
    !noJsHost(ctx) &&
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

  // (#2660 S2) `F.prototype` on a user function constructor (standalone): return
  // the per-fnctor prototype `$Object` global instead of `__extern_get($closure,
  // "prototype")` (which misses `ref.test $Object` → null). Makes
  // `Object.create(F.prototype)` resolve and seeds #2660 S3's `instance.$proto`.
  // Declines (falls through) for classes/builtins/host mode.
  {
    const fnctorProto = tryEmitFnctorPrototypeRead(ctx, fctx, expr, propName);
    if (fnctorProto !== undefined) return fnctorProto;
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
      const routed = tryEmitPinnedStructMemberGet(ctx, fctx, expr, propName);
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
        fctx.body.push({ op: "any.convert_extern" } as Instr);
      }
      const abAny = allocLocal(fctx, `__rab_any_${fctx.locals.length}`, { kind: "anyref" });
      fctx.body.push({ op: "local.set", index: abAny } as Instr);
      if (propName === "resizable") {
        fctx.body.push({ op: "local.get", index: abAny } as Instr);
        fctx.body.push({ op: "ref.test", typeIdx: rabTypeIdx } as Instr);
        // Boolean result. In non-fast mode surface it as an f64 0/1 (truthy in
        // conditionals, and `=== true` compares fold correctly downstream).
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
        return ctx.fast ? { kind: "i32", boolean: true } : { kind: "f64" };
      }
      // maxByteLength: if resizable read field 2, else the byteLength (field 0).
      fctx.body.push({ op: "local.get", index: abAny } as Instr);
      fctx.body.push({ op: "ref.test", typeIdx: rabTypeIdx } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } as ValType },
        then: [
          { op: "local.get", index: abAny } as Instr,
          { op: "ref.cast", typeIdx: rabTypeIdx } as Instr,
          { op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 2 } as Instr,
        ],
        else: [
          { op: "local.get", index: abAny } as Instr,
          { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
          { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
        ],
      } as Instr);
      if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
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
    if (isDataView && noJsHost(ctx) && propName !== "BYTES_PER_ELEMENT") {
      const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
      const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
      const fieldIdx = propName === "byteOffset" ? 1 : 2;
      const recvType = compileExpression(ctx, fctx, expr.expression);
      const anyLocal = allocLocal(fctx, `__dvp_any_${fctx.locals.length}`, { kind: "anyref" });
      if (recvType?.kind === "externref") {
        fctx.body.push({ op: "any.convert_extern" } as Instr);
      }
      fctx.body.push({ op: "local.set", index: anyLocal } as Instr);
      const winBranch: Instr[] = [
        { op: "local.get", index: anyLocal } as Instr,
        { op: "ref.cast", typeIdx: dvWinTypeIdx } as Instr,
        { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx } as Instr,
      ];
      const vecBranch: Instr[] =
        propName === "byteOffset"
          ? [{ op: "i32.const", value: 0 } as Instr]
          : [
              { op: "local.get", index: anyLocal } as Instr,
              { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
              { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
            ];
      fctx.body.push({ op: "local.get", index: anyLocal } as Instr);
      fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: winBranch,
        else: vecBranch,
      } as Instr);
      if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
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
    if (isDataView && !noJsHost(ctx) && propName !== "BYTES_PER_ELEMENT") {
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
          fctx.body.push({ op: "extern.convert_any" } as Instr);
        }
        fctx.body.push({ op: "i32.const", value: propName === "byteOffset" ? 0 : 1 } as Instr);
        fctx.body.push({ op: "call", funcIdx: attrIdx } as Instr);
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
    if (isBuffer || isTypedArr) {
      // byteOffset on a fresh-backing view is always 0.
      if (propName === "byteOffset") {
        const recvType = compileExpression(ctx, fctx, expr.expression);
        if (recvType !== null) fctx.body.push({ op: "drop" } as Instr);
        fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: 0 } as Instr);
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
          if (recvType !== null) fctx.body.push({ op: "drop" } as Instr);
          const bytes = TYPED_ARRAY_BYTES_PER_ELEMENT[recvName!] ?? 1;
          fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: bytes } as Instr);
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
          fctx.body.push({ op: "any.convert_extern" } as Instr);
        }
        const lenTmpBL = allocLocal(fctx, `__bl_len_${fctx.locals.length}`, { kind: "anyref" });
        fctx.body.push({ op: "local.set", index: lenTmpBL } as Instr);
        fctx.body.push({ op: "local.get", index: lenTmpBL } as Instr);
        fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } as ValType },
          then: [
            { op: "local.get", index: lenTmpBL } as Instr,
            { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
          ],
          else: [{ op: "i32.const", value: 0 } as Instr],
        } as Instr);
        if (bytesPerElem !== 1) {
          fctx.body.push({ op: "i32.const", value: bytesPerElem } as Instr);
          fctx.body.push({ op: "i32.mul" } as Instr);
        }
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
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
  if (propName === "buffer" && noJsHost(ctx)) {
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
          // A DataView receiver is either a `$__dv_window` wrapper (windowed view
          // → byte length is its field-2 `byteLength`) or a bare `$__vec_i32_byte`
          // (offset-0 view → field-0 IS the byte count). Mirror the byteLength arm's
          // runtime `ref.test $__dv_window` branch so both shapes work — a static
          // cast to one shape would `illegal cast` the other.
          const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
          const recvType = compileExpression(ctx, fctx, expr.expression);
          const anyLocal = allocLocal(fctx, `__tabuf_any_${fctx.locals.length}`, { kind: "anyref" });
          if (recvType?.kind === "externref") {
            fctx.body.push({ op: "any.convert_extern" } as Instr);
          }
          fctx.body.push({ op: "local.set", index: anyLocal } as Instr);
          const winBranch: Instr[] = [
            { op: "local.get", index: anyLocal } as Instr,
            { op: "ref.cast", typeIdx: dvWinTypeIdx } as Instr,
            { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 2 } as Instr,
          ];
          const vecBranch: Instr[] = [
            { op: "local.get", index: anyLocal } as Instr,
            { op: "ref.cast", typeIdx: byteVecTypeIdx } as Instr,
            { op: "struct.get", typeIdx: byteVecTypeIdx, fieldIdx: 0 } as Instr,
          ];
          fctx.body.push({ op: "local.get", index: anyLocal } as Instr);
          fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx } as Instr);
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: winBranch,
            else: vecBranch,
          } as Instr);
          fctx.body.push({ op: "local.set", index: byteLenLocal } as Instr);
        } else {
          // TypedArray: backing is an f64 vec (or i8 for standalone Uint8Array);
          // byteLen = element-count (field 0) × BYTES_PER_ELEMENT.
          const elemKey = noJsHost(ctx) && bufRecvName === "Uint8Array" ? "i8_byte" : "f64";
          const elemType: ValType = elemKey === "i8_byte" ? { kind: "i8" } : { kind: "f64" };
          const viewVecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
          const recvType = compileExpression(ctx, fctx, expr.expression);
          if (recvType?.kind === "externref") {
            fctx.body.push({ op: "any.convert_extern" } as Instr);
            fctx.body.push({ op: "ref.cast", typeIdx: viewVecTypeIdx } as Instr);
          } else if (
            (recvType?.kind === "ref" || recvType?.kind === "ref_null") &&
            "typeIdx" in recvType &&
            recvType.typeIdx !== viewVecTypeIdx
          ) {
            fctx.body.push({ op: "ref.cast", typeIdx: viewVecTypeIdx } as Instr);
          }
          fctx.body.push({ op: "struct.get", typeIdx: viewVecTypeIdx, fieldIdx: 0 } as Instr);
          const bytesPerElem = TYPED_ARRAY_BYTES_PER_ELEMENT[bufRecvName!] ?? 1;
          if (bytesPerElem !== 1) {
            fctx.body.push({ op: "i32.const", value: bytesPerElem } as Instr);
            fctx.body.push({ op: "i32.mul" } as Instr);
          }
          fctx.body.push({ op: "local.set", index: byteLenLocal } as Instr);
        }
        // Build the i32_byte ArrayBuffer vec: struct.new (byteLen, zero-filled
        // array of byteLen bytes). One i32 per byte (0..255), matching the
        // ArrayBuffer / DataView backing representation (dataview-native.ts).
        fctx.body.push({ op: "local.get", index: byteLenLocal } as Instr);
        fctx.body.push({ op: "i32.const", value: 0 } as Instr); // default byte value
        fctx.body.push({ op: "local.get", index: byteLenLocal } as Instr);
        fctx.body.push({ op: "array.new", typeIdx: byteArrTypeIdx } as Instr);
        fctx.body.push({ op: "struct.new", typeIdx: byteVecTypeIdx } as Instr);
        return { kind: "ref", typeIdx: byteVecTypeIdx };
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
          { op: "local.get", index: tmpAny } as Instr,
          { op: "ref.cast", typeIdx: structTypeIdx! } as Instr,
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
            successInstrs.push({ op: "extern.convert_any" } as Instr);
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
        // (#2963) IDENTITY-STABLE reified builtin value: read via a module-level
        // singleton so `Array.isArray === Array.isArray`, `Number.isInteger ===
        // Number.isInteger`, etc. hold (a fresh `struct.new` per read gave two
        // distinct instances → `!==`). Distinct builtins keep distinct singleton
        // globals, so `Array.isArray !== Number.isInteger` still holds.
        fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
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
          if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
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
          const lenFn = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
          flushLateImportShifts(ctx, fctx);
          // (#2576, extends #2187) The `any`/unknown value may actually be a
          // native `$AnyString` (object string-value read, generator yield read,
          // catch binding, indexed element read). `__extern_length` reads
          // $ObjVec/array length and returns 0 for a bare string, so guard with
          // `ref.test $AnyString` first: a string hit reads `$AnyString.len`
          // (field 0); the miss falls to the existing `__extern_length`
          // array/$ObjVec reader. Always computes an i32 length, converted to f64
          // once below in !fast mode. sd-3's `receiverIsNativeStringValType` arm
          // (above) already handles the bare-identifier-with-string-ref-local
          // case; this covers the opaque-externref cases it cannot see statically.
          if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
            emitGuardedNativeStringLength(ctx, fctx, (recvExternLocal) =>
              lenFn !== undefined
                ? [
                    { op: "local.get", index: recvExternLocal } as Instr,
                    { op: "call", funcIdx: lenFn } as Instr,
                    { op: "i32.trunc_sat_f64_s" } as Instr,
                  ]
                : [{ op: "i32.const", value: 0 } as Instr],
            );
            if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
            return ctx.fast ? { kind: "i32" } : { kind: "f64" };
          }
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

    // (#2101a R5) Own-field READ on an externref-backed Error subclass. The
    // instance is the parent `$Error_struct` externref, NOT a `$A` struct, so
    // the struct.get-on-`$A` path below traps. message/name/stack were already
    // handled by the Error fast-path above (~L2227); any other property is a
    // user-declared own field living in the `$Error_struct.$props` (fieldIdx 5)
    // open-`$Object` backing. Read it via `__extern_get(self.props, propName)`
    // (null/undefined when props is null). Standalone only.
    if (ctx.standalone && ctx.classExternrefBackedSet.has(typeName)) {
      const ownRead = emitExternrefBackedOwnFieldRead(ctx, fctx, expr, propName);
      if (ownRead !== undefined) return ownRead;
      // undefined → helper unavailable; fall through to the legacy path.
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
                  { op: "local.get", index: tmpAnyExt } as Instr,
                  { op: "extern.convert_any" } as Instr,
                  { op: "call", funcIdx: getMemberIdx } as Instr,
                  ...coercionInstrs(ctx, { kind: "externref" }, resultWasm, fctx),
                  { op: "local.set", index: resultLocal } as Instr,
                ]
              : externGetFallback;

          // Build nested if/else chain for struct candidates
          const buildStructDispatch = (idx: number): Instr[] => {
            if (idx >= structCandidates.length) {
              return dispatchTerminal;
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

        // (#2963) No struct-FIELD candidates — but when a CLASS METHOD named
        // `propName` exists, route through the `__get_member_<name>` dispatcher:
        // its terminal is the same `__extern_get` (own/sidecar props keep
        // shadowing) plus miss-gated method arms answering the canonical
        // method-value singleton — the SAME cache global the typed
        // `C.prototype.m` read uses — so a dynamic `any`-receiver method read
        // resolves to an identical, `===`-stable value instead of `undefined`
        // (the ~87-file `assert.sameValue(c.m, C.prototype.m)` class-elements
        // cluster). Modules with no class-method of this name are byte-identical.
        if (classMethodCandidatesForProp(ctx, propName).length > 0) {
          const getMemberIdx = reserveMemberGetDispatch(ctx, propName, fctx);
          if (getMemberIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: objTmp });
            fctx.body.push({ op: "call", funcIdx: getMemberIdx } as Instr);
            if (accessWasm.kind === "f64") {
              if (unboxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: unboxIdx });
              return { kind: "f64" };
            }
            if (accessWasm.kind === "i32") {
              if (unboxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: unboxIdx });
              fctx.body.push({ op: "i32.trunc_sat_f64_s" });
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
    // (#856 — typed field access). Gated on a JS host (the standalone path keeps
    // its existing default; the native equivalent rides on the #1888 open-object
    // runtime).
    const fnctorOrAnonMop =
      !!typeName &&
      !ctx.classSet.has(typeName) &&
      (typeName.startsWith("__fnctor_") || typeName.startsWith("__anon")) &&
      !noJsHost(ctx);
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
): void {
  // Save index + array ref (consumed by the bounds test AND the bounded read).
  const idxLocal = allocLocal(fctx, `__oobu_idx_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__oobu_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: idxLocal });
  fctx.body.push({ op: "local.set", index: arrLocal });

  // (1) inBounds = (unsigned) idx < array.len. A negative index wraps to a huge
  // unsigned value > any length, so it falls into the OOB (undefined) arm too.
  const inBoundsLocal = allocLocal(fctx, `__oobu_in_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_u" } as Instr);
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
  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: { kind: "externref" } },
    then: [{ op: "local.get", index: boxedLocal } as Instr],
    else: [{ op: "local.get", index: undefLocal } as Instr],
  } as Instr);
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
  fctx.body.push({ op: "i32.lt_u" } as Instr);
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
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
  } else if (elementType.kind === "i32") {
    fctx.body.push({ op: signedness === "u" ? "f64.convert_i32_u" : "f64.convert_i32_s" } as Instr);
  } else if (elementType.kind === "f32") {
    fctx.body.push({ op: "f64.promote_f32" } as Instr);
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
    then: [{ op: "local.get", index: boxedLocal } as Instr],
    else: [{ op: "local.get", index: undefLocal } as Instr],
  } as Instr);
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

  // #1910 R4 — String-wrapper integer-indexed read `w[i]` in standalone.
  // `new String("ab")[0]` is a String-exotic indexed own property (§10.4.3.x
  // CanonicalNumericIndexString) returning the 1-char substring at that index.
  // The wrapper is a `$Object` carrying its [[StringData]] native string in the
  // FLAG_INTERNAL slot, which the generic `$Object` index path can't read, so it
  // null-derefs. Recover the slot string via `__to_primitive(recv, "string")`,
  // then reuse the existing native `__str_charAt(flat, i)` helper (§22.1.3.1
  // semantics — out-of-range yields ""). Standalone + nativeStrings only; the
  // host path keeps its own String-exotic indexer.
  if (ctx.standalone && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    const recvWrapTsType = ctx.checker.getTypeAtLocation(expr.expression);
    if (isStringWrapperType(recvWrapTsType) && isNumericIndexExpression(ctx, expr.argumentExpression)) {
      ensureObjectRuntime(ctx);
      ensureNativeStringHelpers(ctx);
      const toPrimIdx = ctx.funcMap.get("__to_primitive");
      const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
      if (toPrimIdx !== undefined && charAtIdx !== undefined) {
        // [[StringData]] native string ← __to_primitive(recv, "string").
        compileExpression(ctx, fctx, expr.expression, { kind: "externref" });
        addStringConstantGlobal(ctx, "string");
        fctx.body.push(...stringConstantExternrefInstrs(ctx, "string"));
        fctx.body.push({ op: "call", funcIdx: toPrimIdx });
        // __str_charAt wants a flattened `$AnyString` ref; coerce + flatten.
        coerceType(ctx, fctx, { kind: "externref" }, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
        const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
        if (flattenIdx !== undefined) fctx.body.push({ op: "call", funcIdx: flattenIdx });
        // index (i32)
        compileExpression(ctx, fctx, expr.argumentExpression, { kind: "i32" });
        fctx.body.push({ op: "call", funcIdx: charAtIdx });
        return { kind: "ref", typeIdx: ctx.nativeStrTypeIdx };
      }
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
    !isNumericIndexExpression(ctx, expr.argumentExpression) &&
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
export function isNumericIndexExpression(ctx: CodegenContext, index: ts.Expression): boolean {
  // Strip parens / `as` wrappers so `a[(i)]` / `a[i as number]` still match.
  let inner: ts.Expression = index;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
    inner = inner.expression;
  }
  if (ts.isNumericLiteral(inner)) return true;
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
    if (!ctx.standalone && ctx.vecTypeMap.size > 0 && isNumericIndexExpression(ctx, expr.argumentExpression)) {
      // recv externref is on the stack → recvLocal (allocated FIRST so the local
      // numbering of recv / idx / anyTmp is unchanged from before #3007).
      const recvLocal = allocLocal(fctx, `__nve_recv_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: recvLocal } as Instr);
      // (#3007) index → f64 → idxLocal, compiled BEFORE the fast-path funcIdxs are
      // captured. A computed index (`a[a.length - 1]`) lowers its own dynamic
      // reads, which can register late imports and shift every DEFINED-function
      // index — including `__vec_get`. The pre-#3007 order captured `__vec_get`
      // BEFORE this compile, so the index's imports left it stale; the desynced
      // `then` arm emitted an invalid instruction stream (`f64.convert_i32_s` on
      // the externref receiver → "expected i32, found externref", invalid Wasm).
      // Resolving the imports and `__vec_get` AFTER the index compile (single
      // flush) keeps every funcIdx live through emission. For a non-import-adding
      // index (e.g. a literal) the import order is identical, so valid output is
      // byte-for-byte unchanged.
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
      const idxLocal = allocLocal(fctx, `__nve_idx_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: idxLocal } as Instr);
      const extGetIdx = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      const boxNumIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      const vgIdx = ctx.funcMap.get("__vec_get") ?? reserveVecMethodHelper(ctx, "get");
      if (vgIdx !== undefined && extGetIdx !== undefined && boxNumIdx !== undefined) {
        // isVec = OR of ref.test over the registered vec carriers.
        const anyTmp = allocLocal(fctx, `__nve_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
        fctx.body.push({ op: "local.get", index: recvLocal } as Instr);
        fctx.body.push({ op: "any.convert_extern" } as Instr);
        fctx.body.push({ op: "local.set", index: anyTmp } as Instr);
        let emitted = false;
        for (const vi of new Set(ctx.vecTypeMap.values())) {
          fctx.body.push({ op: "local.get", index: anyTmp } as Instr);
          fctx.body.push({ op: "ref.test", typeIdx: vi } as Instr);
          if (emitted) fctx.body.push({ op: "i32.or" } as Instr);
          emitted = true;
        }
        // THEN: __vec_get(recv, i32(idx)).
        const thenStart = fctx.body.length;
        fctx.body.push({ op: "local.get", index: recvLocal } as Instr);
        fctx.body.push({ op: "local.get", index: idxLocal } as Instr);
        fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
        fctx.body.push({ op: "call", funcIdx: vgIdx } as Instr);
        const thenInstrs = fctx.body.splice(thenStart);
        // ELSE: __extern_get(recv, box(idx)).
        const elseStart = fctx.body.length;
        fctx.body.push({ op: "local.get", index: recvLocal } as Instr);
        fctx.body.push({ op: "local.get", index: idxLocal } as Instr);
        fctx.body.push({ op: "call", funcIdx: boxNumIdx } as Instr);
        fctx.body.push({ op: "call", funcIdx: extGetIdx } as Instr);
        const elseInstrs = fctx.body.splice(elseStart);
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: thenInstrs,
          else: elseInstrs,
        } as Instr);
        return { kind: "externref" };
      }
      // (#3007) Defensive fallback — recv/idx were consumed into locals above, so
      // if the fast-path imports are somehow unavailable we must not fall through
      // to the generic path (which expects recv on the stack). Emit the generic
      // host read from the stored locals. Unreachable in host mode (the box/extern
      // imports are always registerable), so this changes no valid output.
      fctx.body.push({ op: "local.get", index: recvLocal } as Instr);
      if (boxNumIdx !== undefined && extGetIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: idxLocal } as Instr);
        fctx.body.push({ op: "call", funcIdx: boxNumIdx } as Instr);
        fctx.body.push({ op: "call", funcIdx: extGetIdx } as Instr);
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" } as Instr);
      fctx.body.push({ op: "ref.null.extern" } as Instr);
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
    if (ctx.standalone && isNumericIndexExpression(ctx, expr.argumentExpression)) {
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
    fctx.body.push({ op: "local.set", index: svLocal } as Instr);
    // data = sv.data (the SHARED parent backing array, field 1)
    fctx.body.push({ op: "local.get", index: svLocal } as Instr);
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 } as Instr);
    // index = sv.byteOffset + i
    fctx.body.push({ op: "local.get", index: svLocal } as Instr);
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 2 } as Instr); // byteOffset
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "i32" });
    fctx.body.push({ op: "i32.add" } as Instr);
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
      // (#2582) Non-literal NUMERIC key on a struct whose fields are
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
              f.name !== undefined && /^(?:0|[1-9][0-9]*)$/.test(f.name) && f.type.kind === "externref",
          );
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
        // Only take the static key-switch when EVERY field is a numeric-named
        // externref slot (a plain numeric-keyed object literal). A mixed shape
        // falls through to the dynamic `__extern_get` path unchanged.
        if (numericFields.length > 0 && numericFields.length === typeDef.fields.length && keySwitchEligible) {
          // Receiver struct ref is already on the stack — stash it so each
          // switch arm can re-read the same field.
          const recvLocal = allocLocal(fctx, `__numkey_recv_${fctx.locals.length}`, {
            kind: "ref_null",
            typeIdx,
          });
          fctx.body.push({ op: "local.set", index: recvLocal } as Instr);
          // Key as f64 (numeric reads box through f64; matches the literal path).
          compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
          const keyLocal = allocLocal(fctx, `__numkey_idx_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: keyLocal } as Instr);
          // Build a nested if/else chain from the innermost (default) outward:
          //   if key==N0 then struct.get F0 else if key==N1 then … else null
          let chain: Instr[] = [{ op: "ref.null.extern" } as Instr];
          for (let i = numericFields.length - 1; i >= 0; i--) {
            const { f, idx } = numericFields[i]!;
            const fieldNum = Number(f.name);
            // Field is a numeric-named externref slot (guaranteed by the filter
            // above), so a bare `struct.get` already yields externref — the
            // unified result type of a dynamic-key read. No coercion needed.
            const thenArm: Instr[] = [
              { op: "local.get", index: recvLocal } as Instr,
              { op: "struct.get", typeIdx, fieldIdx: idx } as Instr,
            ];
            chain = [
              { op: "local.get", index: keyLocal } as Instr,
              { op: "f64.const", value: fieldNum } as Instr,
              { op: "f64.eq" } as Instr,
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "externref" } },
                then: thenArm,
                else: chain,
              } as Instr,
            ];
          }
          for (const instr of chain) fctx.body.push(instr);
          return { kind: "externref" };
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
      fctx.body.push({ op: "drop" } as Instr);
      const valuesIdx = ensureLateImport(ctx, "__array_proto_values", [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (valuesIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: valuesIdx } as Instr);
      } else {
        fctx.body.push({ op: "ref.null.extern" } as Instr);
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
    // below. Other `i32` elements (packed-number / other handle reps),
    // object-element (`ref`) arrays, and externref (`any[]`/`string[]`) keep their
    // typed result and are deferred (`f1BoxType === null`).
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
        arrDef.element.kind === "i8" || arrDef.element.kind === "i16"
          ? taSignedness === "s"
            ? "array.get_s"
            : taSignedness === "u"
              ? "array.get_u"
              : arrDef.element.kind === "i8"
                ? "array.get_u"
                : "array.get_s"
          : "array.get";
      fctx.body.push({ op: getOp, typeIdx: arrTypeIdx } as Instr);
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
      // other i32 / object / externref elements stay deferred (`f1BoxType ===
      // null`) and fall through to the unchanged shared-helper read below
      // (bounds-checked, never traps).
      emitPlainArrayUndefinedOobGet(ctx, fctx, arrTypeIdx, arrDef.element, f1BoxType);
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
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, arrDef.element, ctx, false, taSignedness);
    }
    // (#2593) `Uint32Array` element read: the i32_byte storage holds the full 32
    // bits; the value as a JS number is the UNSIGNED interpretation (0..2^32-1).
    // `array.get` on an i32 array yields a raw i32 whose default i32→f64 coercion
    // is SIGNED (−1 instead of 4294967295). For an unsigned i32 view convert the
    // i32 to f64 UNSIGNED here and return f64 so no signed re-coerce follows.
    // (Int32Array is signed → the default signed coercion is already correct;
    // i8/i16 already sign/zero-extended into the i32 via array.get_s/_u above.)
    if (arrDef.element.kind === "i32" && taSignedness === "u") {
      fctx.body.push({ op: "f64.convert_i32_u" } as Instr);
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
  // Compile index and convert to i32 (#1179: hint i32 directly to skip the
  // f64.convert_i32_s + i32.trunc_sat_f64_s round-trip when the index is
  // already an i32 local or integer literal).
  compileExpression(ctx, fctx, expr.argumentExpression, { kind: "i32" });
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
    fctx.body.push({ op: getOp, typeIdx } as Instr);
    // (#2001 S1) Map a `$Hole` slot back to `undefined` on bounds-eliminated
    // externref reads too (in-bounds ≠ present).
    if (ctx.usesArrayHoles && typeDef.element.kind === "externref") emitHoleToUndefined(ctx, fctx);
  } else if (oobUndefinedArr && f1BoxTypeArr !== null) {
    // (#2760 F1, #2785/#2792 type-aware box) Plain-array OOB → `undefined` for a
    // PRIMITIVE element: widen to a boxed-or-undefined externref, boxed by the
    // element's SEMANTIC type (`f1BoxTypeArr`: `{f64}` number[] → `__box_number`,
    // `{i32, boolean}` boolean[] → `__box_boolean`, `{i32, symbol}` symbol[] →
    // `__box_symbol`). Bounds-eliminated reads above keep the unboxed fast path.
    // Packed-number / other i32 / object / externref elements stay deferred
    // (`f1BoxTypeArr === null`) and fall through to the unchanged shared-helper
    // read below. See the full note at the vec-struct call site above.
    emitPlainArrayUndefinedOobGet(ctx, fctx, typeIdx, typeDef.element, f1BoxTypeArr);
    return { kind: "externref" };
  } else if (oobUndefinedTypedArrayArr) {
    // (#2798 Row 9) Typed-array OOB → JS `undefined`, in-bounds → the element
    // boxed as a JS number. See the full note at the vec-struct call site.
    emitTypedArrayUndefinedOobGet(ctx, fctx, typeIdx, typeDef.element, taSignednessArr);
    return { kind: "externref" };
  } else {
    // (#2001 S1) Pass `ctx` for the in-bounds `$Hole → undefined` mapping.
    // (#2593) Thread the view-name signedness for packed i8/i16 reads.
    emitBoundsCheckedArrayGet(fctx, typeIdx, typeDef.element, ctx, false, taSignednessArr);
  }
  return valueType;
}
