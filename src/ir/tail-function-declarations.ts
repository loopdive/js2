// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";

/** These declarations occupy only TypeScript's type namespace. */
export function isErasedLocalTypeDeclaration(statement: ts.Statement): boolean {
  return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
}

/**
 * Function declarations following a terminal return are still in its scope.
 * Present that declaration-only suffix before the return to both IR consumers.
 * Keep original nodes/identities and never move an executable statement.
 * Ignore type-only declarations, including those interleaved in the suffix.
 */
export function orderTailFunctionDeclarations(statements: readonly ts.Statement[]): readonly ts.Statement[] {
  if (statements.some(isErasedLocalTypeDeclaration)) {
    statements = statements.filter((statement) => !isErasedLocalTypeDeclaration(statement));
  }
  let tail = statements.length - 1;
  while (tail >= 0 && ts.isFunctionDeclaration(statements[tail]!)) tail--;
  if (tail < 0 || tail === statements.length - 1 || !ts.isReturnStatement(statements[tail]!)) return statements;
  return [...statements.slice(0, tail), ...statements.slice(tail + 1), statements[tail]!];
}
