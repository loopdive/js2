// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7106 lever R) The static RegExp constructions the IR lowers as one
// `extern.regex`: a `/pattern/flags` literal, and `new RegExp(p?, f?)` over
// string literals. The selector and the builder read the same pair here.

import { ts } from "../ts-api.js";
import { isUnshadowedLibBinding } from "./ambient-intrinsics.js";

/** Split a RegExp literal's text (`/\d+/gi`) at its last `/` into pattern and flags. */
export function parseRegExpLiteralText(text: string): { pattern: string; flags: string } {
  const lastSlash = text.lastIndexOf("/");
  return { pattern: text.slice(1, lastSlash), flags: text.slice(lastSlash + 1) };
}

/**
 * The (pattern, flags) of a static construction, or undefined. `new RegExp()`
 * is the empty pattern. The `RegExp` it names must be the built-in
 * (`isUnshadowedLibBinding`); the selector and the builder pass the same
 * module-binding resolver's `isLibOnlyBinding`.
 */
export function staticRegExpPair(
  expr: ts.Expression,
  isLibOnlyBinding: (node: ts.Identifier) => boolean,
): { pattern: string; flags: string } | undefined {
  if (expr.kind === ts.SyntaxKind.RegularExpressionLiteral) return parseRegExpLiteralText(expr.getText());
  if (
    !ts.isNewExpression(expr) ||
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== "RegExp" ||
    !isUnshadowedLibBinding(expr.expression, isLibOnlyBinding)
  ) {
    return undefined;
  }
  const texts: string[] = [];
  for (const arg of expr.arguments ?? []) {
    if (!ts.isStringLiteralLike(arg)) return undefined;
    texts.push(arg.text);
  }
  return texts.length > 2 ? undefined : { pattern: texts[0] ?? "", flags: texts[1] ?? "" };
}
