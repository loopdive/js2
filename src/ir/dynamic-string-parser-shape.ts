// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

export function isExactDynamicStringReplaceNumberParser(declaration: ts.FunctionDeclaration): boolean {
  if (
    declaration.parameters.length !== 2 ||
    !ts.isIdentifier(declaration.parameters[0]!.name) ||
    !ts.isIdentifier(declaration.parameters[1]!.name) ||
    declaration.body?.statements.length !== 2
  ) {
    return false;
  }
  const stringName = declaration.parameters[0]!.name.text;
  const legacyFlagName = declaration.parameters[1]!.name.text;
  const guard = declaration.body.statements[0]!;
  const tail = declaration.body.statements[1]!;
  if (
    !ts.isIfStatement(guard) ||
    guard.elseStatement !== undefined ||
    !ts.isIdentifier(guard.expression) ||
    guard.expression.text !== legacyFlagName
  ) {
    return false;
  }
  const guardedReturn = ts.isBlock(guard.thenStatement)
    ? guard.thenStatement.statements.length === 1 && ts.isReturnStatement(guard.thenStatement.statements[0]!)
      ? guard.thenStatement.statements[0]
      : undefined
    : ts.isReturnStatement(guard.thenStatement)
      ? guard.thenStatement
      : undefined;
  const parseIntCall = guardedReturn?.expression;
  if (
    !parseIntCall ||
    !ts.isCallExpression(parseIntCall) ||
    !ts.isIdentifier(parseIntCall.expression) ||
    parseIntCall.expression.text !== "parseInt" ||
    parseIntCall.arguments.length !== 2 ||
    !ts.isIdentifier(parseIntCall.arguments[0]!) ||
    parseIntCall.arguments[0]!.text !== stringName ||
    !ts.isNumericLiteral(parseIntCall.arguments[1]!) ||
    parseIntCall.arguments[1]!.text !== "8"
  ) {
    return false;
  }
  if (!ts.isReturnStatement(tail) || !tail.expression || !ts.isCallExpression(tail.expression)) return false;
  const parseFloatCall = tail.expression;
  if (
    !ts.isIdentifier(parseFloatCall.expression) ||
    parseFloatCall.expression.text !== "parseFloat" ||
    parseFloatCall.arguments.length !== 1
  ) {
    return false;
  }
  const replaceCall = parseFloatCall.arguments[0]!;
  return (
    ts.isCallExpression(replaceCall) &&
    ts.isPropertyAccessExpression(replaceCall.expression) &&
    replaceCall.expression.name.text === "replace" &&
    ts.isIdentifier(replaceCall.expression.expression) &&
    replaceCall.expression.expression.text === stringName &&
    replaceCall.arguments.length === 2 &&
    replaceCall.arguments[0]!.kind === ts.SyntaxKind.RegularExpressionLiteral &&
    replaceCall.arguments[0]!.getText() === "/_/g" &&
    ts.isStringLiteralLike(replaceCall.arguments[1]!) &&
    replaceCall.arguments[1]!.text === ""
  );
}
