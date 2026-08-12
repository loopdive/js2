// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { TypeOracle } from "../checker/oracle.js";
import { ts } from "../ts-api.js";

export type GlobalParseBuiltinName = "parseInt" | "parseFloat";

const GLOBAL_PARSE_BUILTINS = new Set<GlobalParseBuiltinName>(["parseInt", "parseFloat"]);

/**
 * Follow a variable-alias chain to the realm's global parseInt/parseFloat.
 *
 * Name-only matching is unsound in a multi-module graph: lodash-es contains
 * both `var freeParseInt = parseInt` (the ambient builtin) and an exported
 * function also named `parseInt`. The checker symbol is the source of truth
 * that distinguishes those bindings.
 */
export function resolveGlobalParseBuiltin(
  identifier: ts.Identifier,
  oracle: TypeOracle,
  seen: Set<ts.Declaration> = new Set(),
): GlobalParseBuiltinName | undefined {
  if (GLOBAL_PARSE_BUILTINS.has(identifier.text as GlobalParseBuiltinName)) {
    const declaration = oracle.valueDeclarationOf(identifier);
    return declaration === undefined || declaration.getSourceFile().isDeclarationFile
      ? (identifier.text as GlobalParseBuiltinName)
      : undefined;
  }

  const declaration = oracle.valueDeclarationOf(identifier);
  if (!declaration || seen.has(declaration) || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return undefined;
  }
  seen.add(declaration);

  let initializer: ts.Expression = declaration.initializer;
  while (
    ts.isParenthesizedExpression(initializer) ||
    ts.isAsExpression(initializer) ||
    ts.isNonNullExpression(initializer) ||
    ts.isSatisfiesExpression(initializer) ||
    ts.isTypeAssertionExpression(initializer)
  ) {
    initializer = initializer.expression;
  }
  return ts.isIdentifier(initializer) ? resolveGlobalParseBuiltin(initializer, oracle, seen) : undefined;
}
