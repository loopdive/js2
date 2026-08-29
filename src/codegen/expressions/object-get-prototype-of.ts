// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * ES5 Object.getPrototypeOf semantics that need compiler-owned intrinsic
 * identity rather than host inspection of opaque Wasm values.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression } from "../shared.js";
import { emitLazyNativeProtoGet } from "../native-proto.js";
import { tryEnsureNativeProtoBrand } from "../property-access.js";
import { isGlobalBuiltinIdentifier } from "./calls.js";
import { emitThrowTypeError } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { integrityVarKey } from "../widened-var-key.js";

const NATIVE_COLLECTION_NAMES = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

const ES5_FUNCTION_PROTOTYPE_CTORS = new Set([
  "Object",
  "Function",
  "Array",
  "String",
  "Boolean",
  "Number",
  "Date",
  "RegExp",
  "Error",
]);

/**
 * Constructors `C` for which `Object.getPrototypeOf(C.prototype)` is exactly
 * `%Object.prototype%`.
 *
 * `Function.prototype` (§20.2.3) is the original member: a built-in function
 * object whose [[Prototype]] is `%Object.prototype%`, carrying no `$proto` link
 * the native `__getPrototypeOf` walk can follow — so that walk answered `null`.
 * `Promise.prototype` (§27.2.3.1, #5143) has the same shape: it lowers to a
 * `$NativeProto` struct whose `$parent` field is left null ("chain walk
 * deferred", `native-proto.ts`), so the query silently answered `null` too.
 *
 * Membership is per-constructor and deliberate: most builtin prototypes do NOT
 * root directly at `%Object.prototype%` (see the call site's comment).
 */
const OBJECT_ROOTED_PROTOTYPE_CTORS = new Set(["Function", "Promise"]);

const ES5_NATIVE_ERROR_CTORS = new Set([
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const ES5_OBJECT_PROTOTYPES = new Map([
  ["Array", "Array"],
  ["ReadonlyArray", "Array"],
  ["String", "String"],
  ["Boolean", "Boolean"],
  ["Number", "Number"],
  ["Date", "Date"],
  ["RegExp", "RegExp"],
  ["Error", "Error"],
  // (§20.5.6.4) Each NativeError has its OWN prototype object; collapsing them
  // onto `Error` made `Object.getPrototypeOf(new EvalError) === Error.prototype`
  // (test262 `NativeErrors/*/instance-proto.js`, `prototype.js`).
  ["EvalError", "EvalError"],
  ["RangeError", "RangeError"],
  ["ReferenceError", "ReferenceError"],
  ["SyntaxError", "SyntaxError"],
  ["TypeError", "TypeError"],
  ["URIError", "URIError"],
  ["IArguments", "Object"],
]);

function isTopLevelThis(expr: ts.Expression): boolean {
  if (expr.kind !== ts.SyntaxKind.ThisKeyword) return false;
  for (let parent = expr.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
  }
  return true;
}

/** Emit the identity-stable standalone prototype for a native collection. */
export function tryNativeCollectionGpo(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  argTsType: ts.Type,
): boolean {
  if (!ctx.standalone && !ctx.wasi) return false;
  const collectionName = argTsType.getSymbol()?.name;
  if (collectionName === undefined || !NATIVE_COLLECTION_NAMES.has(collectionName)) return false;

  const argType = compileExpression(ctx, fctx, arg);
  if (argType) fctx.body.push({ op: "drop" });
  const brand = tryEnsureNativeProtoBrand(ctx, collectionName);
  if (brand === undefined || !emitLazyNativeProtoGet(ctx, fctx, brand)) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return true;
}

/**
 * Return true when an expression is a statically-known JSON object parse.
 *
 * The standalone JSON codec materialises parsed objects as ordinary open
 * objects, but their runtime `$Object` carrier intentionally keeps the
 * prototype link implicit. Recognising a literal object payload here lets
 * `Object.getPrototypeOf` expose the canonical `%Object.prototype%` value,
 * matching the ordinary-object result without changing `Object.create(null)`.
 * Only a literal whose first non-whitespace character is `{` is admitted:
 * arrays and primitive JSON payloads have different intrinsic prototypes.
 */
function isJsonObjectParseCall(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): boolean {
  if (
    !ts.isCallExpression(expr) ||
    !ts.isPropertyAccessExpression(expr.expression) ||
    expr.expression.name.text !== "parse" ||
    !ts.isIdentifier(expr.expression.expression) ||
    expr.expression.expression.text !== "JSON" ||
    !isGlobalBuiltinIdentifier(ctx, fctx, expr.expression.expression)
  ) {
    return false;
  }
  const source = expr.arguments[0];
  if (!source || !ts.isStringLiteralLike(source)) return false;
  return source.text.trim().startsWith("{");
}

/**
 * Emit the compiler-owned intrinsic prototype singleton rather than asking the
 * host MOP for the prototype of an opaque Wasm closure/struct.
 */
function emitEs5IntrinsicPrototype(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anchor: ts.Node,
  builtinName: string,
): InnerResult {
  const builtin = ts.factory.createIdentifier(builtinName);
  const prototype = ts.factory.createPropertyAccessExpression(builtin, "prototype");
  (builtin as { parent?: ts.Node }).parent = prototype;
  (prototype as { parent?: ts.Node }).parent = anchor;
  ts.setTextRange(builtin, anchor);
  ts.setTextRange(prototype, anchor);
  return compileExpression(ctx, fctx, prototype, { kind: "externref" }) ?? { kind: "externref" };
}

function emitEs5IntrinsicConstructor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anchor: ts.Node,
  builtinName: string,
): InnerResult {
  const builtin = ts.factory.createIdentifier(builtinName);
  (builtin as { parent?: ts.Node }).parent = anchor;
  ts.setTextRange(builtin, anchor);
  return compileExpression(ctx, fctx, builtin, { kind: "externref" }) ?? { kind: "externref" };
}

/**
 * Handle ES5 errors and intrinsic constructor/namespace relations before the
 * specialized generator, class, and typed-array getPrototypeOf cases.
 */
export function tryCompileEs5GetPrototypeOfEarly(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | null {
  if (expr.arguments.length === 0) {
    emitThrowTypeError(ctx, fctx, "Object.getPrototypeOf requires an object");
    return { kind: "externref" };
  }

  const arg0 = expr.arguments[0]!;
  if (
    arg0.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(arg0) &&
      arg0.text === "undefined" &&
      !fctx.localMap.has(arg0.text) &&
      !fctx.boxedCaptures?.has(arg0.text))
  ) {
    emitThrowTypeError(ctx, fctx, "Cannot convert undefined or null to object");
    return { kind: "externref" };
  }

  // Closed standalone plain objects keep their ordinary prototype implicit.
  // An integrity call marks the identifier, so preserve the argument read and
  // answer this exact query with the compiler-owned singleton.
  if (ctx.standalone && ts.isIdentifier(arg0) && ctx.nonExtensibleVars.has(integrityVarKey(ctx, arg0))) {
    const argType = compileExpression(ctx, fctx, arg0);
    if (argType) fctx.body.push({ op: "drop" });
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
  }

  if (ts.isIdentifier(arg0) && isGlobalBuiltinIdentifier(ctx, fctx, arg0)) {
    if (ES5_FUNCTION_PROTOTYPE_CTORS.has(arg0.text)) {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Function");
    }
    // (#4781) The ES2015 WeakMap constructor is itself a built-in function,
    // so its [[Prototype]] is %Function.prototype%. Keep this query on the
    // intrinsic path in both lanes; the native collection path below models
    // WeakMap instances and must not answer for the constructor object.
    if (arg0.text === "WeakMap") {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Function");
    }
    if (ES5_NATIVE_ERROR_CTORS.has(arg0.text)) {
      return emitEs5IntrinsicConstructor(ctx, fctx, expr, "Error");
    }
    if (arg0.text === "Math" || arg0.text === "JSON") {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
    }
  }

  // (§20.2.3) `Object.getPrototypeOf(Function.prototype) === Object.prototype`.
  // %Function.prototype% is a built-in function object whose [[Prototype]] is
  // %Object.prototype%; it carries no `$proto` link the native `__getPrototypeOf`
  // walk can follow, so that walk answered `null` — a SILENT wrong answer that
  // also made `getPrototypeOf(Function.prototype) === getPrototypeOf([1,2])`
  // spuriously true (both null). `Object.prototype` is already the
  // identity-stable singleton this file emits for `Math`/`JSON`, so routing here
  // gives real `ref.eq` identity (test262 `Function/prototype/S15.3.4_A3_T1.js`).
  //
  // Deliberately narrow — see `OBJECT_ROOTED_PROTOTYPE_CTORS`. The other builtin
  // prototypes do NOT uniformly inherit from %Object.prototype%
  // (`Int8Array.prototype` → %TypedArray%.prototype, `TypeError.prototype` →
  // `Error.prototype`), and this hook runs BEFORE the typed-array / generator /
  // class getPrototypeOf arms — a blanket branch here would preempt them with a
  // wrong answer.
  if (
    ts.isPropertyAccessExpression(arg0) &&
    arg0.name.text === "prototype" &&
    ts.isIdentifier(arg0.expression) &&
    OBJECT_ROOTED_PROTOTYPE_CTORS.has(arg0.expression.text) &&
    isGlobalBuiltinIdentifier(ctx, fctx, arg0.expression)
  ) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
  }
  return null;
}

/**
 * Resolve ES5 primitive wrappers and ordinary value flows after more specific
 * getPrototypeOf cases have had the opportunity to claim the expression.
 */
export function tryCompileEs5GetPrototypeOfValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | null {
  const arg0 = expr.arguments[0]!;
  if (isJsonObjectParseCall(ctx, fctx, arg0)) {
    // Preserve JSON.parse validation and reviver side effects before replacing
    // only the prototype query with the canonical intrinsic singleton.
    const parsedType = compileExpression(ctx, fctx, arg0);
    if (parsedType) fctx.body.push({ op: "drop" });
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
  }
  // (§20.5.6.4) `<NativeError>.prototype`'s own [[Prototype]] IS `Error.prototype`.
  // The declared-name map below sees the type name `EvalError` for BOTH an
  // EvalError instance and `EvalError.prototype`, so without this arm the
  // per-NativeError rows would answer the receiver itself
  // (`NativeErrors/*/prototype/proto.js`).
  if (
    ts.isPropertyAccessExpression(arg0) &&
    arg0.name.text === "prototype" &&
    ts.isIdentifier(arg0.expression) &&
    ES5_NATIVE_ERROR_CTORS.has(arg0.expression.text) &&
    isGlobalBuiltinIdentifier(ctx, fctx, arg0.expression)
  ) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Error");
  }

  const staticType = ctx.oracle.staticJsTypeOf(arg0);
  if (staticType === "boolean") return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Boolean");
  if (staticType === "string") return emitEs5IntrinsicPrototype(ctx, fctx, expr, "String");
  if (staticType === "number") return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Number");

  const knownPrototypeName = ES5_OBJECT_PROTOTYPES.get(ctx.oracle.declaredNameOf(arg0) ?? "");
  if (knownPrototypeName) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, knownPrototypeName);
  }
  if (ctx.oracle.signatureOf(arg0) !== undefined || ts.isFunctionExpression(arg0) || ts.isArrowFunction(arg0)) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Function");
  }
  if (ts.isArrayLiteralExpression(arg0)) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Array");
  }
  if (ts.isObjectLiteralExpression(arg0)) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
  }
  if (ts.isIdentifier(arg0)) {
    const initializer = ctx.oracle.variableInitializerOf(arg0);
    if (initializer && isJsonObjectParseCall(ctx, fctx, initializer)) {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
    }
    if (initializer && ts.isArrayLiteralExpression(initializer)) {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Array");
    }
    if (initializer && ts.isObjectLiteralExpression(initializer)) {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
    }
    if (initializer && (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer))) {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Function");
    }
  }
  if (isTopLevelThis(arg0)) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
  }
  return null;
}

function objectGetPrototypeOfSource(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): ts.Expression | undefined {
  let current = expr;
  const seen = new Set<ts.Expression>();
  for (let depth = 0; depth < 4; depth++) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "getPrototypeOf" &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === "Object" &&
      isGlobalBuiltinIdentifier(ctx, fctx, current.expression.expression)
    ) {
      return current.arguments[0];
    }
    if (!ts.isIdentifier(current)) return undefined;
    const initializer = ctx.oracle.variableInitializerOf(current);
    if (!initializer) return undefined;
    current = initializer;
  }
  return undefined;
}

function expressionsAreSameBinding(ctx: CodegenContext, left: ts.Expression, right: ts.Expression): boolean {
  if (left.kind === ts.SyntaxKind.ThisKeyword && right.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right) || left.text !== right.text) return false;
  return ctx.oracle.variableDeclarationOf(left) === ctx.oracle.variableDeclarationOf(right);
}

function isEmptyReconstructedConstructor(ctx: CodegenContext, expr: ts.NewExpression): boolean {
  const gate = ctx.fnctorEscapeGate;
  if (!gate?.approved.has(expr) || !ts.isIdentifier(expr.expression)) return false;
  return gate.ctorDeclByName.get(expr.expression.text)?.body?.statements.length === 0;
}

function hasProvablyNonNullOrdinaryPrototype(ctx: CodegenContext, expr: ts.Expression): boolean {
  let current = expr;
  const seen = new Set<ts.Expression>();
  for (let depth = 0; depth < 4; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (
      isTopLevelThis(current) ||
      ts.isObjectLiteralExpression(current) ||
      ts.isArrayLiteralExpression(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return true;
    }
    if (ts.isNewExpression(current)) return isEmptyReconstructedConstructor(ctx, current);
    if (!ts.isIdentifier(current)) return false;
    const initializer = ctx.oracle.variableInitializerOf(current);
    if (!initializer) return false;
    current = initializer;
  }
  return false;
}

/**
 * Route calls on a getPrototypeOf result through the language-level prototype
 * walk. Statically fold only the direct-parent relation when the source cannot
 * have a null prototype.
 */
export function tryCompileGetPrototypeOfIsPrototypeOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  receiver: ts.Expression,
): InnerResult | null {
  const source = objectGetPrototypeOfSource(ctx, fctx, receiver);
  if (!source || expr.arguments.length === 0) return null;

  if (expressionsAreSameBinding(ctx, source, expr.arguments[0]!) && hasProvablyNonNullOrdinaryPrototype(ctx, source)) {
    const receiverType = compileExpression(ctx, fctx, receiver);
    if (receiverType) fctx.body.push({ op: "drop" });
    const candidateType = compileExpression(ctx, fctx, expr.arguments[0]!);
    if (candidateType) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 1 });
    return { kind: "i32", boolean: true };
  }

  const protoIdx = ensureLateImport(
    ctx,
    "__isPrototypeOf",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  const receiverType = compileExpression(ctx, fctx, receiver);
  if (receiverType && receiverType.kind !== "externref") {
    coerceType(ctx, fctx, receiverType, { kind: "externref" });
  }
  const candidateType = compileExpression(ctx, fctx, expr.arguments[0]!);
  if (candidateType && candidateType.kind !== "externref") {
    coerceType(ctx, fctx, candidateType, { kind: "externref" });
  }
  if (protoIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: protoIdx });
  } else {
    fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "i32.const", value: 0 });
  }
  return { kind: "i32", boolean: true };
}
