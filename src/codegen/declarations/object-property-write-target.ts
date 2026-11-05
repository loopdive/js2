// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Exact literal-property targets and lexical preflight for carrier writes. */
import { ts } from "../../ts-api.js";
import type { TypeOracle } from "../../checker/oracle.js";

function unwrapPropertyTarget(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

/** A literal key has a stable JavaScript property name; other keys are unknown. */
export function staticObjectWriteKey(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  expr = unwrapPropertyTarget(expr);
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) {
    const value = Number(expr.text);
    return Number.isFinite(value) ? String(value) : undefined;
  }
  return undefined;
}

/**
 * Follow only the exact binding's own literal initializer. An alias, spread,
 * accessor or unresolved computed name cannot prove which field receives the
 * write. Returning no declaration keeps those receivers on their existing path.
 */
export function literalObjectWriteDeclaration(
  oracle: TypeOracle,
  receiver: ts.Expression,
  key: string,
): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined {
  receiver = unwrapPropertyTarget(receiver);
  if (!ts.isIdentifier(receiver)) return undefined;
  const declarations = oracle.declarationsOf(receiver);
  if (declarations.length !== 1) return undefined;
  const binding = declarations[0];
  if (!binding || !ts.isVariableDeclaration(binding) || !binding.initializer) return undefined;
  const literal = unwrapPropertyTarget(binding.initializer);
  if (!ts.isObjectLiteralExpression(literal)) return undefined;
  let target: ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined;
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
    const name = property.name;
    const propertyKey = ts.isIdentifier(name)
      ? name.text
      : staticObjectWriteKey(ts.isComputedPropertyName(name) ? name.expression : name);
    if (propertyKey === undefined) return undefined;
    if (propertyKey === key) {
      if (target) return undefined;
      target = property;
    }
  }
  return target;
}

/** Skip the AST walk only when no direct dot or bracket assignment can occur. */
export function sourceHasObjectPropertyWrite(sourceFile: ts.SourceFile): boolean {
  // Avoid an AST walk for files that cannot contain a direct property write.
  // The scanner skips comments and strings, so this is a conservative lexical
  // preflight: every direct property write has either `. <property-name> =` or
  // `[<key>] =`. The latter is admitted because a numeric/string literal key
  // is still a fixed struct field at codegen time.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, sourceFile.text);
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.DotToken) {
      scanner.scan();
      const next = scanner.scan();
      if (next === ts.SyntaxKind.EqualsToken) return true;
      token = next;
      continue;
    }
    if (token === ts.SyntaxKind.OpenBracketToken) {
      let depth = 1;
      let next = scanner.scan();
      while (next !== ts.SyntaxKind.EndOfFileToken && depth > 0) {
        if (next === ts.SyntaxKind.OpenBracketToken) depth++;
        else if (next === ts.SyntaxKind.CloseBracketToken) depth--;
        next = scanner.scan();
      }
      if (depth === 0 && next === ts.SyntaxKind.EqualsToken) return true;
      token = next;
      continue;
    }
    token = scanner.scan();
  }
  return false;
}
