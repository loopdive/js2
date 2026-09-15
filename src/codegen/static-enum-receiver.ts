// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

export function isNamespaceQualifier(ctx: CodegenContext, expression: ts.Expression): boolean {
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return false;
  const name = ts.isIdentifier(expression) ? expression : expression.name;
  const direct = ctx.oracle.valueDeclarationOf(name);
  if (ts.isIdentifier(expression) && direct !== undefined && ts.isNamespaceImport(direct)) return true;
  const declaration = ctx.oracle.aliasedValueDeclarationOf(name);
  if (declaration === undefined || !ts.isModuleDeclaration(declaration)) return false;
  return ts.isIdentifier(expression) || isNamespaceQualifier(ctx, expression.expression);
}

/** Only static namespace qualifiers may be erased; getters and calls must run. */
export function isStaticEnumReceiver(ctx: CodegenContext, expression: ts.Expression): boolean {
  return (
    ts.isIdentifier(expression) ||
    (ts.isPropertyAccessExpression(expression) && isNamespaceQualifier(ctx, expression.expression))
  );
}
