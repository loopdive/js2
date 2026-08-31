// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../../ts-api.js";
import { isStandalonePromiseActive } from "../async-scheduler.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { emitWasiErrorConstructor } from "../registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "../registry/imports.js";
import { compileExpression } from "../shared.js";
import type { InnerResult } from "../shared.js";
import { resolvesToAmbientGlobal, resolvesToNamedAmbientGlobal } from "./non-constructable.js";
import { resolvePromiseSubclassIdentifier } from "./promise-subclass.js";

const NON_CONSTRUCTOR_GLOBALS = new Set([
  "eval",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
]);
const PROMISE_STATIC_METHODS = new Set(["all", "allSettled", "race", "any", "resolve", "reject"]);

function isSideEffectFreeLiteralArg(arg: ts.Expression): boolean {
  return ts.isNumericLiteral(arg) || ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg);
}

/** Whether `receiver` is statically non-constructable without evaluating user code. */
function isStaticNonConstructorReceiver(ctx: CodegenContext, receiver: ts.Expression | undefined): boolean {
  if (receiver === undefined) return true;
  let expr = receiver;
  while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
    expr = expr.expression;
  }
  // A symbol variable is still a primitive even when its initializer is no
  // longer syntactically visible at the call site (for example, `const s =
  // Symbol(); Promise.resolve.call(s, value)`).  Keep this proof aligned with
  // the oracle's JS value tag so the standalone path emits the required
  // IsConstructor TypeError instead of treating the native symbol carrier as
  // an opaque constructor candidate.
  if (ctx.oracle.staticJsTypeOf(expr) === "symbol") return true;
  if (ts.isNumericLiteral(expr) || ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isVoidExpression(expr)) {
    const operand = expr.expression;
    return ts.isNumericLiteral(operand) || ts.isStringLiteral(operand) || operand.kind === ts.SyntaxKind.NullKeyword;
  }
  if (ts.isArrowFunction(expr)) return true;
  if (ts.isObjectLiteralExpression(expr) && expr.properties.length === 0) return true;
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    resolvesToNamedAmbientGlobal(ctx, expr.expression, "Symbol")
  ) {
    return (
      expr.arguments.length === 0 || (expr.arguments.length === 1 && isSideEffectFreeLiteralArg(expr.arguments[0]!))
    );
  }
  if (!ts.isIdentifier(expr)) return false;
  if (expr.text === "undefined") return resolvesToNamedAmbientGlobal(ctx, expr, "undefined");
  if (expr.text === "Promise" && resolvesToNamedAmbientGlobal(ctx, expr, "Promise")) return false;
  if (resolvePromiseSubclassIdentifier(ctx, expr) !== undefined) return false;
  return NON_CONSTRUCTOR_GLOBALS.has(expr.text) && resolvesToAmbientGlobal(ctx, expr);
}

/** Evaluate a `.call` argument list before the synthetic IsConstructor throw. */
function emitCallArgumentsBeforeTypeError(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): void {
  const receiver = expr.arguments[0];
  for (const argument of expr.arguments) {
    // The receiver is already proven to be a side-effect-free primitive or
    // ambient callable. Evaluating an ambient `eval` identifier itself would
    // nevertheless select the runtime-eval carrier, introducing a forbidden
    // standalone import; preserve its evaluation semantics by eliding only
    // this proven-pure read.
    if (argument === receiver && isStaticNonConstructorReceiver(ctx, receiver)) continue;
    const argumentType = compileExpression(ctx, fctx, argument);
    if (argumentType !== null) fctx.body.push({ op: "drop" });
  }
}

/** Emit the synchronous IsConstructor TypeError for `Promise.<static>.call`. */
export function tryEmitStandalonePromiseStaticCallTypeError(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  if (!isStandalonePromiseActive(ctx)) return undefined;
  const inner = propAccess.expression;
  if (!ts.isPropertyAccessExpression(inner)) return undefined;
  if (!resolvesToNamedAmbientGlobal(ctx, inner.expression, "Promise")) return undefined;
  const method = inner.name.text;
  if (!PROMISE_STATIC_METHODS.has(method) || !isStaticNonConstructorReceiver(ctx, expr.arguments[0])) return undefined;
  // ArgumentListEvaluation for a spread includes GetIterator/IteratorStep;
  // this narrow arm only emits ordinary argument expressions. Let the generic
  // spread lowering own that protocol rather than dropping the iteration.
  if (expr.arguments.slice(1).some((argument) => ts.isSpreadElement(argument))) return undefined;

  // Evaluate the MemberExpression's argument list before IsConstructor. The
  // static guard replaces the eventual Promise method call, but it must not
  // erase receiver/argument side effects or an earlier argument exception.
  emitCallArgumentsBeforeTypeError(ctx, fctx, expr);

  const message = `Promise.${method} called on a non-constructor`;
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const exnTagIdx = ensureExnTag(ctx);
  addStringConstantGlobal(ctx, message);
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError");
  if (typeErrorCtorIdx === undefined) return undefined;
  fctx.body.push(...stringConstantExternrefInstrs(ctx, message));
  fctx.body.push({ op: "call", funcIdx: typeErrorCtorIdx });
  fctx.body.push({ op: "throw", tagIdx: exnTagIdx });
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}
