// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * `var x = <expr> != null` — the null-guard alias fact, split out of the
 * variable-statement driver (#4555, extraction only).
 *
 * A declaration whose initializer is a nullish comparison (`v !== null`,
 * `v != undefined`, …) records WHICH branch the guard narrows and whether the
 * checker's type for the compared binding actually contains the nullish member
 * being excluded. Purely syntactic + checker-typed analysis with no emission,
 * so it belongs next to the other binding predicates rather than inside the
 * statement compiler.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext, NullGuardFact, NullishExclusion } from "../context/types.js";

function nullishLiteralKind(expr: ts.Expression): "null" | "undefined" | null {
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return "undefined";
  if (ts.isIdentifier(expr) && expr.text === "undefined") return "undefined";
  return null;
}

function nullishPresenceOfType(type: ts.Type): { hasNull: boolean; hasUndefined: boolean } {
  let hasNull = false;
  let hasUndefined = false;
  const parts = type.isUnion() ? type.types : [type];
  for (const part of parts) {
    if (part.flags & ts.TypeFlags.Null) hasNull = true;
    if (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) hasUndefined = true;
  }
  return { hasNull, hasUndefined };
}

function excludesAllNullish(type: ts.Type, excludes: NullishExclusion): boolean {
  const presence = nullishPresenceOfType(type);
  if (!presence.hasNull && !presence.hasUndefined) return false;
  if (presence.hasNull && excludes === "undefined") return false;
  if (presence.hasUndefined && excludes === "null") return false;
  return true;
}

export function detectNullGuardAlias(ctx: CodegenContext, expr: ts.Expression): NullGuardFact | null {
  if (!ts.isBinaryExpression(expr)) return null;
  const op = expr.operatorToken.kind;
  const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
  const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = isStrictNeq || isLooseNeq;
  const isEq = isStrictEq || isLooseEq;
  if (!isNeq && !isEq) return null;

  const rightNullish = nullishLiteralKind(expr.right);
  const leftNullish = nullishLiteralKind(expr.left);
  if (!rightNullish && !leftNullish) return null;

  const comparedNullish = rightNullish ?? leftNullish;
  const nonNullSide = rightNullish ? expr.left : expr.right;
  if (!ts.isIdentifier(nonNullSide)) return null;
  const excludes: NullishExclusion = isLooseEq || isLooseNeq ? "nullish" : comparedNullish!;
  return {
    varName: nonNullSide.text,
    narrowedBranch: isNeq ? "then" : "else",
    excludes,
    provesNonNull: excludesAllNullish(ctx.checker.getTypeAtLocation(nonNullSide), excludes),
  };
}
