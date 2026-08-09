// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { LinearContext, LinearFuncContext } from "./context.js";
import { addLocal } from "./context.js";
import { compileLinearStringRepeatCall } from "./string-repeat.js";

type CompileExpression = (ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression) => void;
type CompileStringLiteral = (ctx: LinearContext, fctx: LinearFuncContext, value: string) => void;

export interface LinearStringMethodCompiler {
  readonly compileExpression: CompileExpression;
  readonly compileExprToI32: CompileExpression;
  readonly compileExprToF64: CompileExpression;
  readonly compileStringLiteral: CompileStringLiteral;
  readonly isStringExpr: (ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression) => boolean;
}

const MAX_FOLDED_REPEAT_BYTES = 1024 * 1024;

function nodeLoc(node: ts.Node): { line: number; column: number } {
  try {
    const sf = node.getSourceFile();
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: line + 1, column: character + 1 };
  } catch {
    return { line: 0, column: 0 };
  }
}

function emitUnsupported(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.CallExpression, message: string): void {
  ctx.errors.push({ message, ...nodeLoc(expr) });
  fctx.body.push({ op: "f64.const", value: 0 });
}

function literalText(expr: ts.Expression): string | undefined {
  return ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) ? expr.text : undefined;
}

function foldLiteralRepeat(receiver: ts.Expression, args: ts.NodeArray<ts.Expression>): string | undefined {
  const value = literalText(receiver);
  const countArg = args[0];
  if (value === undefined || args.length !== 1 || countArg === undefined || !ts.isNumericLiteral(countArg)) {
    return undefined;
  }
  const count = Number(countArg.text);
  if (!Number.isSafeInteger(count) || count < 0) return undefined;
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength !== 0 && count > Math.floor(MAX_FOLDED_REPEAT_BYTES / byteLength)) return undefined;
  return value.repeat(count);
}

function isProvablyAsciiString(ctx: LinearContext, expr: ts.Expression, seen: Set<ts.Symbol> = new Set()): boolean {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    return isProvablyAsciiString(ctx, expr.expression, seen);
  }
  const text = literalText(expr);
  if (text !== undefined) return [...text].every((char) => char.codePointAt(0)! < 0x80);
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "repeat"
  ) {
    return (
      foldLiteralRepeat(expr.expression.expression, expr.arguments) !== undefined &&
      isProvablyAsciiString(ctx, expr.expression.expression, seen)
    );
  }
  if (!ts.isIdentifier(expr)) return false;
  const symbol = ctx.checker.getSymbolAtLocation(expr);
  if (symbol === undefined || seen.has(symbol)) return false;
  const declaration = symbol.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return false;
  }
  seen.add(symbol);
  return isProvablyAsciiString(ctx, declaration.initializer, seen);
}

function compileEndsWith(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  receiver: ts.Expression,
  suffix: ts.Expression,
  compileExpression: CompileExpression,
): void {
  const strLocal = addLocal(fctx, `__ends_str_${fctx.locals.length}`, { kind: "i32" });
  const suffixLocal = addLocal(fctx, `__ends_suffix_${fctx.locals.length}`, { kind: "i32" });
  const strLenIdx = ctx.funcMap.get("__str_len")!;
  const indexOfIdx = ctx.funcMap.get("__str_index_of")!;

  compileExpression(ctx, fctx, receiver);
  fctx.body.push({ op: "local.set", index: strLocal });
  compileExpression(ctx, fctx, suffix);
  fctx.body.push({ op: "local.set", index: suffixLocal });
  fctx.body.push(
    { op: "local.get", index: strLocal },
    { op: "call", funcIdx: strLenIdx },
    { op: "local.get", index: suffixLocal },
    { op: "call", funcIdx: strLenIdx },
    { op: "i32.ge_u" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: strLocal },
        { op: "local.get", index: suffixLocal },
        { op: "local.get", index: strLocal },
        { op: "call", funcIdx: strLenIdx },
        { op: "local.get", index: suffixLocal },
        { op: "call", funcIdx: strLenIdx },
        { op: "i32.sub" },
        { op: "call", funcIdx: indexOfIdx },
        { op: "local.get", index: strLocal },
        { op: "call", funcIdx: strLenIdx },
        { op: "local.get", index: suffixLocal },
        { op: "call", funcIdx: strLenIdx },
        { op: "i32.sub" },
        { op: "i32.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
    { op: "f64.convert_i32_s" },
  );
}

/** Compile a direct-backend String.prototype method, returning whether it handled the call. */
export function compileLinearStringMethodCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
  compiler: LinearStringMethodCompiler,
): boolean {
  const { compileExpression, compileExprToI32, compileExprToF64, compileStringLiteral, isStringExpr } = compiler;
  if (!isStringExpr(ctx, fctx, propAccess.expression)) return false;

  if (methodName === "repeat") {
    const repeated = foldLiteralRepeat(propAccess.expression, expr.arguments);
    if (repeated !== undefined) compileStringLiteral(ctx, fctx, repeated);
    else
      compileLinearStringRepeatCall(
        ctx,
        fctx,
        propAccess.expression,
        expr.arguments[0],
        compileExpression,
        compileExprToF64,
      );
    return true;
  }

  if (methodName === "split") {
    const splitIdx = ctx.funcMap.get("__str_split")!;
    compileExpression(ctx, fctx, propAccess.expression);
    if (expr.arguments.length > 0) compileExpression(ctx, fctx, expr.arguments[0]!);
    else compileStringLiteral(ctx, fctx, "");
    fctx.body.push({ op: "call", funcIdx: splitIdx });
    return true;
  }

  if (methodName === "slice") {
    const sliceIdx = ctx.funcMap.get("__str_slice")!;
    compileExpression(ctx, fctx, propAccess.expression);
    if (expr.arguments.length > 0) compileExprToI32(ctx, fctx, expr.arguments[0]!);
    else fctx.body.push({ op: "i32.const", value: 0 });
    if (expr.arguments.length > 1) compileExprToI32(ctx, fctx, expr.arguments[1]!);
    else {
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__str_len")! });
    }
    fctx.body.push({ op: "call", funcIdx: sliceIdx });
    return true;
  }

  if (methodName === "indexOf") {
    const search = expr.arguments[0];
    if (search === undefined || !isStringExpr(ctx, fctx, search)) {
      emitUnsupported(
        ctx,
        fctx,
        expr,
        "Unsupported String.indexOf() in linear backend: expected a string search value",
      );
      return true;
    }
    compileExpression(ctx, fctx, propAccess.expression);
    compileExpression(ctx, fctx, search);
    if (expr.arguments.length > 1) compileExprToI32(ctx, fctx, expr.arguments[1]!);
    else fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__str_index_of")! }, { op: "f64.convert_i32_s" });
    return true;
  }

  if (methodName === "includes") {
    const search = expr.arguments[0];
    if (search === undefined || !isStringExpr(ctx, fctx, search) || expr.arguments.length > 2) {
      emitUnsupported(
        ctx,
        fctx,
        expr,
        "Unsupported String.includes() in linear backend: expected a string search value",
      );
      return true;
    }
    if (expr.arguments.length === 2 && !isProvablyAsciiString(ctx, propAccess.expression)) {
      emitUnsupported(
        ctx,
        fctx,
        expr,
        "Unsupported String.includes() position in linear backend: receiver needs a compile-time ASCII proof",
      );
      return true;
    }
    compileExpression(ctx, fctx, propAccess.expression);
    compileExpression(ctx, fctx, search);
    if (expr.arguments.length === 2) compileExprToI32(ctx, fctx, expr.arguments[1]!);
    else fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push(
      { op: "call", funcIdx: ctx.funcMap.get("__str_index_of")! },
      { op: "i32.const", value: -1 },
      { op: "i32.ne" },
      { op: "f64.convert_i32_s" },
    );
    return true;
  }

  if (methodName === "startsWith") {
    compileExpression(ctx, fctx, propAccess.expression);
    if (expr.arguments.length > 0) compileExpression(ctx, fctx, expr.arguments[0]!);
    else compileStringLiteral(ctx, fctx, "undefined");
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__str_starts_with")! }, { op: "f64.convert_i32_s" });
    return true;
  }

  if (methodName === "endsWith") {
    const suffix = expr.arguments[0];
    if (suffix === undefined || !isStringExpr(ctx, fctx, suffix) || expr.arguments.length !== 1) {
      emitUnsupported(
        ctx,
        fctx,
        expr,
        "Unsupported String.endsWith() in linear backend: expected one string suffix and the default end position",
      );
      return true;
    }
    compileEndsWith(ctx, fctx, propAccess.expression, suffix, compileExpression);
    return true;
  }

  return false;
}
