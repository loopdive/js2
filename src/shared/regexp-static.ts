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

/** (#7106 levers R1, R2) The RegExp methods the host-free lanes run through an in-module carrier helper. */
export type RegExpCarrierMethod = "test" | "exec";

/** A carrier method call's parts. */
export interface RegExpCarrierCall {
  readonly receiver: ts.Expression;
  readonly subject: ts.Expression;
  readonly method: RegExpCarrierMethod;
}

/**
 * `re.test(s)` / `re.exec(s)`: a one-argument, non-spread call of a carrier
 * method, split into its parts. Whether `re` is a RegExp is the caller's
 * question (the selector's and the resolver's `isRegExpExpression`).
 */
export function matchRegExpCarrierCall(expr: ts.CallExpression): RegExpCarrierCall | undefined {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || expr.arguments.length !== 1 || ts.isSpreadElement(expr.arguments[0]!))
    return undefined;
  const method = callee.name.text;
  return method === "test" || method === "exec"
    ? { receiver: callee.expression, subject: expr.arguments[0]!, method }
    : undefined;
}
