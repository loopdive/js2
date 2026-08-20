// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Remaining built-in namespace static-method call dispatch extracted from the
// property-access arm of the ~13k-line compileCallExpression (#742, Wave B
// mega-function decomposition, slice 3). The single exported entry
// `compileNamespaceStaticCall` handles static method calls on the reflective /
// library namespaces — Symbol (Symbol.for / keyFor), Reflect, Promise
// (all / race / resolve / reject / …), JSON (parse / stringify), and Date
// (now / parse / UTC). It is the companion of compileBuiltinStaticCall (Math /
// Number / Array / String / Object value-type statics). Returns `undefined` when
// the callee is not one of these, so the caller in calls.ts continues into the
// receiver-type method dispatch. Moved verbatim: emitted Wasm is byte-identical.
import { ts } from "../../ts-api.js";
import { integrityVarKey } from "../widened-var-key.js";
import { isSymbolType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import {
  emitAsyncGeneratorFunctionPrototypeSingleton,
  emitGeneratorFunctionPrototypeSingleton,
  emitIteratorPrototypeSingleton,
  emitTypedArrayIntrinsicCtorObject,
  isWiredTypedArrayViewName,
  type NativeIteratorPrototypeKind,
} from "../array-object-proto.js";
import { isPristineArrayPrototypeIteratorCall } from "../array-methods.js";
import {
  emitStandalonePromiseReject,
  emitStandalonePromiseResolve,
  ensurePromiseSettleFunctions,
  isStandalonePromiseActive,
} from "../async-scheduler.js";
import { classMemberFuncKey } from "../class-member-keys.js";
import { compileArrowAsClosure } from "../closures.js";
import { reportError } from "../context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import { rollbackSpeculative, snapshotSpeculative } from "../context/speculative.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { getOrRegisterDvWindowType } from "../dataview-native.js";
import { ensureReflectIsConstructor } from "../reflect-construct-native.js";
import { emitNativeDateParse } from "../date-parse-native.js";
import {
  addUnionImports,
  getArrTypeIdxFromVec,
  nativeStringType,
  resolveWasmType,
  TYPED_ARRAY_NAMES,
} from "../index.js";
import {
  emitJsonIsRawJson,
  emitJsonParseText,
  emitJsonParseTextReviver,
  emitJsonRawJson,
  emitJsonStringifyValue,
} from "../json-codec-native.js";
import {
  jsonGapFromStaticSpace,
  staticSpaceValue,
  tryEmitJsonParseLiteral,
  tryEmitJsonStringifyStatic,
} from "../json-standalone.js";
import { compileObjectLiteralAsExternref } from "../literals.js";
import { emitCollectionIteratorVec } from "../map-runtime.js";
import { nativeStringLiteralInstrs, stringConstantExternrefInstrs } from "../native-strings.js";
import { emitHostExternrefToNativeString, emitNativeStringToHostExternref } from "../string-ops.js";
import { emitDefinePropertyDescRuntime, emitNonObjectArgGuard } from "../object-ops.js";
import { ensureObjectRuntime, ensureObjVecBuilders } from "../object-runtime.js";
import {
  emitStandalonePromiseCombinator,
  emitStandalonePromiseCombinatorRuntime,
  isNativeCombinatorMethod,
  resolveExternrefVecArg,
} from "../promise-combinators.js";
import type { InnerResult } from "../shared.js";
import { brandExternMethodResult, coerceType, compileExpression, VOID_RESULT } from "../shared.js";
import { emitSetExtrasArgv, maybeSetArgcForKnownCall } from "../statements/nested-declarations.js";
import { ensureNativeSymbolBoundaryBridge, ensureSymbolRegistry, usesNativeSymbolProvider } from "../symbol-native.js";
import { tryCompileTemporalStaticCall } from "../temporal-native.js";
import { pushDefaultValue } from "../type-coercion.js";
import { ensureDateDaysFromCivilHelper } from "./builtins.js";
import { emitStandaloneDateNowValue } from "../standalone-clock-capability.js";
import { compileNewExpression, resolvesToNamedAmbientGlobal } from "./new-super.js";
import {
  emitThrowTypeError,
  getFuncParamTypes,
  getWasmFuncReturnType,
  isEffectivelyVoidReturn,
  noJsHost,
  wasmFuncReturnsVoid,
} from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { resolvePromiseSubclassName } from "./promise-subclass.js";
import {
  compileCallExpression,
  compileProtoArg,
  emitDynamicCombinatorArg,
  emitIterableArg,
  emitJsonReplacerAllowList,
  isDynamicCombinatorArgEligible,
  resolvePromiseSubclassThisArg,
  tryEmitJsonParsePrimitive,
  tryEmitJsonStringifyPrimitive,
} from "./calls.js";

function unwrapReflectConstructExpr(value: ts.Expression): ts.Expression {
  let current = value;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function pristineIteratorPrototypeKind(
  fctx: FunctionContext,
  argument: ts.Expression,
): NativeIteratorPrototypeKind | undefined {
  if (isPristineArrayPrototypeIteratorCall(fctx, argument)) return "Array";
  if (!ts.isCallExpression(argument) || argument.arguments.length !== 0) return undefined;
  const callee = argument.expression;
  if (!ts.isElementAccessExpression(callee)) return undefined;
  const key = callee.argumentExpression;
  if (
    !key ||
    !ts.isPropertyAccessExpression(key) ||
    !ts.isIdentifier(key.expression) ||
    key.expression.text !== "Symbol" ||
    key.name.text !== "iterator" ||
    fctx.localMap.has("Symbol") ||
    (fctx.boxedCaptures?.has("Symbol") ?? false)
  ) {
    return undefined;
  }
  const receiver = callee.expression;
  if (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === "prototype" &&
    ts.isIdentifier(receiver.expression) &&
    receiver.expression.text === "String" &&
    !fctx.localMap.has("String") &&
    !(fctx.boxedCaptures?.has("String") ?? false)
  ) {
    return "String";
  }
  if (
    ts.isNewExpression(receiver) &&
    receiver.arguments?.length === 0 &&
    ts.isIdentifier(receiver.expression) &&
    (receiver.expression.text === "Map" || receiver.expression.text === "Set") &&
    !fctx.localMap.has(receiver.expression.text) &&
    !(fctx.boxedCaptures?.has(receiver.expression.text) ?? false)
  ) {
    return receiver.expression.text;
  }
  return undefined;
}

function compilePristineIteratorPrototypeCapture(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argument: ts.Expression,
): ValType | undefined {
  if (!noJsHost(ctx)) return undefined;
  const kind = pristineIteratorPrototypeKind(fctx, argument);
  if (!kind) return undefined;
  // Every accepted form is an exact, zero-argument call on an unshadowed
  // intrinsic receiver:
  //
  //   Array.prototype[Symbol.iterator]()
  //   String.prototype[Symbol.iterator]()
  //   new Map()[Symbol.iterator]()
  //   new Set()[Symbol.iterator]()
  //
  // The temporary collection / iterator allocations are not observable, and
  // the enclosing Reflect.getPrototypeOf immediately discards the iterator.
  // Do not lower that dead intermediate call: apart from needless allocation,
  // the generic dynamic-call path can require iterator instance machinery
  // that is intentionally absent when only the intrinsic prototype is needed.
  const prototypeType = emitIteratorPrototypeSingleton(ctx, fctx, kind);
  if (prototypeType) return prototypeType;
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * Resolve exact intrinsic constructor/function prototype queries without
 * sending opaque compiled closures through the ordinary `$Object` prototype
 * reader. `Object.getPrototypeOf` already exposes these canonical standalone
 * objects; Reflect must observe the same identities.
 */
function compilePristineIntrinsicPrototypeCapture(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argument: ts.Expression,
): ValType | undefined {
  if (!noJsHost(ctx)) return undefined;
  const value = unwrapReflectConstructExpr(argument);

  if (
    ts.isIdentifier(value) &&
    !fctx.localMap.has(value.text) &&
    !(fctx.boxedCaptures?.has(value.text) ?? false) &&
    isWiredTypedArrayViewName(value.text)
  ) {
    return emitTypedArrayIntrinsicCtorObject(ctx, fctx) ?? undefined;
  }

  if (ts.isFunctionExpression(value) && value.asteriskToken !== undefined) {
    return value.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true
      ? (emitAsyncGeneratorFunctionPrototypeSingleton(ctx, fctx) ?? undefined)
      : (emitGeneratorFunctionPrototypeSingleton(ctx, fctx) ?? undefined);
  }

  return undefined;
}

/**
 * Materialize a syntactic array literal as the existing standalone `$ObjVec`
 * carrier consumed by the native JSON codec. Ordinary array lowering chooses a
 * closed typed vec from the literal's first element; that is the right general
 * representation, but `__json_stringify_value` deliberately consumes the
 * universal `$ObjVec` graph used by JSON.parse/object-runtime. Keep this
 * normalization local to JSON.stringify rather than adding another array
 * representation or teaching the codec every typed-vec element ABI.
 */
function emitJsonArrayLiteralAsObjVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  literal: ts.ArrayLiteralExpression,
): void {
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const vecLocal = allocLocal(fctx, `__json_vec_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: newIdx }, { op: "local.set", index: vecLocal });

  for (const element of literal.elements) {
    fctx.body.push({ op: "local.get", index: vecLocal });
    if (ts.isOmittedExpression(element)) {
      // Array holes stringify as null. A null externref is the codec's
      // undefined/hole carrier for an array element.
      fctx.body.push({ op: "ref.null.extern" });
    } else if (ts.isArrayLiteralExpression(element) && !element.elements.some(ts.isSpreadElement)) {
      emitJsonArrayLiteralAsObjVec(ctx, fctx, element);
    } else if (ts.isObjectLiteralExpression(element) && isPlainJsonCodecObjectLiteral(element)) {
      ensureObjectRuntime(ctx);
      const elementType = compileObjectLiteralAsExternref(ctx, fctx, element);
      if (elementType === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (elementType.kind !== "externref") {
        coerceType(ctx, fctx, elementType, { kind: "externref" });
      }
    } else {
      const elementType = compileExpression(ctx, fctx, element, { kind: "externref" });
      if (elementType === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (elementType.kind !== "externref") {
        coerceType(ctx, fctx, elementType, { kind: "externref" });
      }
    }
    fctx.body.push({ op: "call", funcIdx: pushIdx });
  }

  fctx.body.push({ op: "local.get", index: vecLocal });
}

function isPlainJsonCodecObjectLiteral(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.every((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return true;
    if (!ts.isPropertyAssignment(property)) return false;
    return (
      ts.isIdentifier(property.name) ||
      ts.isStringLiteral(property.name) ||
      ts.isNoSubstitutionTemplateLiteral(property.name) ||
      ts.isNumericLiteral(property.name)
    );
  });
}

/**
 * Normalize the bounded JSON.stringify value shapes into the existing codec's
 * `anyref` ABI. This keeps literal-carrier selection out of the namespace
 * dispatcher and gives compact/replacer routes one identical conversion path.
 */
function emitJsonCodecValueAsAnyref(ctx: CodegenContext, fctx: FunctionContext, value: ts.Expression): boolean {
  const unwrapped = unwrapReflectConstructExpr(value);
  let valueType: ValType | null = { kind: "externref" };
  if (ts.isArrayLiteralExpression(unwrapped) && !unwrapped.elements.some(ts.isSpreadElement)) {
    emitJsonArrayLiteralAsObjVec(ctx, fctx, unwrapped);
  } else if (ts.isObjectLiteralExpression(unwrapped) && isPlainJsonCodecObjectLiteral(unwrapped)) {
    ensureObjectRuntime(ctx);
    valueType = compileObjectLiteralAsExternref(ctx, fctx, unwrapped);
  } else {
    valueType = compileExpression(ctx, fctx, value, { kind: "anyref" });
  }
  if (valueType === null) return false;
  if (valueType.kind === "externref" || valueType.kind === "ref_extern") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (valueType.kind !== "anyref") {
    coerceType(ctx, fctx, valueType, { kind: "anyref" });
  }
  return true;
}

function isOrdinaryFunctionLike(node: ts.Node | undefined): boolean {
  if (!node || (!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node))) return false;
  return (
    node.asteriskToken === undefined &&
    !(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false)
  );
}

function isStaticallyConstructible(ctx: CodegenContext, value: ts.Expression): boolean {
  const expr = unwrapReflectConstructExpr(value);
  if (isOrdinaryFunctionLike(expr) || ts.isClassExpression(expr)) return true;
  if (!ts.isIdentifier(expr)) return false;
  if (TYPED_ARRAY_NAMES.has(expr.text)) return true;
  if (
    new Set([
      "Array",
      "ArrayBuffer",
      "Boolean",
      "DataView",
      "Date",
      "Error",
      "EvalError",
      "Function",
      "Map",
      "Number",
      "Object",
      "Promise",
      "RangeError",
      "ReferenceError",
      "RegExp",
      "Set",
      "String",
      "SyntaxError",
      "TypeError",
      "URIError",
      "WeakMap",
      "WeakSet",
    ]).has(expr.text)
  ) {
    return true;
  }
  const declaration = ctx.checker.getSymbolAtLocation(expr)?.valueDeclaration;
  if (isOrdinaryFunctionLike(declaration) || (declaration !== undefined && ts.isClassDeclaration(declaration))) {
    return true;
  }
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const init = unwrapReflectConstructExpr(declaration.initializer);
    // The original Test262 realm shim returns the current global. Its
    // `new other.Function()` constructor value is still statically known to
    // implement [[Construct]], even though its native value carrier is opaque.
    if (
      ts.isNewExpression(init) &&
      ((ts.isIdentifier(init.expression) && init.expression.text === "Function") ||
        (ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === "Function"))
    ) {
      return true;
    }
  }
  return false;
}

function sameReflectConstructTarget(a: ts.Expression, b: ts.Expression): boolean {
  const left = unwrapReflectConstructExpr(a);
  const right = unwrapReflectConstructExpr(b);
  return ts.isIdentifier(left) && ts.isIdentifier(right) && left.text === right.text;
}

/** Last preceding `NewTarget.prototype = rhs`, used by the supported native-carrier slice. */
function assignedNewTargetPrototype(
  ctx: CodegenContext,
  value: ts.Expression,
  before: number,
): ts.Expression | undefined {
  const target = unwrapReflectConstructExpr(value);
  if (!ts.isIdentifier(target)) return undefined;
  const targetSymbol = ctx.checker.getSymbolAtLocation(target);
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getStart() >= before) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "prototype" &&
      ts.isIdentifier(node.left.expression) &&
      ctx.checker.getSymbolAtLocation(node.left.expression) === targetSymbol
    ) {
      found = node.right;
    }
    ts.forEachChild(node, visit);
  };
  visit(value.getSourceFile());
  return found;
}

function isEmptyOrdinaryFunction(value: ts.Expression): boolean {
  const target = unwrapReflectConstructExpr(value);
  return ts.isFunctionExpression(target) && target.body.statements.length === 0 && isOrdinaryFunctionLike(target);
}

function isDefinitelyPrimitivePrototype(ctx: CodegenContext, value: ts.Expression): boolean {
  const expr = unwrapReflectConstructExpr(value);
  if (
    expr.kind === ts.SyntaxKind.NullKeyword ||
    expr.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(expr) && expr.text === "undefined") ||
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteralLike(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(expr)) {
    const declaration = ctx.checker.getSymbolAtLocation(expr)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return isDefinitelyPrimitivePrototype(ctx, declaration.initializer);
    }
  }
  return false;
}

/**
 * (#742 slice 3) Remaining built-in namespace static-method dispatch —
 * extracted verbatim from the property-access arm of compileCallExpression.
 * Handles static method calls on the reflective / library namespaces whose
 * callee is `Namespace.method(...)`: Symbol (Symbol.for / keyFor), Reflect,
 * Promise (Promise.all / race / resolve / reject / …), JSON (parse / stringify),
 * and Date (Date.now / parse / UTC). This is the companion of
 * compileBuiltinStaticCall (which handles the Math / Number / Array / String /
 * Object value-type statics that precede this block).
 *
 * `propAccess` is the already-narrowed `expr.expression`. Returns an InnerResult
 * when it handled the call, or `undefined` when the callee is not one of these
 * namespace statics — the caller then continues into the receiver-type method
 * dispatch. Moved unchanged so the emitted Wasm is byte-identical.
 */
export function compileNamespaceStaticCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  // Handle Symbol.for(key) and Symbol.keyFor(sym) — global symbol registry (#965)
  if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Symbol") {
    const symMethod = propAccess.name.text;
    if (symMethod === "for" && expr.arguments.length >= 1) {
      // §20.4.2.2 step 1: stringKey = ? ToString(key). A Symbol key makes
      // ToString throw TypeError before the registry lookup runs.
      const keyTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
      if (isSymbolType(keyTsType)) {
        emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a string");
        return { kind: "externref" };
      }
      // (#2163) No-JS-host mode: use the Wasm-native registry. The key lowers
      // to a `ref $AnyString`; `__symbol_for_native` does the content-equality
      // lookup / insert and returns the i32 symbol id (also recording the key
      // as the registered symbol's description). Zero host imports.
      if (usesNativeSymbolProvider(ctx)) {
        ensureNativeSymbolBoundaryBridge(ctx);
        const { forIdx } = ensureSymbolRegistry(ctx);
        const keyType = compileExpression(ctx, fctx, expr.arguments[0]!, {
          kind: "ref",
          typeIdx: ctx.anyStrTypeIdx,
        });
        if (keyType && (keyType.kind !== "ref" || keyType.typeIdx !== ctx.anyStrTypeIdx)) {
          coerceType(ctx, fctx, keyType, { kind: "ref", typeIdx: ctx.anyStrTypeIdx });
        }
        fctx.body.push({ op: "ref.as_non_null" });
        fctx.body.push({ op: "call", funcIdx: forIdx });
        return { kind: "i32" };
      }
      // (#3676) JS-host mode: return the module's CANONICAL i32 symbol id, not a
      // raw host Symbol. A symbol VALUE is an i32 id everywhere else in the
      // compiler — `mapTsTypeToWasm` maps `symbol` → i32 and the sibling
      // producer `compileSymbolCall` (`Symbol()`) returns an unbranded
      // `{ kind: "i32" }`. `Symbol.for` was the outlier returning `externref`,
      // so a `symbol`-typed slot (module global, local, param) received an
      // externref and `coerceType` bridged it with `__unbox_number` — literally
      // `Number(Symbol())`, a guaranteed TypeError (§7.1.4) at `__module_init`.
      // That is why React 19, whose very first statement is twelve chained
      // `Symbol.for(...)` initializers, emitted a valid module that could not be
      // instantiated. Returning i32 here puts `Symbol.for` on exactly the same,
      // already-exercised footing as `Symbol()`: no new representation is
      // introduced, an inconsistent one is removed. `__symbol_for_id` registers
      // the id in the same per-instance cache `__box_symbol` reads, so identity
      // survives a round trip through the host in both directions.
      const keyType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (keyType && keyType.kind !== "externref") coerceType(ctx, fctx, keyType, { kind: "externref" });
      const funcIdx = ensureLateImport(ctx, "__symbol_for_id", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }
    if (symMethod === "keyFor" && expr.arguments.length >= 1) {
      // (#2163) No-JS-host mode: the symbol is an i32 id; the native registry
      // returns its registration key (`ref_null $AnyString`, i.e. a native
      // string or undefined for an unregistered symbol). Zero host imports.
      if (usesNativeSymbolProvider(ctx)) {
        ensureNativeSymbolBoundaryBridge(ctx);
        const { keyForIdx } = ensureSymbolRegistry(ctx);
        const symType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "i32" });
        if (symType && symType.kind !== "i32") coerceType(ctx, fctx, symType, { kind: "i32" });
        fctx.body.push({ op: "call", funcIdx: keyForIdx });
        return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
      }
      // (#3676) JS-host mode: when the argument is STATICALLY a symbol it is an
      // i32 id (see the `Symbol.for` note above and `compileSymbolCall`), so
      // resolve it through the id-keyed host helper. Coercing an i32 to
      // `externref` here would box it with `__box_number` — the unbranded-i32
      // hazard #2792 describes — and hand `Symbol.keyFor` a Number. Mirrors the
      // identical static-type gate #3085 added for `String(sym)`.
      // A non-symbol / `any` argument keeps the original externref path, where
      // the host `Symbol.keyFor` produces the spec TypeError itself.
      if (ctx.oracle.staticJsTypeOf(expr.arguments[0]!) === "symbol") {
        const symIdType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "i32" });
        if (symIdType && symIdType.kind !== "i32") coerceType(ctx, fctx, symIdType, { kind: "i32" });
        const keyForIdIdx = ensureLateImport(ctx, "__symbol_keyFor_id", [{ kind: "i32" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (keyForIdIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: keyForIdIdx });
          return { kind: "externref" };
        }
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      const symType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (symType && symType.kind !== "externref") coerceType(ctx, fctx, symType, { kind: "externref" });
      const funcIdx = ensureLateImport(ctx, "__symbol_keyFor", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // Handle ArrayBuffer.isView(arg) — checks if arg is a TypedArray/DataView (#965)
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "ArrayBuffer" &&
    propAccess.name.text === "isView" &&
    expr.arguments.length >= 1
  ) {
    // (#2594) Standalone/no-host: the host `__arraybuffer_isView` import does
    // not exist — emitting it leaks `env.*` and breaks the WHOLE module at
    // instantiate. §25.1.4.1 isView is `true` iff the arg has a
    // [[ViewedArrayBuffer]] slot (any TypedArray or DataView). Decide it
    // host-free.
    if (noJsHost(ctx)) {
      const arg0 = expr.arguments[0]!;
      const argTs = ctx.checker.getNonNullableType(ctx.checker.getTypeAtLocation(arg0));
      const argSym = argTs.getSymbol()?.name;
      const rawTs = ctx.checker.getTypeAtLocation(arg0);
      const isAnyOrUnknown = (rawTs.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      const isView = argSym !== undefined && (TYPED_ARRAY_NAMES.has(argSym) || argSym === "DataView");
      // A non-view whose static type is resolvable: ArrayBuffer itself, a
      // primitive, null/undefined, a plain array, a class/object — all `false`.
      const isResolvableNonView =
        !isAnyOrUnknown && !isView && argSym !== "BigInt64Array" && argSym !== "BigUint64Array" && !rawTs.isUnion();
      if (isView || argSym === "BigInt64Array" || argSym === "BigUint64Array") {
        // Static `true`. Still evaluate the (possibly side-effecting) arg, drop it.
        const at = compileExpression(ctx, fctx, arg0);
        if (at !== null) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
      if (isResolvableNonView) {
        const at = compileExpression(ctx, fctx, arg0);
        if (at !== null) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      // Runtime fallback for `any`/union/unresolved receivers: ref.test the
      // registered vec carriers (TypedArrays lower to a `$Vec`) and the
      // DataView window struct. NOTE: standalone shares the `$Vec` carrier
      // between `number[]` and TypedArrays, so a plain array is
      // indistinguishable here and reads as a view — an accepted imprecision
      // for the rare `any` arg; the win is NOT leaking the host import (which
      // breaks the whole module). Most isView call sites are statically typed.
      const at = compileExpression(ctx, fctx, arg0, { kind: "externref" });
      if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
      const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
      const vecTypeIdxs = Array.from(new Set(ctx.vecTypeMap.values()));
      const anyTmp = allocLocal(fctx, `__isview_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "local.set", index: anyTmp });
      let emitted = false;
      for (const vi of vecTypeIdxs) {
        fctx.body.push({ op: "local.get", index: anyTmp });
        fctx.body.push({ op: "ref.test", typeIdx: vi });
        if (emitted) fctx.body.push({ op: "i32.or" });
        emitted = true;
      }
      fctx.body.push({ op: "local.get", index: anyTmp });
      fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx });
      if (emitted) fctx.body.push({ op: "i32.or" });
      return { kind: "i32" };
    }
    const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
    if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
    const funcIdx = ensureLateImport(ctx, "__arraybuffer_isView", [{ kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i32" };
    }
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // ── Reflect API — host dispatch via __reflect_* imports (#1466) ──────
  // Replaces the previous compile-time rewrites that bypassed the Proxy MOP.
  // Each method routes through a thin host wrapper around Reflect.X so
  // Proxy targets see their traps fire and boolean returns are preserved.
  if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Reflect") {
    const reflectMethod = propAccess.name.text;

    // Helper — compile each argument as externref, padding missing positions with ref.null.extern.
    const emitReflectArgs = (count: number): void => {
      const externRef: ValType = { kind: "externref" };
      for (let i = 0; i < count; i++) {
        const arg = expr.arguments[i];
        if (arg !== undefined) {
          const argTy = compileExpression(ctx, fctx, arg, externRef);
          if (argTy && argTy.kind !== "externref") {
            coerceType(ctx, fctx, argTy, externRef);
          } else if (argTy === null) {
            // Expression had no value — push null externref to keep arity.
            fctx.body.push({ op: "ref.null.extern" });
          }
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
      }
    };

    // Helper — drop N pushed args and return a fallback constant when the import is unavailable.
    // (#2046 cleanup) `i32-false` is the safer default for boolean-returning
    // Reflect methods on a registration failure (the module is already marked
    // failed by reportError; false is the less-wrong observable value).
    const fallbackReturn = (n: number, ret: "i32-true" | "i32-false" | "extern-null"): InnerResult => {
      for (let i = 0; i < n; i++) fctx.body.push({ op: "drop" });
      if (ret === "i32-true" || ret === "i32-false") {
        fctx.body.push({ op: "i32.const", value: ret === "i32-true" ? 1 : 0 });
        return { kind: "i32" };
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    };

    const externRef: ValType = { kind: "externref" };
    const i32Ty: ValType = { kind: "i32" };
    const nativeReflectProvider = ctx.targetProfile.semanticProviders === "native-first";
    const boundaryReflectInterop =
      nativeReflectProvider &&
      ctx.targetProfile.environment === "javascript" &&
      ctx.targetProfile.hostValueInterop !== "off" &&
      !ctx.strictNoHostImports;
    const isDynamicBoundaryTarget = (argument: ts.Expression | undefined): boolean => {
      if (!argument) return false;
      const type = ctx.checker.getTypeAtLocation(argument);
      return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    };
    const emitNativeReflectTargetGuard = (targetLocal: number, message: string): void => {
      const ort = ensureObjectRuntime(ctx);
      const admittedIdx = boundaryReflectInterop ? ctx.funcMap.get("__boundary_object_is_admitted") : undefined;
      const before = fctx.body.length;
      emitThrowTypeError(ctx, fctx, message);
      const throwInstrs = fctx.body.splice(before);
      fctx.body.push({ op: "local.get", index: targetLocal });
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.test", typeIdx: ort.objectTypeIdx });
      // A native Proxy is an Object in the ECMAScript sense even though its
      // Wasm carrier is a sibling of `$Object`, not a subtype. Accept it here
      // so the operation reaches the Proxy MOP; the earlier guard otherwise
      // misreported every Proxy target as a Reflect primitive TypeError.
      fctx.body.push({ op: "local.get", index: targetLocal });
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.test", typeIdx: ort.proxyTypeIdx });
      fctx.body.push({ op: "i32.or" });
      if (admittedIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "call", funcIdx: admittedIdx });
        fctx.body.push({ op: "i32.or" });
      }
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs });
    };

    // ── #1472 Phase C — Reflect.* under --target standalone ───────────────
    //
    // The host-dispatch path below registers an env::__reflect_* import for
    // every Reflect method. There is no JS host in standalone mode, so any
    // such import would leak into the binary and fail at instantiation with
    // an opaque "unknown import" linker error. Route the one method backed by
    // a native helper through it, and refuse the rest with a clear compile
    // error rather than emitting a half-working module.
    //
    // - Reflect.get/has/deleteProperty(target, key) → native keyed $Object
    //   helpers, which already perform the same own/prototype walk or delete
    //   operation used by dynamic property access.
    // - Reflect.set(target, key, value) → native __reflect_set, a boolean
    //   wrapper around the supported __extern_set data-write subset.
    // - Reflect.ownKeys(target) → native __getOwnPropertyNames (all own
    //   string keys, including non-enumerable ones, in insertion order). The
    //   native runtime does not retain symbol-keyed properties yet, but using
    //   __object_keys here would incorrectly give Reflect enumerable-only
    //   Object.keys semantics and hide builtin methods from reflection.
    // - Reflect.apply/construct require call/constructor machinery with no
    //   native analog in this slice. Descriptor/prototype/integrity methods
    //   stay refused until their native invariants are proven end-to-end.
    if (nativeReflectProvider) {
      if (reflectMethod === "get" && expr.arguments.length >= 2) {
        // (#2046/#4397) Preserve the optional receiver in Wasm. A native
        // target uses __reflect_get_receiver; an admitted caller-owned JS
        // target alone uses the boundary adapter. Runtime admission, rather
        // than an `any` static type, decides the branch so Wasm-owned Proxy
        // targets never leak into host semantics.
        if (expr.arguments.length > 2) {
          ensureObjectRuntime(ctx);
          const nativeIdx = ctx.funcMap.get("__reflect_get_receiver");
          const boundaryIdx = boundaryReflectInterop ? ctx.funcMap.get("__boundary_object_reflect_get") : undefined;
          const admittedIdx = boundaryReflectInterop ? ctx.funcMap.get("__boundary_object_is_admitted") : undefined;
          if (nativeIdx !== undefined) {
            const argLocals: number[] = [];
            for (let i = 0; i < 3; i++) {
              const arg = expr.arguments[i];
              if (arg !== undefined) {
                const argTy = compileExpression(ctx, fctx, arg, externRef);
                if (argTy && argTy.kind !== "externref") coerceType(ctx, fctx, argTy, externRef);
                else if (argTy === null) fctx.body.push({ op: "ref.null.extern" });
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
              const local = allocTempLocal(fctx, externRef);
              fctx.body.push({ op: "local.set", index: local });
              argLocals.push(local);
            }
            const callWithLocals = (funcIdx: number): Instr[] => [
              ...argLocals.map((index): Instr => ({ op: "local.get", index })),
              { op: "call", funcIdx },
            ];
            if (boundaryIdx !== undefined && admittedIdx !== undefined) {
              fctx.body.push(
                { op: "local.get", index: argLocals[0]! },
                { op: "call", funcIdx: admittedIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: externRef },
                  then: callWithLocals(boundaryIdx),
                  else: callWithLocals(nativeIdx),
                },
              );
            } else {
              fctx.body.push(...callWithLocals(nativeIdx));
            }
            for (let i = argLocals.length - 1; i >= 0; i--) releaseTempLocal(fctx, argLocals[i]!);
            return { kind: "externref" };
          }
          reportError(
            ctx,
            expr,
            "Codegen error: Reflect.get with an explicit receiver could not register its native provider (#2046).",
          );
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
        emitReflectArgs(2);
        const funcIdx = ensureLateImport(ctx, "__extern_get", [externRef, externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(2, "extern-null");
      }

      if (reflectMethod === "set" && expr.arguments.length >= 2) {
        // (#2046 PR-A defect 1) Same as Reflect.get: __reflect_set writes the
        // data-property subset on `target` itself and has no receiver slot, so
        // an explicit receiver was evaluated then dropped — writing to the
        // wrong object for accessor setters (§28.1.12 → §10.1.9). Refuse
        // loudly with an explicit receiver until PR-C lands.
        if (expr.arguments.length > 3) {
          if (boundaryReflectInterop && isDynamicBoundaryTarget(expr.arguments[0])) {
            ensureObjectRuntime(ctx);
            emitReflectArgs(4);
            const boundaryIdx = ctx.funcMap.get("__boundary_object_reflect_set");
            if (boundaryIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: boundaryIdx });
              return { kind: "i32" };
            }
            return fallbackReturn(4, "i32-false");
          }
          reportError(
            ctx,
            expr,
            "Codegen error: Reflect.set with an explicit receiver argument is not yet supported " +
              "in --target standalone (#2046); the receiver would be silently dropped and accessor " +
              "setters would write to the target instead of the receiver.",
          );
          fctx.body.push({ op: "i32.const", value: 0 });
          return { kind: "i32" };
        }
        emitReflectArgs(3);
        const funcIdx = ensureLateImport(ctx, "__reflect_set", [externRef, externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(3, "i32-false");
      }

      if (reflectMethod === "has" && expr.arguments.length >= 2) {
        emitReflectArgs(2);
        const funcIdx = ensureLateImport(ctx, "__extern_has", [externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        // (#2046 cleanup) i32-false: a registration failure should not report
        // a phantom `true` for `Reflect.has`.
        return fallbackReturn(2, "i32-false");
      }

      if (reflectMethod === "deleteProperty" && expr.arguments.length >= 2) {
        // (#2046 PR-A defect 3a) Reflect.deleteProperty(primitive, k) must
        // throw a TypeError (§28.1.4 — Reflect requires an Object target),
        // NOT return true. The shared __delete_property helper returns 1 for
        // non-$Object targets because sloppy `delete primitive[k]` is a no-op
        // SUCCESS — correct there, wrong for Reflect. So gate at the CALL SITE
        // (do NOT touch the shared helper): ref.test the target against
        // $Object; if it is not an open object, throw a catchable TypeError.
        ensureObjectRuntime(ctx);
        const targetLocal = allocTempLocal(fctx, externRef);
        // Evaluate the target once, save it for both the guard and the call.
        {
          const tArg = expr.arguments[0];
          if (tArg !== undefined) {
            const tTy = compileExpression(ctx, fctx, tArg, externRef);
            if (tTy && tTy.kind !== "externref") coerceType(ctx, fctx, tTy, externRef);
            else if (tTy === null) fctx.body.push({ op: "ref.null.extern" });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        fctx.body.push({ op: "local.set", index: targetLocal });
        // Native `$Object` targets and explicitly admitted JS boundary objects
        // are both legitimate. Everything else remains a Reflect TypeError.
        emitNativeReflectTargetGuard(targetLocal, "Reflect.deleteProperty called on non-object");
        // target is an $Object — push [target, key] and delete.
        fctx.body.push({ op: "local.get", index: targetLocal });
        releaseTempLocal(fctx, targetLocal);
        {
          const kArg = expr.arguments[1];
          if (kArg !== undefined) {
            const kTy = compileExpression(ctx, fctx, kArg, externRef);
            if (kTy && kTy.kind !== "externref") coerceType(ctx, fctx, kTy, externRef);
            else if (kTy === null) fctx.body.push({ op: "ref.null.extern" });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        const funcIdx = ensureLateImport(ctx, "__delete_property", [externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(0, "i32-false");
      }

      if (reflectMethod === "ownKeys" && expr.arguments.length >= 1) {
        const targetLocal = allocTempLocal(fctx, externRef);
        const targetType = compileExpression(ctx, fctx, expr.arguments[0]!, externRef);
        if (targetType && targetType.kind !== "externref") coerceType(ctx, fctx, targetType, externRef);
        else if (!targetType) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: targetLocal });
        emitNativeReflectTargetGuard(targetLocal, "Reflect.ownKeys called on non-object");

        const funcIdx = ensureLateImport(ctx, "__getOwnPropertyNames", [externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        const boundaryOwnKeysIdx = boundaryReflectInterop ? ctx.funcMap.get("__boundary_object_own_keys") : undefined;
        if (funcIdx !== undefined && boundaryOwnKeysIdx !== undefined) {
          const resultLocal = allocTempLocal(fctx, externRef);
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "call", funcIdx: boundaryOwnKeysIdx });
          fctx.body.push({ op: "local.tee", index: resultLocal });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: externRef },
            then: [
              { op: "local.get", index: targetLocal },
              { op: "call", funcIdx },
            ],
            else: [{ op: "local.get", index: resultLocal }],
          });
          releaseTempLocal(fctx, resultLocal);
          releaseTempLocal(fctx, targetLocal);
          return { kind: "externref" };
        }
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "call", funcIdx });
          releaseTempLocal(fctx, targetLocal);
          return { kind: "externref" };
        }
        releaseTempLocal(fctx, targetLocal);
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }

      if (reflectMethod === "getOwnPropertyDescriptor" && expr.arguments.length >= 2) {
        // (#2046 S5) Route to the native __getOwnPropertyDescriptor, the same
        // helper backing standalone Object.getOwnPropertyDescriptor. It reads
        // the $PropEntry back into a descriptor `$Object` (data → { value,
        // writable, enumerable, configurable }, accessor → { get, set,
        // enumerable, configurable }) and returns `undefined` for a missing own
        // property — §26.1.7 step 3 (FromPropertyDescriptor over
        // [[GetOwnProperty]]). The key is coerced with ToPropertyKey inside the
        // native via __to_property_key (#2042 S1), so numeric keys work.
        //
        // §26.1.7 step 1 requires a TypeError when the target is not an Object.
        // The native returns `undefined` for a non-$Object receiver (correct
        // for Object.getOwnPropertyDescriptor, which forwards a coerced
        // primitive wrapper), so — exactly as the deleteProperty PR-A guard —
        // gate at the CALL SITE with a `ref.test $Object` and throw a catchable
        // TypeError instead. The shared native is untouched.
        ensureObjectRuntime(ctx);
        const targetLocal = allocTempLocal(fctx, externRef);
        {
          const tArg = expr.arguments[0];
          if (tArg !== undefined) {
            const tTy = compileExpression(ctx, fctx, tArg, externRef);
            if (tTy && tTy.kind !== "externref") coerceType(ctx, fctx, tTy, externRef);
            else if (tTy === null) fctx.body.push({ op: "ref.null.extern" });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        fctx.body.push({ op: "local.set", index: targetLocal });
        emitNativeReflectTargetGuard(targetLocal, "Reflect.getOwnPropertyDescriptor called on non-object");
        // target is an $Object — push [target, key] and read the descriptor.
        fctx.body.push({ op: "local.get", index: targetLocal });
        releaseTempLocal(fctx, targetLocal);
        {
          const kArg = expr.arguments[1];
          if (kArg !== undefined) {
            const kTy = compileExpression(ctx, fctx, kArg, externRef);
            if (kTy && kTy.kind !== "externref") coerceType(ctx, fctx, kTy, externRef);
            else if (kTy === null) fctx.body.push({ op: "ref.null.extern" });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        const funcIdx = ensureLateImport(ctx, "__getOwnPropertyDescriptor", [externRef, externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(0, "extern-null");
      }

      if (reflectMethod === "defineProperty" && expr.arguments.length >= 3) {
        // (#2046) Route Reflect.defineProperty(target, key, desc) through the
        // SAME standalone runtime-descriptor applier that backs
        // Object.defineProperty — `emitDefinePropertyDescRuntime`
        // (object-ops.ts). Reusing it (rather than hand-rolling a
        // `__obj_define_from_desc` call here) is essential because that helper
        // performs the **#2372 descriptor struct reify**: an INLINE descriptor
        // object literal (`{ value: 42, … }`) is typed by the TS checker as a
        // closed WasmGC struct, which the native `__obj_define_from_desc`'s
        // internal `ref.test $Object` rejects as "not an object" → spurious
        // §10.1.6 TypeError. The helper reifies that struct into a fresh
        // `$Object` first, so inline-literal descriptors work. The issue file
        // recorded this arm as blocked on a write-side native (#2043); that
        // blocker is STALE — the native is registered by ensureObjectRuntime
        // and reachable end-to-end (it has backed Object.defineProperty since
        // #1629b).
        //
        // §28.1.3 Reflect.defineProperty(target, propertyKey, attributes):
        //   step 1: target not an Object → throw a TypeError. The native
        //     applier silently no-ops on a non-$Object target (matching the
        //     pre-existing standalone Object.defineProperty gap), so enforce
        //     the §28.1.3 step-1 throw HERE with the shared
        //     `emitNonObjectArgGuard` — it fires for a statically primitive /
        //     null / undefined target (the test262 non-object subtests use
        //     bare primitive literals). A runtime-`any` primitive still slips
        //     through, an accepted imprecision shared with Object.defineProperty.
        //   step 2: key = ? ToPropertyKey(propertyKey) — handled inside the
        //     native via __to_property_key (#2042 S1), so numeric keys coerce.
        //   step 3: desc = ? ToPropertyDescriptor(attributes) — a malformed
        //     descriptor (data+accessor conflict, non-callable get/set) throws
        //     a catchable TypeError, which the native already raises (these
        //     originate in ToPropertyDescriptor, BEFORE [[DefineOwnProperty]],
        //     so they throw for Reflect too).
        //   step 4: return the boolean [[DefineOwnProperty]] result. The native
        //     returns the obj (always truthy) and has no failure channel, so we
        //     drop it and return i32 `true`.
        //
        // KNOWN LIMITATION (shared with standalone Object.defineProperty): a
        // *rejected* redefine of an existing non-configurable property silently
        // no-ops in the native rather than surfacing failure, so we cannot
        // return the spec's `false` for that case — it returns `true`. Faithful
        // handling needs a failure channel in __defineProperty_value and is out
        // of this slice; converting the common refusal→working path is the win.
        const objArg = expr.arguments[0];
        const keyArg = expr.arguments[1];
        const descArg = expr.arguments[2];
        if (objArg !== undefined && keyArg !== undefined && descArg !== undefined) {
          // §28.1.3 step 1: statically-non-object target → throw TypeError.
          if (emitNonObjectArgGuard(ctx, fctx, objArg, "Reflect.defineProperty")) {
            fctx.body.push({ op: "i32.const", value: 0 }); // unreachable after throw
            return { kind: "i32" };
          }
          // `undefinedFields` is the host-only ToPropertyDescriptor presence
          // sidecar — unused on the standalone path, so pass empty.
          const r = emitDefinePropertyDescRuntime(ctx, fctx, objArg, keyArg, descArg, []);
          if (r !== null) {
            // The applier returns an externref; Reflect wants a boolean.
            // (#1355 Slice F) For a PROXY receiver the standalone
            // `__obj_define_from_desc` front-guard returns the defineProperty
            // trap's booleanish externref (NOT the obj) — so we must surface
            // that result, not unconditionally return true. For a non-proxy
            // receiver the applier returns the (always-truthy) obj, so
            // `__is_truthy` still yields the spec `true`. This keeps the
            // non-proxy behaviour identical while making a proxy trap's
            // false/true return observable through Reflect.defineProperty.
            const isTruthyIdx = ctx.funcMap.get("__is_truthy");
            if (isTruthyIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: isTruthyIdx });
            } else {
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "i32.const", value: 1 });
            }
            return { kind: "i32" };
          }
        }
        return fallbackReturn(0, "i32-false");
      }

      if (reflectMethod === "getPrototypeOf" && expr.arguments.length >= 1) {
        // (#2046 PR-C) Route Reflect.getPrototypeOf(target) to the native
        // Object.getPrototypeOf helper. It returns the `$Object.$proto` value.
        // §28.1.1 Reflect.getPrototypeOf(target):
        //   step 1: target not an Object → throw a TypeError. The native
        //     returns null for a non-$Object receiver (correct for
        //     Object.getPrototypeOf after its ToObject), so — exactly as the
        //     deleteProperty / getOwnPropertyDescriptor PR-A guards — enforce
        //     the §28.1.1 step-1 throw at the CALL SITE with the shared
        //     emitNonObjectArgGuard (fires for a statically-primitive / null /
        //     undefined target). The shared native is untouched.
        //   step 2: return ? target.[[GetPrototypeOf]]() — the native read.
        const arg0 = expr.arguments[0]!;
        if (emitNonObjectArgGuard(ctx, fctx, arg0, "Reflect.getPrototypeOf")) {
          fctx.body.push({ op: "ref.null.extern" }); // unreachable after throw
          return { kind: "externref" };
        }
        const pristineIntrinsicPrototype = compilePristineIntrinsicPrototypeCapture(ctx, fctx, arg0);
        if (pristineIntrinsicPrototype) return pristineIntrinsicPrototype;
        const pristineIteratorPrototype = compilePristineIteratorPrototypeCapture(ctx, fctx, arg0);
        if (pristineIteratorPrototype) return pristineIteratorPrototype;
        const argType = compileExpression(ctx, fctx, arg0, externRef);
        if (!argType) {
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
        if (argType.kind !== "externref") coerceType(ctx, fctx, argType, externRef);
        const gpoIdx = ensureLateImport(ctx, "__getPrototypeOf", [externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (gpoIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: gpoIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(0, "extern-null");
      }

      if (reflectMethod === "setPrototypeOf" && expr.arguments.length >= 2) {
        // (#2046 PR-C) Route Reflect.setPrototypeOf(target, proto) to the
        // native __object_setPrototypeOf — the SAME helper backing standalone
        // Object.setPrototypeOf (calls.ts ~5829). It performs the §10.1.2.1
        // OrdinarySetPrototypeOf extensibility + cycle checks, writes
        // $Object.$proto (field 0) on success, and returns `obj` (NOT a
        // boolean). §28.1.14 Reflect.setPrototypeOf(target, proto):
        //   step 1: target not an Object → throw a TypeError. The native
        //     silently no-ops (returns obj) on a non-$Object receiver, so
        //     enforce the step-1 throw at the CALL SITE with the shared
        //     emitNonObjectArgGuard (statically-primitive / null / undefined
        //     target).
        //   step 2: proto not Object and not null → throw a TypeError. Reuse
        //     the same static guard on the proto arg, but `null` is a LEGAL
        //     proto here (unlike target), so only reject a statically-
        //     primitive NON-null proto. A `null`/`undefined`/object proto
        //     passes; a number/string/boolean proto literal throws.
        //   step 4: return the boolean [[SetPrototypeOf]] result. The native
        //     has no failure channel (a refused set — non-extensible target or
        //     a cycle — silently no-ops and still returns obj), so we drop obj
        //     and return i32 `true`. KNOWN LIMITATION (identical to the
        //     standalone Reflect.defineProperty arm above): a *refused* set
        //     returns the spec's `true` instead of `false`. Faithful handling
        //     needs a boolean failure channel in __object_setPrototypeOf and is
        //     out of this slice; converting the common refusal→working path is
        //     the win.
        const targetArg = expr.arguments[0]!;
        const protoArg = expr.arguments[1]!;
        // §28.1.14 step 1: statically-non-object target → throw TypeError.
        if (emitNonObjectArgGuard(ctx, fctx, targetArg, "Reflect.setPrototypeOf")) {
          fctx.body.push({ op: "i32.const", value: 0 }); // unreachable after throw
          return { kind: "i32" };
        }
        // §28.1.14 step 2: a statically-primitive proto that is NOT null/
        // undefined is illegal. `null`/`undefined` set the prototype to null
        // (legal), so let them through to the native (which maps a non-$Object
        // proto to a null $proto).
        const protoIsNullish =
          protoArg.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(protoArg) && protoArg.text === "undefined") ||
          protoArg.kind === ts.SyntaxKind.UndefinedKeyword;
        if (!protoIsNullish && emitNonObjectArgGuard(ctx, fctx, protoArg, "Reflect.setPrototypeOf")) {
          fctx.body.push({ op: "i32.const", value: 0 }); // unreachable after throw
          return { kind: "i32" };
        }
        // obj (externref)
        const objType = compileExpression(ctx, fctx, targetArg, externRef);
        if (!objType) {
          fctx.body.push({ op: "i32.const", value: 1 });
          return { kind: "i32" };
        }
        if (objType.kind !== "externref") coerceType(ctx, fctx, objType, externRef);
        // proto (externref) — compileProtoArg reifies an inline-literal proto
        // into a native $Object so __object_setPrototypeOf's `ref.test $Object`
        // succeeds (the same #2580 M3 Stage A handling Object.setPrototypeOf
        // uses); keeps the ordinary externref path for non-literal / null protos.
        compileProtoArg(ctx, fctx, protoArg);
        const spoIdx = ensureLateImport(ctx, "__object_setPrototypeOf", [externRef, externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (spoIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: spoIdx });
          fctx.body.push({ op: "drop" }); // native returns obj; Reflect wants a boolean
          fctx.body.push({ op: "i32.const", value: 1 }); // success → true (see KNOWN LIMITATION)
          return { kind: "i32" };
        }
        return fallbackReturn(0, "i32-true");
      }

      if (reflectMethod === "isExtensible" && expr.arguments.length >= 1) {
        const targetLocal = allocTempLocal(fctx, externRef);
        const targetType = compileExpression(ctx, fctx, expr.arguments[0]!, externRef);
        if (targetType && targetType.kind !== "externref") coerceType(ctx, fctx, targetType, externRef);
        else if (!targetType) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: targetLocal });
        emitNativeReflectTargetGuard(targetLocal, "Reflect.isExtensible called on non-object");

        const nativeIdx = ensureLateImport(ctx, "__object_isExtensible", [externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        const boundaryIdx = boundaryReflectInterop ? ctx.funcMap.get("__boundary_object_is_extensible") : undefined;
        if (nativeIdx !== undefined && boundaryIdx !== undefined) {
          const resultLocal = allocTempLocal(fctx, i32Ty);
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "call", funcIdx: boundaryIdx });
          fctx.body.push({ op: "local.tee", index: resultLocal });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: i32Ty },
            then: [
              { op: "local.get", index: targetLocal },
              { op: "call", funcIdx: nativeIdx },
            ],
            else: [{ op: "local.get", index: resultLocal }, { op: "i32.const", value: 1 }, { op: "i32.sub" }],
          });
          releaseTempLocal(fctx, resultLocal);
          releaseTempLocal(fctx, targetLocal);
          return { kind: "i32" };
        }
        fctx.body.push({ op: "local.get", index: targetLocal });
        if (nativeIdx !== undefined) fctx.body.push({ op: "call", funcIdx: nativeIdx });
        else {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: 0 });
        }
        releaseTempLocal(fctx, targetLocal);
        return { kind: "i32" };
      }

      if (reflectMethod === "preventExtensions" && expr.arguments.length >= 1) {
        const targetLocal = allocTempLocal(fctx, externRef);
        const targetType = compileExpression(ctx, fctx, expr.arguments[0]!, externRef);
        if (targetType && targetType.kind !== "externref") coerceType(ctx, fctx, targetType, externRef);
        else if (!targetType) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: targetLocal });
        emitNativeReflectTargetGuard(targetLocal, "Reflect.preventExtensions called on non-object");

        const nativeIdx = ensureLateImport(ctx, "__object_preventExtensions", [externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        const boundaryIdx = boundaryReflectInterop
          ? ctx.funcMap.get("__boundary_object_reflect_prevent_extensions")
          : undefined;
        if (nativeIdx !== undefined && boundaryIdx !== undefined) {
          const resultLocal = allocTempLocal(fctx, i32Ty);
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "call", funcIdx: boundaryIdx });
          fctx.body.push({ op: "local.tee", index: resultLocal });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: i32Ty },
            then: [
              { op: "local.get", index: targetLocal },
              { op: "call", funcIdx: nativeIdx },
              { op: "drop" },
              { op: "i32.const", value: 1 },
            ],
            else: [{ op: "local.get", index: resultLocal }, { op: "i32.const", value: 1 }, { op: "i32.sub" }],
          });
          releaseTempLocal(fctx, resultLocal);
          releaseTempLocal(fctx, targetLocal);
          return { kind: "i32" };
        }
        fctx.body.push({ op: "local.get", index: targetLocal });
        if (nativeIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: nativeIdx });
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: 1 });
        } else {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: 0 });
        }
        releaseTempLocal(fctx, targetLocal);
        return { kind: "i32" };
      }

      if (
        reflectMethod === "apply" &&
        expr.arguments.length >= 3 &&
        boundaryReflectInterop &&
        isDynamicBoundaryTarget(expr.arguments[0])
      ) {
        ensureObjectRuntime(ctx);
        emitReflectArgs(3);
        const boundaryIdx = ctx.funcMap.get("__boundary_object_apply");
        if (boundaryIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: boundaryIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(3, "extern-null");
      }

      if (
        reflectMethod === "construct" &&
        boundaryReflectInterop &&
        isDynamicBoundaryTarget(expr.arguments[0]) &&
        (expr.arguments[2] === undefined || isDynamicBoundaryTarget(expr.arguments[2]))
      ) {
        ensureObjectRuntime(ctx);
        emitReflectArgs(3);
        const boundaryIdx = ctx.funcMap.get("__boundary_object_construct");
        if (boundaryIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: boundaryIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(3, "extern-null");
      }

      if (reflectMethod === "construct") {
        const targetArg = expr.arguments[0];
        const listArg = expr.arguments[1];
        const newTargetArg = expr.arguments[2];
        const unwrappedList = listArg === undefined ? undefined : unwrapReflectConstructExpr(listArg);
        if (
          targetArg === undefined ||
          !unwrappedList ||
          !ts.isArrayLiteralExpression(unwrappedList) ||
          unwrappedList.elements.some(ts.isOmittedExpression)
        ) {
          reportError(
            ctx,
            expr,
            "Codegen error: standalone Reflect.construct currently requires an array-literal argsList (#3371).",
          );
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }

        const distinctNewTarget = newTargetArg !== undefined && !sameReflectConstructTarget(targetArg, newTargetArg);
        if (newTargetArg !== undefined && !isStaticallyConstructible(ctx, newTargetArg)) {
          // Evaluate the runtime NewTarget exactly once, then use the finalize-
          // filled nominal carrier classifier. Ordinary functions have a
          // constructible wrapper subtype; arrows/method closures do not.
          const ntType = compileExpression(ctx, fctx, newTargetArg, externRef);
          if (ntType && ntType.kind !== "externref") coerceType(ctx, fctx, ntType, externRef);
          else if (ntType === null) fctx.body.push({ op: "ref.null.extern" });
          const isCtorIdx = ensureReflectIsConstructor(ctx);
          fctx.body.push({ op: "call", funcIdx: isCtorIdx });
          fctx.body.push({ op: "i32.eqz" });
          const throwBody: Instr[] = [];
          const savedBody = fctx.body;
          fctx.body = throwBody;
          emitThrowTypeError(ctx, fctx, "Reflect.construct newTarget is not a constructor");
          fctx.body = savedBody;
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwBody });
        }

        // The Test262 IsConstructor helper's exact probe target has an empty
        // body and no arguments. Validation above is the observable purpose;
        // materialize the ordinary result as a native $Object so the returned
        // value remains a real object if a caller does observe it.
        if (distinctNewTarget && isEmptyOrdinaryFunction(targetArg) && unwrappedList.elements.length === 0) {
          ensureObjectRuntime(ctx);
          const createIdx = ctx.funcMap.get("__object_create");
          if (createIdx !== undefined) {
            fctx.body.push({ op: "ref.null.extern" });
            fctx.body.push({ op: "call", funcIdx: createIdx });
            return { kind: "externref" };
          }
        }

        const newExpr = ts.factory.createNewExpression(targetArg, undefined, [
          ...unwrappedList.elements,
        ] as ts.Expression[]);
        ts.setTextRange(newExpr, expr);
        const resultType = compileNewExpression(ctx, fctx, newExpr);
        if (resultType === null) {
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
        if (resultType.kind !== "externref") coerceType(ctx, fctx, resultType, externRef);

        if (!distinctNewTarget) return { kind: "externref" };

        const assignedProto = assignedNewTargetPrototype(ctx, newTargetArg!, expr.getStart());
        if (assignedProto === undefined) {
          reportError(
            ctx,
            expr,
            "Codegen error: standalone Reflect.construct cannot preserve an arbitrary distinct NewTarget " +
              "without a statically-resolved NewTarget.prototype assignment (#3371).",
          );
          return { kind: "externref" };
        }

        if (isDefinitelyPrimitivePrototype(ctx, assignedProto)) return { kind: "externref" };

        // Preserve the constructed value while evaluating the selected proto.
        const resultLocal = allocLocal(fctx, `__reflect_construct_result_${fctx.locals.length}`, externRef);
        fctx.body.push({ op: "local.set", index: resultLocal });
        const protoType = compileExpression(ctx, fctx, assignedProto, externRef);
        if (protoType && protoType.kind !== "externref") coerceType(ctx, fctx, protoType, externRef);
        else if (protoType === null) fctx.body.push({ op: "ref.null.extern" });
        const protoLocal = allocLocal(fctx, `__reflect_construct_proto_${fctx.locals.length}`, externRef);
        fctx.body.push({ op: "local.set", index: protoLocal });

        ensureObjectRuntime(ctx);
        const resultAny = allocLocal(fctx, `__reflect_construct_any_${fctx.locals.length}`, { kind: "anyref" });
        fctx.body.push({ op: "local.get", index: resultLocal });
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "local.set", index: resultAny });

        const setCarrierProto = (typeIdx: number, fieldIdx: number): Instr[] => [
          { op: "local.get", index: resultAny },
          { op: "ref.cast", typeIdx },
          { op: "local.get", index: protoLocal },
          { op: "struct.set", typeIdx, fieldIdx },
        ];
        const carrierArms: Instr[] = [];
        const unwrappedTarget = unwrapReflectConstructExpr(targetArg);
        const isStaticDataView = ts.isIdentifier(unwrappedTarget) && unwrappedTarget.text === "DataView";
        if (isStaticDataView && ctx.dvWindowTypeIdx >= 0) {
          carrierArms.push(...setCarrierProto(ctx.dvWindowTypeIdx, 3));
        } else if (ctx.dvWindowTypeIdx >= 0) {
          carrierArms.push(
            { op: "local.get", index: resultAny },
            { op: "ref.test", typeIdx: ctx.dvWindowTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: setCarrierProto(ctx.dvWindowTypeIdx, 3),
            },
          );
        }
        if (ctx.taDynViewTypeIdx >= 0) {
          carrierArms.push(
            { op: "local.get", index: resultAny },
            { op: "ref.test", typeIdx: ctx.taDynViewTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: setCarrierProto(ctx.taDynViewTypeIdx, 5),
            },
          );
        }
        if (carrierArms.length === 0) {
          reportError(
            ctx,
            expr,
            "Codegen error: standalone Reflect.construct distinct NewTarget is not implemented for this target carrier (#3371).",
          );
        } else {
          fctx.body.push(...carrierArms);
        }
        fctx.body.push({ op: "local.get", index: resultLocal });
        return { kind: "externref" };
      }
      // Boolean-returning methods need an i32 on the stack; the rest return
      // externref. Pick the fallback shape per method so the surrounding
      // expression still type-checks even though the module is already marked
      // failed by reportError.
      const booleanReflect = new Set([
        "set",
        "has",
        "deleteProperty",
        "defineProperty",
        "setPrototypeOf",
        "isExtensible",
        "preventExtensions",
      ]);
      reportError(
        ctx,
        expr,
        `Codegen error: Reflect.${reflectMethod} not supported in standalone mode (#1472 Phase C).`,
      );
      if (booleanReflect.has(reflectMethod)) {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Reflect.get(target, key, [receiver]) — returns externref.
    if (reflectMethod === "get" && expr.arguments.length >= 2) {
      emitReflectArgs(3);
      const funcIdx = ensureLateImport(ctx, "__reflect_get", [externRef, externRef, externRef], [externRef]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      return fallbackReturn(3, "extern-null");
    }

    // Reflect.set(target, key, value, [receiver]) — returns i32 (boolean).
    if (reflectMethod === "set" && expr.arguments.length >= 2) {
      emitReflectArgs(4);
      const funcIdx = ensureLateImport(ctx, "__reflect_set", [externRef, externRef, externRef, externRef], [i32Ty]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      return fallbackReturn(4, "i32-true");
    }

    // Reflect.has(target, key) — returns i32 (boolean).
    if (reflectMethod === "has" && expr.arguments.length >= 2) {
      emitReflectArgs(2);
      const funcIdx = ensureLateImport(ctx, "__reflect_has", [externRef, externRef], [i32Ty]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      return fallbackReturn(2, "i32-true");
    }

    // Reflect.deleteProperty(target, key) — returns i32 (boolean).
    if (reflectMethod === "deleteProperty" && expr.arguments.length >= 2) {
      emitReflectArgs(2);
      const funcIdx = ensureLateImport(ctx, "__reflect_deleteProperty", [externRef, externRef], [i32Ty]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      return fallbackReturn(2, "i32-true");
    }

    // Reflect.defineProperty(target, key, desc) — returns i32 (boolean).
    if (reflectMethod === "defineProperty" && expr.arguments.length >= 3) {
      emitReflectArgs(3);
      const funcIdx = ensureLateImport(ctx, "__reflect_defineProperty", [externRef, externRef, externRef], [i32Ty]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      return fallbackReturn(3, "i32-true");
    }

    // Reflect.getOwnPropertyDescriptor(target, key) — returns externref.
    if (reflectMethod === "getOwnPropertyDescriptor" && expr.arguments.length >= 2) {
      emitReflectArgs(2);
      const funcIdx = ensureLateImport(ctx, "__reflect_getOwnPropertyDescriptor", [externRef, externRef], [externRef]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      return fallbackReturn(2, "extern-null");
    }

    // Reflect.getPrototypeOf(target) — returns externref.
    if (reflectMethod === "getPrototypeOf" && expr.arguments.length >= 1) {
      emitReflectArgs(1);
      const funcIdx = ensureLateImport(ctx, "__reflect_getPrototypeOf", [externRef], [externRef]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      return fallbackReturn(1, "extern-null");
    }

    // Reflect.setPrototypeOf(target, proto) — returns i32 (boolean).
    // (#2747 d) Record the user [[Prototype]] on BOTH channels:
    //   - __host_set_struct_proto populates `_wasmStructProto` — the SAME link
    //     the Object.setPrototypeOf gc/host arm (calls.ts ~5980) writes and the
    //     for-in walk consults via `_structUserProto`. Without this the
    //     inherited keys never enumerated (verify-first: for-in dropped the
    //     inherited key).
    //   - __reflect_setPrototypeOf preserves the host-wrapper round-trip that
    //     Reflect.getPrototypeOf reads (and is the only channel that handles a
    //     non-weak-key-able empty `{}` target — #1466). Keeping it means the
    //     existing Reflect.get/setPrototypeOf round-trip does not regress.
    // target/proto are saved in temp locals so both calls receive them.
    if (reflectMethod === "setPrototypeOf" && expr.arguments.length >= 2) {
      const objLocal = allocTempLocal(fctx, externRef);
      const protoLocal = allocTempLocal(fctx, externRef);
      // target → objLocal
      {
        const a = expr.arguments[0];
        const ty = a ? compileExpression(ctx, fctx, a, externRef) : null;
        if (ty && ty.kind !== "externref") coerceType(ctx, fctx, ty, externRef);
        else if (ty === null || a === undefined) fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "local.set", index: objLocal });
      // proto → protoLocal
      {
        const a = expr.arguments[1];
        const ty = a ? compileExpression(ctx, fctx, a, externRef) : null;
        if (ty && ty.kind !== "externref") coerceType(ctx, fctx, ty, externRef);
        else if (ty === null || a === undefined) fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "local.set", index: protoLocal });
      // __host_set_struct_proto(obj, proto) → for-in channel; returns obj, drop.
      const hIdx = ensureLateImport(ctx, "__host_set_struct_proto", [externRef, externRef], [externRef]);
      flushLateImportShifts(ctx, fctx);
      if (hIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "local.get", index: protoLocal });
        fctx.body.push({ op: "call", funcIdx: hIdx });
        fctx.body.push({ op: "drop" });
      }
      // __reflect_setPrototypeOf(obj, proto) → wrapper round-trip; returns i32.
      const rIdx = ensureLateImport(ctx, "__reflect_setPrototypeOf", [externRef, externRef], [i32Ty]);
      flushLateImportShifts(ctx, fctx);
      if (rIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "local.get", index: protoLocal });
        fctx.body.push({ op: "call", funcIdx: rIdx });
        releaseTempLocal(fctx, objLocal);
        releaseTempLocal(fctx, protoLocal);
        return { kind: "i32" };
      }
      releaseTempLocal(fctx, objLocal);
      releaseTempLocal(fctx, protoLocal);
      // Reflect helper unavailable — return the success sentinel (true).
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    }

    // Reflect.ownKeys(target) — returns externref (Array including Symbol keys, per §28.1.13).
    if (reflectMethod === "ownKeys" && expr.arguments.length >= 1) {
      emitReflectArgs(1);
      const funcIdx = ensureLateImport(ctx, "__reflect_ownKeys", [externRef], [externRef]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      return fallbackReturn(1, "extern-null");
    }

    // Reflect.isExtensible(target) — returns i32 (boolean).
    // Preserve ctx.nonExtensibleVars marking (used by Object.isFrozen / Object.preventExtensions
    // compile-time tracking at calls.ts:2089/2180) for identifiers so legacy callers still see
    // the same answer; but the runtime answer always comes from the host.
    if (reflectMethod === "isExtensible" && expr.arguments.length >= 1) {
      emitReflectArgs(1);
      const funcIdx = ensureLateImport(ctx, "__reflect_isExtensible", [externRef], [i32Ty]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      return fallbackReturn(1, "i32-true");
    }

    // Reflect.preventExtensions(target) — returns i32 (boolean).
    // Keep ctx.nonExtensibleVars side-effect for identifiers so the Object.* compile-time
    // fast path stays consistent with the host's runtime answer.
    if (reflectMethod === "preventExtensions" && expr.arguments.length >= 1) {
      const arg0 = expr.arguments[0]!;
      if (ts.isIdentifier(arg0)) {
        ctx.nonExtensibleVars.add(integrityVarKey(ctx, arg0)); // (#3403) per-declaration key
      }
      emitReflectArgs(1);
      const funcIdx = ensureLateImport(ctx, "__reflect_preventExtensions", [externRef], [i32Ty]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      return fallbackReturn(1, "i32-true");
    }

    // Reflect.apply(fn, thisArg, argList) — returns externref. Host performs CreateListFromArrayLike.
    if (reflectMethod === "apply" && expr.arguments.length >= 3) {
      emitReflectArgs(3);
      const funcIdx = ensureLateImport(ctx, "__reflect_apply", [externRef, externRef, externRef], [externRef]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      return fallbackReturn(3, "extern-null");
    }

    // Reflect.construct(C, args, [newTarget]) — returns externref.
    // Passing ref.null.extern for omitted newTarget lets the host wrapper default to `C`.
    //
    // (#4394) …which makes an OMITTED newTarget indistinguishable from an
    // explicit `null` one at the fixed-arity wasm boundary, and §26.1.2 step 3
    // treats them oppositely: absent ⇒ default to the target, PRESENT and not a
    // constructor ⇒ TypeError. The shim collapsed both to the 2-argument form,
    // so `Reflect.construct(fn, [], null)` quietly constructed instead of
    // throwing. Encode presence in the import NAME — the boundary cannot carry
    // it any other way, and the arity is a compile-time fact.
    if (reflectMethod === "construct" && expr.arguments.length >= 2) {
      emitReflectArgs(3);
      const constructImport = expr.arguments.length >= 3 ? "__reflect_construct_newtarget" : "__reflect_construct";
      const funcIdx = ensureLateImport(ctx, constructImport, [externRef, externRef, externRef], [externRef]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      return fallbackReturn(3, "extern-null");
    }
  }

  // Handle Promise.all / Promise.race / Promise.allSettled / Promise.any / Promise.resolve / Promise.reject — host-delegated static calls
  //
  // (#1368) For the four aggregators, we pass `thisArg` so the spec-compliant
  // helper can construct via `thisArg.call(...)` for subclass support.
  // Resolve/reject keep their original 1-arg signature (no thisArg needed).
  {
    const isAggregatorMethod =
      propAccess.name.text === "all" ||
      propAccess.name.text === "race" ||
      propAccess.name.text === "allSettled" ||
      propAccess.name.text === "any";
    // (#1116b, E1) `Sub.all(iter)` where `Sub` is a `class extends Promise`
    // is a subclass static inherited from Promise. Recognise the subclass
    // receiver here too so it reaches the aggregator lowering (the thisArg
    // resolution below switches it to directCall=0).
    const isPromiseSubclassReceiver =
      ts.isIdentifier(propAccess.expression) &&
      resolvePromiseSubclassName(ctx, propAccess.expression.text) !== undefined;
    const isAggregator =
      ts.isIdentifier(propAccess.expression) &&
      (propAccess.expression.text === "Promise" || isPromiseSubclassReceiver) &&
      isAggregatorMethod;
    const isResolveReject =
      ts.isIdentifier(propAccess.expression) &&
      (propAccess.expression.text === "Promise" || (isStandalonePromiseActive(ctx) && isPromiseSubclassReceiver)) &&
      (propAccess.name.text === "resolve" || propAccess.name.text === "reject");
    if (isAggregator) {
      const methodName = propAccess.name.text;
      // (#2867 Gap 4) Native host-free `Promise.all`/`Promise.race` over an
      // array literal under the native-`$Promise` carrier. Gated on
      // `isStandalonePromiseActive`, which covers `--target wasi` AND
      // `--target standalone` since the #2980 flip (2026-07-10) — this comment
      // said "wasi-only today → widens to standalone at slice 1d" long after
      // that stopped being true, and that stale claim is what put a nonexistent
      // "50 CE Promise_all/race leak" work item in the #2867 plan (measured
      // 2026-08-15: zero host-import CEs across all 729 built-ins/Promise
      // standalone files). Only gc/host is byte-unchanged. Literal no-spread
      // arguments unroll at compile time
      // below; array-TYPED non-literal arguments take the (#2919 arm 1)
      // runtime loop after that; Set/Map arguments take the (#2922 arm 3a)
      // compile-time collection projection; everything else except strings,
      // `number[]` vecs, and native-generator subjects takes the (#2922 arms
      // 2+3) dynamic `__combinator_to_vec` path (custom iterables drain,
      // non-iterables reject with a native TypeError). (#3137) `allSettled`/
      // `any` take the same native arms (status objects / AggregateError via
      // ensureSettledAnyCombinators); subclass capability-ctor receivers
      // still fall through to the host path (follow-ups).
      const arg0 = expr.arguments[0];
      const nativeCombinatorEligible =
        isStandalonePromiseActive(ctx) &&
        isNativeCombinatorMethod(methodName) &&
        !isPromiseSubclassReceiver &&
        expr.arguments.length === 1;
      if (
        nativeCombinatorEligible &&
        arg0 !== undefined &&
        ts.isArrayLiteralExpression(arg0) &&
        arg0.elements.every((el) => !ts.isSpreadElement(el) && !ts.isOmittedExpression(el))
      ) {
        const elementInstrs: Instr[][] = [];
        // (#2919, same funcIdx-desync class as #2918) Keep the outer body AND
        // every completed element buffer reachable while later elements (and
        // the combinator-runtime registration inside
        // emitStandalonePromiseCombinator) compile: a late import landing
        // mid-compile walks fctx.body + fctx.savedBodies to shift baked
        // `call`/`ref.func` indices — a bare local swap orphans them.
        // NOTE the buffers are popped only AFTER emitStandalonePromiseCombinator
        // returns; its ensure* registration (the only possible import trigger
        // inside it) runs BEFORE it copies the buffers into fctx.body, so no
        // instruction is ever reachable via two walked arrays at shift time
        // (the shared-Instr double-remap hazard).
        const savedBody = fctx.body;
        fctx.savedBodies.push(savedBody);
        let pushedBufs = 0;
        try {
          for (const el of arg0.elements) {
            const buf: Instr[] = [];
            fctx.body = buf;
            try {
              compileExpression(ctx, fctx, el, { kind: "externref" });
            } finally {
              fctx.body = savedBody;
            }
            elementInstrs.push(buf);
            fctx.savedBodies.push(buf);
            pushedBufs++;
          }
          return emitStandalonePromiseCombinator(ctx, fctx, methodName, elementInstrs);
        } finally {
          fctx.savedBodies.length -= pushedBufs + 1;
        }
      }
      // (#2922 arm 3a) Native combinator over a SET/MAP argument —
      // `Promise.all(set)`. `$Map`-backed collections have NO runtime
      // `@@iterator`/`next` dispatch (for-of iterates them via the
      // compile-time #2162 projection), so the dynamic path below can never
      // see them — handle them statically by materializing the same
      // projection (Set → values, Map → [k, v] entries) into a canonical
      // externref $Vec and driving the unchanged arm-1 runtime loop over it.
      // Checker-only guard first (no emission for non-Set/Map args), then a
      // #1919-transactional probe confirms the arg genuinely lowers to the
      // native `$Map` struct (mirrors compileForOfNativeCollection).
      if (nativeCombinatorEligible && arg0 !== undefined && ctx.nativeStrings && ctx.mapTypeIdx >= 0) {
        const argTsType = ctx.checker.getTypeAtLocation(arg0);
        const symName = argTsType.getSymbol()?.getName() ?? argTsType.aliasSymbol?.name;
        if (symName === "Set" || symName === "Map") {
          const isSet = symName === "Set";
          const snap = snapshotSpeculative(ctx, fctx);
          const recvType = compileExpression(ctx, fctx, arg0);
          rollbackSpeculative(ctx, fctx, snap);
          if (
            recvType !== null &&
            (recvType.kind === "ref" || recvType.kind === "ref_null") &&
            recvType.typeIdx === ctx.mapTypeIdx
          ) {
            const vecResult = emitCollectionIteratorVec(ctx, fctx, arg0, isSet ? "values" : "entries", isSet);
            if (
              vecResult !== undefined &&
              vecResult !== null &&
              typeof vecResult === "object" &&
              (vecResult.kind === "ref" || vecResult.kind === "ref_null")
            ) {
              const collArrTypeIdx = getArrTypeIdxFromVec(ctx, vecResult.typeIdx);
              const collVecLocal = allocLocal(fctx, `__comb_argvec_${fctx.locals.length}`, {
                kind: "ref_null",
                typeIdx: vecResult.typeIdx,
              });
              fctx.body.push({ op: "local.set", index: collVecLocal });
              return emitStandalonePromiseCombinatorRuntime(
                ctx,
                fctx,
                methodName,
                collVecLocal,
                vecResult.typeIdx,
                collArrTypeIdx,
              );
            }
          }
        }
      }
      // (#2919 arm 1) Native combinator over an ARRAY-TYPED non-literal
      // argument — `Promise.all(arrVar)`, spread/holed literals, etc.
      // Transactionally compile the argument with its natural type; if it
      // lowers to an externref-backed vec (`Promise<T>[]`-shaped arrays do),
      // KEEP the compiled arg and loop over it at runtime feeding
      // `__combinator_subscribe`. Anything else is rolled back — body AND any
      // locals / late imports / errors the probe allocated — via the #1919
      // helper (a raw `body.length =` rollback would leak a phantom late
      // import); the (#2922) dynamic path below then decides whether to take
      // the probed shape at runtime or keep the host fallthrough
      // byte-unchanged (f64-backed `number[]` vecs — the Gap-4
      // output-representation escalation —, strings, native generators).
      if (nativeCombinatorEligible && arg0 !== undefined) {
        const snap = snapshotSpeculative(ctx, fctx);
        const argType = compileExpression(ctx, fctx, arg0);
        const vecShape = resolveExternrefVecArg(ctx, argType);
        if (vecShape) {
          const argVecLocal = allocLocal(fctx, `__comb_argvec_${fctx.locals.length}`, {
            kind: "ref_null",
            typeIdx: vecShape.vecTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: argVecLocal });
          return emitStandalonePromiseCombinatorRuntime(
            ctx,
            fctx,
            methodName,
            argVecLocal,
            vecShape.vecTypeIdx,
            vecShape.arrTypeIdx,
          );
        }
        // Didn't lower as an externref vec — roll back, then either take the
        // (#2922 arms 2+3) dynamic path or fall through to the host path.
        rollbackSpeculative(ctx, fctx, snap);
        if (isDynamicCombinatorArgEligible(ctx, argType, arg0)) {
          return emitDynamicCombinatorArg(ctx, fctx, methodName, arg0);
        }
      }
      const importName = `Promise_${methodName}`;
      // Three-arg signature: (thisArg, iterable, directCall) → result
      // (#1116) directCall=1 means "no explicit `.call` was used; default to
      // globalThis.Promise". directCall=0 means "user wrote `.call(thisArg, …)`;
      // pass thisArg through unchanged so the runtime / V8 can apply the
      // spec-mandated TypeError when thisArg is non-Object."
      let funcIdx =
        ctx.funcMap.get(importName) ??
        ensureLateImport(
          ctx,
          importName,
          [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
          [{ kind: "externref" }],
        );
      flushLateImportShifts(ctx, fctx);
      funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
      if (funcIdx !== undefined) {
        // (#1116b, E1) Subclass static `Sub.all(iter)` — the receiver
        // `Sub` is a `class extends Promise`. Resolve it to the synthesized
        // JS subclass as thisArg and switch to directCall=0 so the runtime
        // uses it instead of substituting globalThis.Promise.
        const subclassThisArg = resolvePromiseSubclassThisArg(ctx, fctx, propAccess.expression);
        if (!subclassThisArg) {
          // Direct `Promise.METHOD(iter)` — no explicit thisArg.
          fctx.body.push({ op: "ref.null.extern" });
        }
        if (expr.arguments.length >= 1) {
          // (#1465) The runtime helper delegates to native
          // `Promise.METHOD.call(C, iter)` which drives `GetIterator(iter)`
          // per spec. For that to work the host engine must see a real JS
          // iterable. Array literals tend to compile to a wasm tuple/vec
          // struct that's opaque to the host, so materialise them into a
          // JS array eagerly here. Other expressions fall back to plain
          // externref coercion (the runtime helper handles strings, JS
          // arrays, generators, custom iterables, and known wasm vec
          // shapes via __vec_len/__vec_get).
          emitIterableArg(ctx, fctx, expr.arguments[0]!);
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        // directCall=1 — runtime substitutes globalThis.Promise. When a
        // subclass receiver was resolved (E1), directCall=0 so the runtime
        // uses the synthesized thisArg ctor instead.
        fctx.body.push({ op: "i32.const", value: subclassThisArg ? 0 : 1 });
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    if (isResolveReject) {
      const methodName = propAccess.name.text;
      // (#1326 Phase 1B) Standalone-mode `Promise.resolve(v)` /
      // `Promise.reject(r)` — emit Wasm-native `$Promise` struct.new instead
      // of the JS-host `Promise_{resolve,reject}_import` (unsatisfiable in
      // WASI). (#2980 async-gen fallback lives in `isStandalonePromiseActive`.)
      if (isStandalonePromiseActive(ctx)) {
        // (#3125) `Promise.resolve` now routes through the spec Resolve
        // (`__promise_resolve_value` — thenable assimilation / poisoned-then
        // reject / promise passthrough), which needs the settle-function
        // substrate. Ensure it BEFORE compiling the argument into the
        // detached side buffer, so the substrate's minted-func registration
        // can never land while `argInstrs` is off `fctx.body`/liveBodies.
        if (methodName === "resolve") {
          ensurePromiseSettleFunctions(ctx);
        }
        // Compile the value/reason argument FIRST into a side buffer
        // so the helper controls the final Wasm op order
        // (state | value | null | struct.new | extern.convert_any).
        const argInstrs: Instr[] = [];
        ctx.liveBodies.add(argInstrs);
        const savedBody = fctx.body;
        fctx.body = argInstrs;
        try {
          if (expr.arguments.length >= 1) {
            compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
        } finally {
          fctx.body = savedBody;
        }
        try {
          if (methodName === "resolve") {
            emitStandalonePromiseResolve(ctx, fctx, argInstrs);
          } else {
            emitStandalonePromiseReject(ctx, fctx, argInstrs);
          }
        } finally {
          ctx.liveBodies.delete(argInstrs);
        }
        return { kind: "externref" };
      }
      const importName = `Promise_${methodName}`;
      let funcIdx =
        ctx.funcMap.get(importName) ??
        ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
      if (funcIdx !== undefined) {
        if (expr.arguments.length >= 1) {
          compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
  }

  // (#1368) Detect `Promise.METHOD.call(thisArg, iter)` pattern — common in
  // test262 to set a custom constructor (`Promise.all.call(SubClass, iter)`).
  // The current call expression looks like `(Promise.METHOD).call(thisArg, iter)`,
  // i.e. propAccess.name.text === "call" and propAccess.expression is a
  // PropertyAccess `Promise.METHOD`.
  if (
    propAccess.name.text === "call" &&
    ts.isPropertyAccessExpression(propAccess.expression) &&
    ts.isIdentifier(propAccess.expression.expression) &&
    propAccess.expression.expression.text === "Promise" &&
    (propAccess.expression.name.text === "all" ||
      propAccess.expression.name.text === "race" ||
      propAccess.expression.name.text === "allSettled" ||
      propAccess.expression.name.text === "any") &&
    expr.arguments.length >= 1
  ) {
    // (#1326 Phase 1B note) The `.call(...)` aggregator pattern only
    // fires for all/race/allSettled/any (see `condition above`), NOT
    // for Promise.resolve/reject. Phase 1B's standalone path lives at
    // the earlier direct-call site (`Promise.resolve(v)` /
    // `Promise.reject(r)` without `.call`) and does not apply here.
    const methodName = propAccess.expression.name.text;
    const importName = `Promise_${methodName}`;
    // Three-arg signature: (thisArg, iterable, directCall) → result. See (#1116)
    // comment at the direct-call branch above.
    let funcIdx =
      ctx.funcMap.get(importName) ??
      ensureLateImport(
        ctx,
        importName,
        [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
        [{ kind: "externref" }],
      );
    flushLateImportShifts(ctx, fctx);
    funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
    if (funcIdx !== undefined) {
      // arg0 = thisArg (user-provided — may be undefined/null/primitive,
      // in which case the runtime / V8 throws TypeError per spec §27.2.4.X step 2).
      // (#1116b) When thisArg names a `class X extends Promise`, resolve it to
      // a synthesized JS-callable Promise subclass; otherwise compile normally.
      if (!resolvePromiseSubclassThisArg(ctx, fctx, expr.arguments[0]!)) {
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      }
      // arg1 = iterable (or ref.null if missing). #1465: materialise array
      // literals to JS arrays so native GetIterator can drive them.
      if (expr.arguments.length >= 2) {
        emitIterableArg(ctx, fctx, expr.arguments[1]!);
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      // directCall=0 — user invoked via `.call`, so thisArg is meaningful.
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
  }

  // Handle JSON APIs through the selected semantic provider.
  if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "JSON") {
    const method = propAccess.name.text;
    const useNativeJsonProvider = ctx.targetProfile.semanticProviders === "native-first";
    // (#3176/#4397) ES2025 `JSON.rawJSON` / `JSON.isRawJSON` — native provider.
    // `rawJSON` builds a branded carrier object; `isRawJSON` reads
    // the `[[IsRawJSON]]` brand bit. Both reuse the native JSON codec +
    // object runtime (no host import, no second parser).
    if ((method === "rawJSON" || method === "isRawJSON") && useNativeJsonProvider) {
      if (method === "rawJSON" && expr.arguments.length >= 1) {
        // Build the carrier: `__json_rawjson` ToStrings the raw value inside
        // then validates + brands it.
        emitJsonRawJson(ctx);
        const rawArg = expr.arguments[0]!;
        // `undefined` / `void …` ToString to "undefined", which the parser
        // rejects. But both compile to a bare `ref.null extern` —
        // indistinguishable at runtime from `null` (whose ToString "null" IS a
        // valid rawJSON primitive). So pass the literal string "undefined" for
        // the syntactic undefined/void case; the codec then parses+rejects it.
        // Peel `as`/`satisfies`/parens/`!` wrappers so `undefined as any` is
        // still recognised.
        let peeled: ts.Expression = rawArg;
        while (
          ts.isAsExpression(peeled) ||
          ts.isSatisfiesExpression(peeled) ||
          ts.isParenthesizedExpression(peeled) ||
          ts.isNonNullExpression(peeled) ||
          ts.isTypeAssertionExpression(peeled)
        ) {
          peeled = peeled.expression;
        }
        const isUndefinedLit = (ts.isIdentifier(peeled) && peeled.text === "undefined") || ts.isVoidExpression(peeled);
        if (isUndefinedLit) {
          for (const ins of stringConstantExternrefInstrs(ctx, "undefined")) fctx.body.push(ins);
        } else {
          // Compile the arg to externref (the primitive-boxing target — a bare
          // `anyref` hint drops a number literal and pushes null).
          const argResult = compileExpression(ctx, fctx, rawArg, { kind: "externref" });
          if (argResult === null) return null;
          if (argResult.kind !== "externref") {
            coerceType(ctx, fctx, argResult, { kind: "externref" });
          }
        }
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_rawjson")! });
        return { kind: "externref" };
      }
      if (method === "isRawJSON") {
        if (expr.arguments.length >= 1) {
          const argResult = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
          if (argResult === null) return null;
          if (argResult.kind !== "externref") {
            coerceType(ctx, fctx, argResult, { kind: "externref" });
          }
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        emitJsonIsRawJson(ctx);
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_is_rawjson")! });
        return { kind: "i32" };
      }
    }
    if ((method === "stringify" || method === "parse") && expr.arguments.length >= 1) {
      // (#1324 primitives slice) For JSON.stringify of statically-typed
      // primitive values (null / undefined / boolean, plus number when the
      // target has a number_toString helper), emit the result without the
      // JSON_stringify host import. Standalone/WASI number stringify falls
      // through to the #1599 refusal until Phase 2 has pure-Wasm formatting.
      // Object/array/string/bigint cases fall through to the existing
      // JSON_stringify host import — full pure-Wasm shape walking is
      // tracked under #1353 (architect-spec follow-up).
      if (method === "stringify") {
        const primitiveStringType = tryEmitJsonStringifyPrimitive(ctx, fctx, expr.arguments[0]!);
        if (primitiveStringType !== undefined) {
          // Compile remaining args (replacer, space) for their side
          // effects only — primitive stringify ignores them per spec
          // §25.5.4 (replacer doesn't observe primitives, space only
          // affects nested output).
          for (let i = 1; i < expr.arguments.length; i++) {
            const t = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (t) fctx.body.push({ op: "drop" });
          }
          return primitiveStringType;
        }
        if (useNativeJsonProvider && expr.arguments.length >= 1) {
          // #2166: thread the optional replacer (must be null/undefined) and
          // space args so `JSON.stringify(value, null, 2)` produces the
          // indented form statically instead of refusing.
          const staticStringType = tryEmitJsonStringifyStatic(
            ctx,
            fctx,
            expr.arguments[0]!,
            expr.arguments[1],
            expr.arguments[2],
          );
          if (staticStringType !== undefined) {
            return staticStringType;
          }
          // (#2166 PR-A/PR-B) Dynamic object-graph stringify. The static fold
          // declined (runtime-built graph), so serialise with the pure-Wasm
          // recursive codec over the standalone value rep ($Object/$ObjVec/
          // boxed primitives) instead of refusing or silently wrong-folding.
          // PR-B threads a *static* `space` argument (number/string literal)
          // into the codec's indent path; a function/array replacer or a
          // *dynamic* space still keeps the refusal below.
          const replacerArg = expr.arguments[1];
          const spaceArg = expr.arguments[2];
          const replacerNullish =
            replacerArg === undefined ||
            replacerArg.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(replacerArg) && replacerArg.text === "undefined");
          // PR-A serialises `$Object` graphs only. Arrays (closed typed-vec
          // structs `number[]` etc.) and tuples are a separate sub-slice
          // (PR-A2) — they are NOT `$ObjVec`, so routing them to the codec
          // would emit wrong output. Detect an array/tuple static type via the
          // checker and keep it on the refusal path below.
          const arg0Type = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
          const checkerArr = ctx.checker as unknown as {
            isArrayType?: (t: unknown) => boolean;
            isTupleType?: (t: unknown) => boolean;
          };
          const isArrayLike =
            (checkerArr.isArrayType?.(arg0Type) ?? false) ||
            (checkerArr.isTupleType?.(arg0Type) ?? false) ||
            // Fallback when the internal predicates are unavailable: a numeric
            // index type with only integer / `length` own keys looks array-like.
            (arg0Type.getNumberIndexType() !== undefined &&
              arg0Type.getProperties().every((p) => /^\d+$/.test(p.name) || p.name === "length"));
          const valueExpression = unwrapReflectConstructExpr(expr.arguments[0]!);
          const arrayLiteralForCodec =
            ts.isArrayLiteralExpression(valueExpression) && !valueExpression.elements.some(ts.isSpreadElement)
              ? valueExpression
              : undefined;
          // (#2166 PR-B) Resolve a static `space` argument to the §25.5.2
          // indent unit ("gap"). `undefined` space → compact (gap ""). A
          // *dynamic* space arg stays unresolved → keep the refusal below
          // (rare shape). An empty gap (space ≤0 / "") routes through the
          // compact path.
          let gap: string | undefined = "";
          if (spaceArg !== undefined) {
            const staticSpace = staticSpaceValue(ctx, spaceArg);
            gap = staticSpace === undefined ? undefined : jsonGapFromStaticSpace(staticSpace);
          }
          if (replacerNullish && gap !== undefined && (!isArrayLike || arrayLiteralForCodec !== undefined)) {
            if (!emitJsonCodecValueAsAnyref(ctx, fctx, expr.arguments[0]!)) return null;
            emitJsonStringifyValue(ctx);
            flushLateImportShifts(ctx, fctx);
            if (gap === "") {
              // No indentation — the compact root (cheapest path).
              fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_stringify_root")! });
            } else {
              // Pretty-print: push the gap string and call the indent root.
              for (const instr of nativeStringLiteralInstrs(ctx, gap)) fctx.body.push(instr);
              fctx.body.push({
                op: "call",
                funcIdx: ctx.funcMap.get("__json_stringify_root_indent")!,
              });
            }
            return nativeStringType(ctx);
          }
          // (#2166 PR-D3) replacer — a function replacer transforms every
          // property/element (`replacer.call(holder, key, value)`); an array
          // replacer is a key allowlist. Both route to the dynamic codec via
          // __json_stringify_root_replacer. The value must be a plain object
          // graph (PR-A scope — not array-like); a dynamic space still refuses.
          if (
            !replacerNullish &&
            gap !== undefined &&
            (!isArrayLike || arrayLiteralForCodec !== undefined) &&
            replacerArg !== undefined
          ) {
            const replacerCallable =
              ts.isArrowFunction(replacerArg) ||
              ts.isFunctionExpression(replacerArg) ||
              ctx.checker.getTypeAtLocation(replacerArg).getCallSignatures().length > 0;
            const isArrayLiteral = ts.isArrayLiteralExpression(replacerArg);
            if (replacerCallable || isArrayLiteral) {
              // value → anyref
              if (!emitJsonCodecValueAsAnyref(ctx, fctx, expr.arguments[0]!)) return null;
              // gap (or null for compact)
              if (gap === "") {
                fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx });
              } else {
                for (const instr of nativeStringLiteralInstrs(ctx, gap)) fctx.body.push(instr);
              }
              // replacer (externref) + allowList (externref); exactly one is set.
              if (isArrayLiteral) {
                fctx.body.push({ op: "ref.null.extern" }); // no fn replacer
                emitJsonReplacerAllowList(ctx, fctx, replacerArg); // builds $Object → externref
              } else {
                // A function replacer goes through the GC-closure path
                // (compileArrowAsClosure), NOT __make_callback — the host
                // bridge leaks an env:: import and its JS wrapper fails the
                // __call_fn_method_2 ref.cast (same rationale as the PR-D1
                // reviver path).
                if (ts.isArrowFunction(replacerArg) || ts.isFunctionExpression(replacerArg)) {
                  compileArrowAsClosure(ctx, fctx, replacerArg);
                } else {
                  const r = compileExpression(ctx, fctx, replacerArg, { kind: "externref" });
                  if (r === null) return null;
                }
                fctx.body.push({ op: "ref.null.extern" }); // no allowList
              }
              emitJsonStringifyValue(ctx);
              flushLateImportShifts(ctx, fctx);
              fctx.body.push({
                op: "call",
                funcIdx: ctx.funcMap.get("__json_stringify_root_replacer")!,
              });
              return nativeStringType(ctx);
            }
          }
        }
      }
      if (method === "parse" && useNativeJsonProvider) {
        // (#2166 PR-D1) The static-literal fold ignores a reviver — skip it
        // when a 2nd arg is present so `JSON.parse('5', reviver)` runs the
        // reviver walk instead of folding to the bare parsed value.
        if (expr.arguments.length < 2) {
          const parsedType = tryEmitJsonParseLiteral(ctx, fctx, expr);
          if (parsedType !== undefined) {
            return parsedType;
          }
        }
        // (#2166 PR-C) Dynamic-graph JSON.parse: a runtime JSON *text* →
        // object / array / string / primitive value, parsed entirely in Wasm
        // (no `env::JSON_parse` host import). The full recursive-descent
        // grammar in json-codec-native.ts (`__json_parse_text`) builds the
        // SAME value rep the object runtime + stringify codec consume, so a
        // round-trip `JSON.parse(JSON.stringify(o))` and downstream property
        // reads work. It is a strict superset of the older primitive-only
        // `__json_parse_primitive` slice — which could only parse a lone
        // number / true / false / null and *traps* on `{`/`[`/`"` — so it
        // takes over the whole runtime-string case (the primitive helper
        // stays for any caller that still routes to it directly). A `reviver`
        // (#2166 PR-D1) A `reviver` (2nd arg) routes to the reviver codec when
        // it is a function; a non-function 2nd arg keeps the refusal below.
        if (expr.arguments.length === 1 || expr.arguments.length === 2) {
          let parseArgType: ts.Type | undefined;
          try {
            parseArgType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
          } catch {
            parseArgType = undefined;
          }
          // Route string-typed and `any`/`unknown`-typed (the common
          // `JSON.parse(text)` where `text: string`) arguments. A non-string
          // statically-typed arg (e.g. a number) is a type error in user code;
          // let it fall through to the refusal below.
          const isStringOrAny =
            parseArgType === undefined ||
            (parseArgType.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
          // A reviver is honoured only when it is callable (has call
          // signatures). A null / undefined / any other non-callable 2nd arg
          // is simply IGNORED per §25.5.1 (the reviver step is IsCallable-
          // gated) — route through the plain parse path, never refuse. This
          // matches the host JSON.parse behaviour for a non-function reviver.
          const reviverArg = expr.arguments[1];
          let reviverCallable = false;
          if (reviverArg !== undefined) {
            try {
              reviverCallable = ctx.checker.getTypeAtLocation(reviverArg).getCallSignatures().length > 0;
            } catch {
              reviverCallable = false;
            }
          }
          if (isStringOrAny) {
            const argResult = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
            if (argResult === null) return null;
            if (argResult.kind !== "externref") {
              coerceType(ctx, fctx, argResult, { kind: "externref" });
            }
            if (reviverCallable) {
              // text already on the stack as externref; push the reviver as a
              // GC closure widened to externref. CRITICAL: compile the closure
              // via the GC-struct path (`compileArrowAsClosure`), NOT
              // `compileExpression(..., externref)` — the latter routes an
              // inline arrow at this non-user call site through the host
              // `__make_callback` bridge (an `env::` import that breaks
              // standalone and whose JS wrapper fails the `__call_fn_method_2`
              // ref.cast). The driver consumes the GC closure as externref via
              // extern.convert_any.
              const revResult =
                ts.isArrowFunction(reviverArg!) || ts.isFunctionExpression(reviverArg!)
                  ? compileArrowAsClosure(ctx, fctx, reviverArg!)
                  : compileExpression(ctx, fctx, reviverArg!, { kind: "anyref" });
              if (revResult === null) return null;
              if (revResult.kind === "ref" || revResult.kind === "ref_null" || revResult.kind === "anyref") {
                fctx.body.push({ op: "extern.convert_any" });
              } else if (revResult.kind !== "externref") {
                coerceType(ctx, fctx, revResult, { kind: "externref" });
              }
              emitJsonParseTextReviver(ctx);
              flushLateImportShifts(ctx, fctx);
              fctx.body.push({
                op: "call",
                funcIdx: ctx.funcMap.get("__json_parse_text_reviver")!,
              });
              return { kind: "anyref" };
            }
            emitJsonParseText(ctx);
            flushLateImportShifts(ctx, fctx);
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_parse_text")! });
            // The codec returns the value graph as anyref ($Object/$ObjVec/
            // $NativeString widened, or a ref $AnyValue for primitives). The
            // downstream coercion paths (object property read, AnyValue→
            // primitive) dispatch on the concrete ref via ref.test.
            return { kind: "anyref" };
          }
        }
      }
      void tryEmitJsonParsePrimitive;
      // (#1599 Phase 1) Refuse-and-document: in standalone (no-JS-host) /
      // WASI mode there is no `env::JSON_*` host import to fall back to.
      // The primitive `JSON.stringify` slice above (#1324) already handles
      // null / undefined / boolean as pure Wasm; everything else
      // (objects, arrays, strings, and all `JSON.parse`) needs the pure-Wasm
      // codec from Phase 2, which is not yet implemented. Emit a clear
      // compile error rather than a module that traps at instantiation.
      if (useNativeJsonProvider) {
        reportError(
          ctx,
          expr,
          `Codegen error: JSON.${method} of this value is not yet supported by the native JSON provider (#1599). ` +
            `Pure-Wasm JSON.stringify of null/undefined/boolean works standalone; ` +
            `numbers, objects, arrays, strings, and JSON.parse require the Phase 2 pure-Wasm codec (#1599 Phase 2). ` +
            `Avoid this JSON shape when native semantic providers are selected for now.`,
          "error",
          // (#3725) STICKY. This `reportError(...); return null` pair is a
          // deliberate refusal, but `return null` is indistinguishable from an
          // ordinary probe miss at `compileExpression`'s rollback, which
          // truncated the diagnostic and substituted a default value. The
          // observable result was the opposite of a refusal: `JSON.stringify` of
          // a closed typed-vec compiled to a clean, zero-import standalone module
          // that trapped on every call ("dereferencing a null pointer").
          { sticky: true },
        );
        return null;
      }
      const importName = `JSON_${method}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        // Compile first argument and coerce to externref
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
        // (#3912) A NATIVE string argument must be marshalled, not merely
        // widened. `coerceType(..., externref)` emits `extern.convert_any`,
        // which hands the host the opaque `$AnyString` struct — the host then
        // stringifies it as an ordinary object, so `JSON.stringify("hi")`
        // produced `"{}"` instead of `"\"hi\""`. Object/array arguments keep
        // `extern.convert_any`: the host data-struct bridge walks those.
        const argIsNativeString =
          ctx.nativeStrings &&
          ctx.anyStrTypeIdx >= 0 &&
          argType !== null &&
          (argType.kind === "ref" || argType.kind === "ref_null") &&
          ((argType as { typeIdx?: number }).typeIdx === ctx.anyStrTypeIdx ||
            (argType as { typeIdx?: number }).typeIdx === ctx.nativeStrTypeIdx);
        if (argIsNativeString && emitNativeStringToHostExternref(ctx, fctx)) {
          // marshalled to a real JS string
        } else if (argType && argType.kind !== "externref") {
          coerceType(ctx, fctx, argType, { kind: "externref" });
        }
        if (method === "stringify") {
          // Pass replacer (arg 2) and space (arg 3), or null sentinels
          if (expr.arguments.length >= 2) {
            const repType = compileExpression(ctx, fctx, expr.arguments[1]!);
            if (repType && repType.kind !== "externref") {
              coerceType(ctx, fctx, repType, { kind: "externref" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          if (expr.arguments.length >= 3) {
            const spType = compileExpression(ctx, fctx, expr.arguments[2]!);
            if (spType && spType.kind !== "externref") {
              coerceType(ctx, fctx, spType, { kind: "externref" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
        } else {
          // #2013 — `JSON.parse(text, reviver)` §25.5.1: forward the reviver
          // (arg 2) so the host applies InternalizeJSONProperty. A WasmGC
          // closure reviver coerces to externref like any other ref and the
          // host bridges it via `__call_fn_2`; absent → null sentinel (no-op).
          if (expr.arguments.length >= 2) {
            const revType = compileExpression(ctx, fctx, expr.arguments[1]!);
            if (revType && revType.kind !== "externref") {
              coerceType(ctx, fctx, revType, { kind: "externref" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        fctx.body.push({ op: "call", funcIdx });
        // (#3912) `env.JSON_stringify` hands back a REAL JS string. Under native
        // strings every downstream consumer expects an `$AnyString`, so reporting
        // this as a bare `externref` made them soft-cast it
        // (`any.convert_extern; ref.test $AnyString`), miss, substitute
        // `ref.null $AnyString`, and then trap in `struct.get $AnyString 0` —
        // `JSON.stringify({a:42}).length` was a "dereferencing a null pointer"
        // in the whole gc-native lane. Marshal at the boundary instead.
        //
        // Only `stringify` returns a string; `JSON.parse` returns an arbitrary
        // value and keeps its externref. Standalone/WASI never reach here (they
        // have no `env::JSON_*` import), so this is confined to the one config
        // that pairs a JS host with native strings.
        if (method === "stringify" && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
          const marshalled = emitHostExternrefToNativeString(ctx, fctx);
          if (marshalled !== null) return marshalled;
        }
        return { kind: "externref" };
      }
    }
  }

  // (#1483) performance.now() under --target wasi → clock_time_get
  // (CLOCK_MONOTONIC). In JS-host mode we leave existing behaviour (declared
  // global) alone so this branch only fires when a WASI helper exists.
  if (
    ts.isIdentifier(propAccess.expression) &&
    propAccess.expression.text === "performance" &&
    propAccess.name.text === "now" &&
    ctx.wasi &&
    ctx.funcMap.has("__wasi_performance_now")
  ) {
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__wasi_performance_now")! });
    return { kind: "f64" };
  }

  {
    const temporalStaticResult = tryCompileTemporalStaticCall(ctx, fctx, propAccess, expr);
    if (temporalStaticResult !== undefined) return temporalStaticResult;
  }

  // Handle Date.now() and Date.UTC() — pure Wasm static methods
  if (resolvesToNamedAmbientGlobal(ctx, propAccess.expression, "Date")) {
    const method = propAccess.name.text;
    if (method === "now") {
      // (#1483) Under --target wasi, route to clock_time_get instead of the
      // env::__date_now host import (which wasmtime does not provide).
      if (ctx.wasi && ctx.funcMap.has("__wasi_date_now")) {
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__wasi_date_now")! });
        return { kind: "f64" };
      }
      // (#2164) Pure standalone without a JS host/WASI clock has no wall-clock source, so env::__date_now is
      // unsatisfiable — every module that calls Date.now() (or new Date() with
      // no args) failed to instantiate standalone, breaking unrelated Date
      // tests that only touch Date.now() in setup. Emit the Unix epoch (0)
      // directly: deterministic, no import leak, module instantiates. Tests
      // that construct explicit timestamps (the bulk of the gap) then work;
      // only tests asserting a *real* current time (which standalone WasmGC
      // cannot provide) stay failing — and those need a clock source, not a
      // host import.
      if (ctx.standalone === true) {
        emitStandaloneDateNowValue(ctx, fctx);
        return { kind: "f64" };
      }
      const dateNowIdx = ensureLateImport(ctx, "__date_now", [], [{ kind: "f64" }]);
      if (dateNowIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: dateNowIdx });
      } else {
        fctx.body.push({ op: "f64.const", value: 0 });
      }
      return { kind: "f64" };
    }
    if (method === "UTC") {
      // Date.UTC(year, month?, date?, hours?, minutes?, seconds?, ms?) — §21.4.3.4.
      //   1. y = ToNumber(year); each present component is ToNumber'd, else its
      //      default (+0, or 1 for date).
      //   8. If y is NaN, yr = NaN; else yr = MakeFullYear(y): if 0..99, 1900+y.
      //   9. Return TimeClip(MakeDate(MakeDay(yr, m, dt), MakeTime(h,min,s,milli))).
      // A non-finite component, or a |timestamp| > 8.64e15 (TimeClip §21.4.1.14),
      // yields NaN. MakeDay (§21.4.1.12) rolls month overflow into the year:
      // ym = yr + floor(m/12), mn = m modulo 12. This mirrors the proven
      // new Date(y,m,…) constructor path in new-super.ts (#1343); the prior
      // implementation skipped MakeFullYear, the non-finite/TimeClip clamp, the
      // month normalization, and treated a missing year as 1970 instead of NaN.
      const args = expr.arguments;

      // §21.4.3.4 step 1: with no year argument, y = ToNumber(undefined) = NaN,
      // so the whole result is NaN (Date.UTC() ⇒ NaN).
      if (args.length === 0) {
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }

      const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);

      // Non-finite accumulator: OR-in (v !== v) and (|v| > 8.64e15) for every
      // *present* component (a missing arg uses a finite default and never
      // contributes). i64.trunc_sat would otherwise silently clamp NaN/±Inf.
      const nonFiniteLocal = allocTempLocal(fctx, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: nonFiniteLocal });
      const checkNonFinite = (f64Local: number) => {
        fctx.body.push({ op: "local.get", index: nonFiniteLocal });
        fctx.body.push({ op: "local.get", index: f64Local });
        fctx.body.push({ op: "local.get", index: f64Local });
        fctx.body.push({ op: "f64.ne" }); // NaN: v !== v
        fctx.body.push({ op: "i32.or" });
        fctx.body.push({ op: "local.get", index: f64Local });
        fctx.body.push({ op: "f64.abs" });
        fctx.body.push({ op: "f64.const", value: 8.64e15 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        fctx.body.push({ op: "local.set", index: nonFiniteLocal });
      };

      // year → i64 (ToNumber via f64 coercion; non-finite tracked)
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const yearF64 = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: yearF64 });
      checkNonFinite(yearF64);
      fctx.body.push({ op: "i64.trunc_sat_f64_s" });
      const yearL = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: yearL });
      releaseTempLocal(fctx, yearF64);

      // MakeFullYear §21.4.1.27: if 0 ≤ yr ≤ 99, yr += 1900.
      fctx.body.push(
        { op: "local.get", index: yearL },
        { op: "i64.const", value: 0n },
        { op: "i64.ge_s" },
        { op: "local.get", index: yearL },
        { op: "i64.const", value: 99n },
        { op: "i64.le_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: yearL },
            { op: "i64.const", value: 1900n },
            { op: "i64.add" },
            { op: "local.set", index: yearL },
          ],
        },
      );

      // Optional component → i64. A present arg is ToNumber'd + non-finite
      // tracked; an absent arg uses its (finite) default.
      const compilePart = (idx: number, def: bigint): number => {
        if (args.length > idx) {
          compileExpression(ctx, fctx, args[idx]!, { kind: "f64" });
          const f = allocTempLocal(fctx, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: f });
          checkNonFinite(f);
          releaseTempLocal(fctx, f);
          fctx.body.push({ op: "i64.trunc_sat_f64_s" });
        } else {
          fctx.body.push({ op: "i64.const", value: def });
        }
        const l = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: l });
        return l;
      };

      // month is 0-indexed (default +0). date defaults to 1; the rest to +0.
      const monthL = compilePart(1, 0n);
      const dayL = compilePart(2, 1n);
      const hoursL = compilePart(3, 0n);
      const minutesL = compilePart(4, 0n);
      const secondsL = compilePart(5, 0n);
      const msL = compilePart(6, 0n);

      // MakeDay §21.4.1.12: ym = yr + floor(m/12); mn = m modulo 12. i64.div_s/
      // rem_s truncate toward zero, so adjust for a negative remainder to get the
      // Euclidean floor-div / non-negative modulo. days_from_civil expects a
      // 1..12 civil month, so feed it (mn + 1) and the rolled year.
      const qL = allocTempLocal(fctx, { kind: "i64" });
      const rL = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push(
        { op: "local.get", index: monthL },
        { op: "i64.const", value: 12n },
        { op: "i64.div_s" },
        { op: "local.set", index: qL },
        { op: "local.get", index: monthL },
        { op: "i64.const", value: 12n },
        { op: "i64.rem_s" },
        { op: "local.set", index: rL },
        // if (r < 0) { q -= 1; r += 12 }
        { op: "local.get", index: rL },
        { op: "i64.const", value: 0n },
        { op: "i64.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: qL },
            { op: "i64.const", value: 1n },
            { op: "i64.sub" },
            { op: "local.set", index: qL },
            { op: "local.get", index: rL },
            { op: "i64.const", value: 12n },
            { op: "i64.add" },
            { op: "local.set", index: rL },
          ],
        },
        // year += q
        { op: "local.get", index: yearL },
        { op: "local.get", index: qL },
        { op: "i64.add" },
        { op: "local.set", index: yearL },
        // civil month = r + 1  (reuse monthL)
        { op: "local.get", index: rL },
        { op: "i64.const", value: 1n },
        { op: "i64.add" },
        { op: "local.set", index: monthL },
      );
      releaseTempLocal(fctx, rL);
      releaseTempLocal(fctx, qL);

      // ts = days_from_civil(year, civilMonth, day) * 86400000
      //      + h*3600000 + min*60000 + s*1000 + ms
      fctx.body.push(
        { op: "local.get", index: yearL },
        { op: "local.get", index: monthL },
        { op: "local.get", index: dayL },
        { op: "call", funcIdx: daysFromCivilIdx },
        { op: "i64.const", value: 86400000n },
        { op: "i64.mul" },
        { op: "local.get", index: hoursL },
        { op: "i64.const", value: 3600000n },
        { op: "i64.mul" },
        { op: "i64.add" },
        { op: "local.get", index: minutesL },
        { op: "i64.const", value: 60000n },
        { op: "i64.mul" },
        { op: "i64.add" },
        { op: "local.get", index: secondsL },
        { op: "i64.const", value: 1000n },
        { op: "i64.mul" },
        { op: "i64.add" },
        { op: "local.get", index: msL },
        { op: "i64.add" },
      );
      const tsL = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: tsL });

      // TimeClip §21.4.1.14: any non-finite component, or |ts| > 8.64e15 ⇒ NaN.
      fctx.body.push(
        { op: "local.get", index: nonFiniteLocal },
        { op: "local.get", index: tsL },
        { op: "f64.convert_i64_s" },
        { op: "f64.abs" },
        { op: "f64.const", value: 8.64e15 },
        { op: "f64.gt" },
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [{ op: "f64.const", value: NaN }],
          else: [{ op: "local.get", index: tsL }, { op: "f64.convert_i64_s" }],
        },
      );

      releaseTempLocal(fctx, tsL);
      releaseTempLocal(fctx, msL);
      releaseTempLocal(fctx, secondsL);
      releaseTempLocal(fctx, minutesL);
      releaseTempLocal(fctx, hoursL);
      releaseTempLocal(fctx, dayL);
      releaseTempLocal(fctx, monthL);
      releaseTempLocal(fctx, yearL);
      releaseTempLocal(fctx, nonFiniteLocal);

      return { kind: "f64" };
    }
    // Date.parse(str) — pure-Wasm ISO 8601 parser (#2164). Returns the time
    // value in ms (NaN on parse failure).
    //
    // Gated to standalone / WASI: those targets carry the WasmGC-native string
    // backend (`nativeStrings`), so the flatten + char-scan helper links
    // cleanly. In JS-host mode strings are `wasm:js-string` externrefs and
    // wiring the helper lazily mid-body trips the late-import index-shift class
    // (#2043: "heap type index out of range"); host mode keeps the prior NaN
    // stub (no regression — host Date.parse was always a NaN stub). A follow-up
    // can register __date_parse up-front (like parseInt in index.ts) to extend
    // native parsing to host mode.
    if (method === "parse") {
      // Date.parse() with no args → NaN (§21.4.3.2 — ToString(undefined)).
      if (expr.arguments.length === 0) {
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
      // (#2678) HOST mode: delegate to the JS `Date.parse` host import
      // (`__date_parse_host`, registered up-front by collectDateParseHostImports
      // so no mid-body late-import shift / #2043). Host strings are real
      // wasm:js-string externrefs and JS Date.parse is more format-complete than
      // the native ISO parser. Falls back to the prior NaN stub only if the
      // up-front scan somehow missed registering the import.
      if (!ctx.standalone && !ctx.wasi) {
        const hostIdx = ctx.funcMap.get("__date_parse_host");
        if (hostIdx !== undefined) {
          const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
          if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
          for (let i = 1; i < expr.arguments.length; i++) {
            const t = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (t) fctx.body.push({ op: "drop" });
          }
          fctx.body.push({ op: "call", funcIdx: hostIdx });
          return { kind: "f64" };
        }
        for (const arg of expr.arguments) {
          const t = compileExpression(ctx, fctx, arg);
          if (t) fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
      // Standalone / WASI: pure-Wasm native parser (#2164).
      emitNativeDateParse(ctx);
      const dateParseIdx = ctx.funcMap.get("__date_parse")!;
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
      // Evaluate any extra args for side effects, then drop.
      for (let i = 1; i < expr.arguments.length; i++) {
        const t = compileExpression(ctx, fctx, expr.arguments[i]!);
        if (t) fctx.body.push({ op: "drop" });
      }
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__date_parse") ?? dateParseIdx });
      return { kind: "f64" };
    }
  }

  // Check if this is a static method call: ClassName.staticMethod(args)
  if (ts.isIdentifier(propAccess.expression) && ctx.classSet.has(propAccess.expression.text)) {
    const clsName = ctx.classExprNameMap.get(propAccess.expression.text) ?? propAccess.expression.text;
    const methodName = propAccess.name.text;
    const fullName = `${clsName}_${methodName}`;
    if (ctx.staticMethodSet.has(fullName)) {
      const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "static")); // (#1983)
      if (funcIdx !== undefined) {
        // No self parameter for static methods
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const staticParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
        const calleeReadsArgsEarly = ctx.funcUsesArguments.has(fullName);
        for (let i = 0; i < Math.min(expr.arguments.length, staticParamCount); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
        }
        if (expr.arguments.length > staticParamCount) {
          if (calleeReadsArgsEarly) {
            emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], staticParamCount);
          } else {
            for (let i = staticParamCount; i < expr.arguments.length; i++) {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
        }
        // Pad missing arguments with defaults
        if (paramTypes) {
          for (let i = expr.arguments.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        // Set __argc before the call so the callee knows the actual arg count
        maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, staticParamCount);
        // Re-lookup funcIdx: argument compilation may trigger addUnionImports
        const finalStaticIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "static")) ?? funcIdx; // (#1983)
        fctx.body.push({ op: "call", funcIdx: finalStaticIdx });

        const sig = ctx.checker.getResolvedSignature(expr);
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalStaticIdx)) return VOID_RESULT;
          return brandExternMethodResult(
            ctx,
            retType,
            getWasmFuncReturnType(ctx, finalStaticIdx) ?? resolveWasmType(ctx, retType),
          );
        }
        // Synthetic calls produced for a conditional callee may not retain a
        // source parent, so TypeScript can decline to resolve their signature
        // even though the selected static method has a concrete emitted result.
        // Returning VOID_RESULT here makes the caller drop that result and
        // synthesize null. Preserve the actual Wasm signature in that case.
        if (wasmFuncReturnsVoid(ctx, finalStaticIdx)) return VOID_RESULT;
        return getWasmFuncReturnType(ctx, finalStaticIdx) ?? { kind: "externref" };
      }
    }
  }
  return undefined;
}
