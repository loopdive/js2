// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 W2b — `Reflect.construct(target, args, NT)` when the file assigns
 * `NT.prototype` a primitive. Split out of `reflect-construct-newtarget.ts`
 * (whose single-assignment proofs it reuses) to keep that file under the
 * #3102 LOC threshold.
 */
import { ts, forEachChild } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";
import { tryEnsureNativeProtoBrand } from "../builtin-value-read.js";
import { buildLazyNativeProtoGetInstrs } from "../native-proto.js";
import { constructorProtoNullToDefaultInstrs } from "../object-model/construct-default-proto.js";
import {
  hasDeclaredType,
  isNewProxyExpression,
  isPlainFunctionLike,
  isRebound,
  isWrittenAfterDeclaration,
  prepareRuntimeNewTargetProto,
} from "./reflect-construct-newtarget.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * (#6651 W2b) Is `%Object.prototype%` the intrinsicDefaultProto of every
 * [[Construct]] `target` can denote — §10.1.14 step 4's fallback when
 * `Get(NewTarget, "prototype")` is not an Object?
 *
 * True for an ordinary function, a bound function or a Proxy over one, and a
 * class whose heritage chain ends at one (or has none): each reaches
 * OrdinaryCreateFromConstructor(NewTarget, "%Object.prototype%"). A builtin
 * constructor (`Date`, `Error`, `Array`, …) has its own intrinsic default, and
 * the ordinary `new` result already carries it, so anything unproven answers
 * false and keeps that result untouched. Bindings must never be rewritten,
 * by the same single-assignment proofs the routes above use.
 */
function constructDefaultsToObjectPrototype(ctx: CodegenContext, expr: ts.Expression, depth = 6): boolean {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (depth <= 0) return false;
  const next = (e: ts.Expression): boolean => constructDefaultsToObjectPrototype(ctx, e, depth - 1);
  // The caller patches the RESULT, so a body that can `return` an object of
  // its own (which must come back untouched) is out.
  const plainFn = (fn: ts.FunctionDeclaration | ts.FunctionExpression): boolean =>
    isPlainFunctionLike(fn) && !returnsValue(fn.body);
  const heritageOk = (cls: ts.ClassLikeDeclaration): boolean => {
    const ctor = cls.members.find(ts.isConstructorDeclaration);
    if (ctor !== undefined && returnsValue(ctor.body)) return false;
    const ext = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    return ext === undefined || next(ext.expression);
  };
  if (ts.isFunctionExpression(expr)) return plainFn(expr);
  if (ts.isClassExpression(expr)) return heritageOk(expr);
  if (isNewProxyExpression(expr, true)) {
    // Only a trapless handler: a `construct` trap's own result is not patched.
    const [proxyTarget, handler] = (expr as ts.NewExpression).arguments ?? [];
    const trapless = handler !== undefined && ts.isObjectLiteralExpression(handler) && handler.properties.length === 0;
    return trapless && proxyTarget !== undefined && next(proxyTarget);
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === "bind" && next(callee.expression);
  }
  if (!ts.isIdentifier(expr)) return false;
  const declarations = ctx.oracle.declarationsOf(expr);
  if (declarations.length !== 1) return false;
  const declaration = declarations[0]!;
  const source = expr.getSourceFile();
  if (declaration.getSourceFile() !== source) return false;
  if (ts.isFunctionDeclaration(declaration)) {
    return plainFn(declaration) && !isRebound(source, expr.text, true);
  }
  if (ts.isClassDeclaration(declaration)) {
    return heritageOk(declaration) && !isWrittenAfterDeclaration(source, expr.text, true);
  }
  if (!ts.isVariableDeclaration(declaration) || hasDeclaredType(declaration)) return false;
  const initializer = ctx.oracle.variableInitializerOf(expr);
  return initializer !== undefined && !isWrittenAfterDeclaration(source, expr.text, true) && next(initializer);
}

/** Does `body` hold a `return <expr>` of its own (nested functions excluded)? */
function returnsValue(body: ts.Node | undefined): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) found = true;
    else forEachChild(node, visit);
  };
  if (body !== undefined) forEachChild(body, visit);
  return found;
}

/**
 * (#6651 W2b) `Reflect.construct(target, args, NT)` where the file assigns
 * `NT.prototype` a primitive (`C.prototype = null`). The caller used to return
 * the ordinary `new target(…)` result untouched, which carries the TARGET's
 * prototype; §10.1.14 step 4 wants the intrinsic default instead. Registers
 * `__object_setPrototypeOf` (before any construct code is emitted, for the
 * late-import shift) and answers whether {@link emitObjectPrototypeDefault}
 * may run — only when the default is provably `%Object.prototype%` and the
 * object runtime is the native one.
 */
export function preparePrimitiveNewTargetDefault(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
): boolean {
  if (!ctx.standalone || !constructDefaultsToObjectPrototype(ctx, target)) return false;
  prepareRuntimeNewTargetProto(ctx, fctx);
  tryEnsureNativeProtoBrand(ctx, "Object"); // registered before the construct code, see emitObjectPrototypeDefault
  return (
    ctx.funcMap.get("__object_setPrototypeOf") !== undefined && constructorProtoNullToDefaultInstrs(ctx, 0).length > 0
  );
}

/**
 * Consume the constructed value and leave it with [[Prototype]] set to the
 * implicit `%Object.prototype%` terminal: `[[SetPrototypeOf]](result,
 * undefined)` writes a null `$proto` WITHOUT the explicit-null flag (see
 * `construct-default-proto.ts`). A closed-struct result is a silent no-op.
 */
export function emitObjectPrototypeDefault(ctx: CodegenContext, fctx: FunctionContext): void {
  const setProto = ctx.funcMap.get("__object_setPrototypeOf")!;
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  const brand = objectTypeIdx === undefined ? undefined : tryEnsureNativeProtoBrand(ctx, "Object");
  const protoSingleton = brand === undefined ? null : buildLazyNativeProtoGetInstrs(ctx, brand);
  if (objectTypeIdx === undefined || protoSingleton === null) {
    fctx.body.push(...canonicalUndefinedExternInstrs(ctx), { op: "call", funcIdx: setProto });
    return;
  }
  // A class instance (a closed struct the #802 prescan gave a `$__proto__`
  // field) stores its [[Prototype]] as a value, so it needs the real
  // `%Object.prototype%` object rather than the `$Object` encoding.
  const result = allocLocal(fctx, `__w2b_result_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(
    { op: "local.tee", index: result },
    { op: "local.get", index: result },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: canonicalUndefinedExternInstrs(ctx),
      else: [...protoSingleton, { op: "extern.convert_any" }],
    },
    { op: "call", funcIdx: setProto },
  );
}
