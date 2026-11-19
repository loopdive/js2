// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import ts from "typescript";
import { nativeRealmGlobalTypeof } from "../runtime/contracts/native-realm-globals.js";

/**
 * (#7106 S1b) The globals every lane provides whose `typeof` the ordinary lane folds: the fold the selector admits
 * and from-ast emits as a string constant. Only an UNSHADOWED ambient binding (checker-proven, not a module
 * binding, not in the local scope) reaches it; a user `var JSON = …` never does. Deliberately short — the
 * namespaces and constructors the test262 harness probes (`typeof JSON !== "undefined"` in assert.js). The tag
 * comes from the realm's global table (#7354 Ty: one table); widening this set changes ordinary-lane output.
 */
const AMBIENT_TYPEOF_NAMES: ReadonlySet<string> = new Set([
  "JSON",
  "Math",
  "Reflect",
  "Object",
  "Function",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Error",
  "TypeError",
  "RangeError",
  "Date",
  "RegExp",
  "Promise",
]);

/** The folded `typeof` tag of an ambient global the ordinary lane provides, or `undefined`. */
export function ambientGlobalTypeofTag(name: string): "object" | "function" | undefined {
  if (!AMBIENT_TYPEOF_NAMES.has(name)) return undefined;
  const tag = nativeRealmGlobalTypeof(name);
  return tag === "object" || tag === "function" ? tag : undefined;
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return expr;
}

/**
 * (#7106 S1b) Fold `typeof <ambient global> (===|!==|==|!=) "<literal>"` (either
 * operand order) to its constant verdict, or `undefined` when the expression
 * is not that shape or the identifier is not an unshadowed ambient global.
 * `tagOf` is the caller's proof (selector / from-ast each own one); the
 * same fold decides which conditional arm is live on both sides, so the
 * selector never admits a dead arm from-ast would then have to lower
 * (`typeof JSON !== "undefined" ? JSON.stringify(v) : '"' + v + '"'` in
 * assert.js — the dead arm is a dynamic `+` the IR does not lower).
 */
export function foldAmbientTypeofComparison(
  expr: ts.Expression,
  tagOf: (identifier: ts.Identifier) => string | undefined,
): boolean | undefined {
  const e = unwrapParens(expr);
  if (!ts.isBinaryExpression(e)) return undefined;
  const op = e.operatorToken.kind;
  const negate =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken
      ? true
      : op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken
        ? false
        : undefined;
  if (negate === undefined) return undefined;
  const left = unwrapParens(e.left);
  const right = unwrapParens(e.right);
  const [probe, literal] = ts.isTypeOfExpression(left) ? [left, right] : [right, left];
  if (!ts.isTypeOfExpression(probe) || !ts.isStringLiteralLike(literal)) return undefined;
  const operand = unwrapParens(probe.expression);
  if (!ts.isIdentifier(operand)) return undefined;
  const tag = tagOf(operand);
  if (tag === undefined) return undefined;
  return (tag === literal.text) !== negate;
}
