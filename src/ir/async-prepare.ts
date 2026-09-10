// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
export {
  prepareSequentialCountedLoopIrFunction,
  prepareFinalMainIrFunction,
  prepareSuspendingIrFunction,
  prepareSingleAwaitIrFunction,
} from "./async-prepare-ir.js";
export type { PreparedSingleAwaitIrFunction } from "./async-prepare-ir.js";

/**
 * First production suspension shape. It is deliberately syntax-small so the
 * selector and the post-build IR transform can prove the same two-state graph:
 *
 *   const value = await expression;
 *   return value;
 */
export function isSingleAwaitReturnAsyncCandidate(fn: ts.FunctionLikeDeclaration): boolean {
  if (!ts.isFunctionDeclaration(fn) || fn.asteriskToken || !fn.body) return false;
  if (!fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  if (fn.body.statements.length !== 2) return false;
  const declarationStatement = fn.body.statements[0];
  const returned = fn.body.statements[1];
  if (
    !declarationStatement ||
    !ts.isVariableStatement(declarationStatement) ||
    declarationStatement.declarationList.declarations.length !== 1 ||
    !returned ||
    !ts.isReturnStatement(returned) ||
    !returned.expression ||
    !ts.isIdentifier(returned.expression)
  ) {
    return false;
  }
  const declaration = declarationStatement.declarationList.declarations[0]!;
  return (
    ts.isIdentifier(declaration.name) &&
    declaration.initializer !== undefined &&
    ts.isAwaitExpression(declaration.initializer) &&
    returned.expression.text === declaration.name.text
  );
}
