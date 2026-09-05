// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Narrow compile-away paths for dynamically assembled comment-only eval source. */
import { ts, forEachChild } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { ensureNativeCharCodeAtHelper } from "../char-code-at-helpers.js";
import { popBody, pushBody } from "../context/bodies.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { coerceType, compileExpression, type InnerResult, valTypesMatch } from "../shared.js";
import { emitUndefined } from "./late-imports.js";

function isGlobalIdentifier(ctx: CodegenContext, ident: ts.Identifier): boolean {
  const declarations = ctx.oracle.declarationsOf(ident);
  if (declarations.length === 0) return true;
  return declarations.every((decl) => decl.getSourceFile().isDeclarationFile);
}

function sourceReassignsFromCharCode(anchor: ts.Node): boolean {
  const sourceFile = anchor.getSourceFile();
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ((ts.isPropertyAccessExpression(node.left) && node.left.name.text === "fromCharCode") ||
        (ts.isElementAccessExpression(node.left) &&
          ts.isStringLiteralLike(node.left.argumentExpression) &&
          node.left.argumentExpression.text === "fromCharCode"))
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function sourceReassignsIdentifier(anchor: ts.Node, name: string): boolean {
  const sourceFile = anchor.getSourceFile();
  let found = false;
  const targetMentionsName = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return node.text === name;
    let mentions = false;
    forEachChild(node, (child) => {
      if (!mentions && targetMentionsName(child)) mentions = true;
    });
    return mentions;
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        targetMentionsName(node.left)) ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
        targetMentionsName(node.operand))
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isSingleFromCharCodeIdentifier(ctx: CodegenContext, ident: ts.Identifier): boolean {
  const declarations = ctx.oracle.declarationsOf(ident);
  if (declarations.length !== 1 || !ts.isVariableDeclaration(declarations[0])) return false;
  let init = declarations[0].initializer;
  while (init && ts.isParenthesizedExpression(init)) init = init.expression;
  return !!(
    init &&
    ts.isCallExpression(init) &&
    init.arguments.length === 1 &&
    ts.isPropertyAccessExpression(init.expression) &&
    init.expression.name.text === "fromCharCode" &&
    ts.isIdentifier(init.expression.expression) &&
    init.expression.expression.text === "String" &&
    isGlobalIdentifier(ctx, init.expression.expression)
  );
}

function emitBranch(fctx: FunctionContext, emit: () => void): Instr[] {
  const saved = pushBody(fctx);
  emit();
  const body = fctx.body;
  popBody(fctx, saved);
  return body;
}

function trySingleLineCommentEval(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
): InnerResult | undefined {
  if (
    !ts.isBinaryExpression(arg) ||
    arg.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
    !ts.isStringLiteralLike(arg.right)
  ) {
    return undefined;
  }
  const tail = /^([A-Za-z_$][\w$]*) = -1$/.exec(arg.right.text);
  if (!tail) return undefined;

  let prefix = arg.left;
  while (ts.isParenthesizedExpression(prefix)) prefix = prefix.expression;
  if (
    !ts.isBinaryExpression(prefix) ||
    prefix.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
    !ts.isStringLiteralLike(prefix.left) ||
    prefix.left.text !== "//var "
  ) {
    return undefined;
  }
  let middle = prefix.right;
  while (ts.isParenthesizedExpression(middle)) middle = middle.expression;
  if (
    !ts.isIdentifier(middle) ||
    !isSingleFromCharCodeIdentifier(ctx, middle) ||
    sourceReassignsIdentifier(arg, middle.text) ||
    sourceReassignsFromCharCode(arg)
  ) {
    return undefined;
  }

  const anyString: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  const middleType = compileExpression(ctx, fctx, middle, anyString);
  if (middleType === null) return undefined;
  if (!valTypesMatch(middleType, anyString)) coerceType(ctx, fctx, middleType, anyString);
  const charCodeAtIdx = ensureNativeCharCodeAtHelper(ctx);
  if (charCodeAtIdx === null) return undefined;
  fctx.body.push({ op: "i32.const", value: 0 }, { op: "call", funcIdx: charCodeAtIdx });
  const codeLocal = allocLocal(fctx, `__eval_comment_cu_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: codeLocal });

  const isTerminator: Instr[] = [];
  for (const codeUnit of [0x0a, 0x0d, 0x2028, 0x2029]) {
    isTerminator.push(
      { op: "local.get", index: codeLocal },
      { op: "f64.const", value: codeUnit },
      { op: "f64.eq" },
      ...(isTerminator.length === 0 ? [] : ([{ op: "i32.or" }] satisfies Instr[])),
    );
  }

  const then = emitBranch(fctx, () => {
    const assignment = ts.factory.createBinaryExpression(
      ts.factory.createIdentifier(tail[1]!),
      ts.factory.createToken(ts.SyntaxKind.EqualsToken),
      ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, ts.factory.createNumericLiteral(1)),
    );
    const result = compileExpression(ctx, fctx, assignment, { kind: "externref" });
    if (result !== null && result.kind !== "externref") coerceType(ctx, fctx, result, { kind: "externref" });
  });
  const otherwise = emitBranch(fctx, () => emitUndefined(ctx, fctx));
  fctx.body.push(...isTerminator, {
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then,
    else: otherwise,
  });
  return { kind: "externref" };
}

/**
 * `eval("/*var " + String.fromCharCode(codeUnit) + "xx = 1*\/\")` is
 * comment-only source for every UTF-16 code unit. Preserve construction of the
 * argument (and therefore its observable evaluation order), but avoid sending
 * 65,536 distinct strings through the runtime compiler.
 */
export function tryEvalAsCommentPeephole(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (expr.arguments.length !== 1) return undefined;
  let arg = expr.arguments[0]!;
  while (ts.isParenthesizedExpression(arg)) arg = arg.expression;
  const singleLine = trySingleLineCommentEval(ctx, fctx, arg);
  if (singleLine !== undefined) return singleLine;
  if (
    !ts.isBinaryExpression(arg) ||
    arg.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
    !ts.isStringLiteralLike(arg.right) ||
    arg.right.text !== "xx = 1*/"
  ) {
    return undefined;
  }

  let prefix = arg.left;
  while (ts.isParenthesizedExpression(prefix)) prefix = prefix.expression;
  if (
    !ts.isBinaryExpression(prefix) ||
    prefix.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
    !ts.isStringLiteralLike(prefix.left) ||
    prefix.left.text !== "/*var "
  ) {
    return undefined;
  }

  let middle = prefix.right;
  while (ts.isParenthesizedExpression(middle)) middle = middle.expression;
  if (
    !ts.isCallExpression(middle) ||
    middle.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(middle.expression) ||
    middle.expression.name.text !== "fromCharCode" ||
    !ts.isIdentifier(middle.expression.expression) ||
    middle.expression.expression.text !== "String" ||
    !isGlobalIdentifier(ctx, middle.expression.expression) ||
    sourceReassignsFromCharCode(expr)
  ) {
    return undefined;
  }

  const argType = compileExpression(ctx, fctx, arg);
  if (argType !== null) fctx.body.push({ op: "drop" });
  emitUndefined(ctx, fctx);
  return { kind: "externref" };
}
