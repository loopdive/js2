// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isGlobalObjectExpr } from "./global-environment.js";
import { skipTransparentExpressions } from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";

function isUnshadowedRealmGlobal(ctx: CodegenContext, fctx: FunctionContext, operand: ts.Expression): boolean {
  if (!isGlobalObjectExpr(ctx, fctx, operand)) return false;
  const bare = skipTransparentExpressions(operand);
  return !(ts.isIdentifier(bare) && fctx.localMap.has("globalThis"));
}

/** Static `typeof globalThis`/top-level-this fold, or undefined to decline. */
export function tryCompileRealmGlobalTypeof(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
): ValType | null | undefined {
  return isUnshadowedRealmGlobal(ctx, fctx, operand) ? compileStringLiteral(ctx, fctx, "object") : undefined;
}

/** Static realm-global typeof comparison, or undefined to decline. */
export function tryCompileRealmGlobalTypeofComparison(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
  expected: string,
  isEq: boolean,
): ValType | undefined {
  if (!isUnshadowedRealmGlobal(ctx, fctx, operand)) return undefined;
  return emitStaticTypeofComparison(fctx, "object", expected, isEq);
}

/** Emit a known typeof-string comparison as an i32 constant. */
export function emitStaticTypeofComparison(
  fctx: FunctionContext,
  actual: string,
  expected: string,
  isEq: boolean,
): ValType {
  const matches = actual === expected;
  fctx.body.push({ op: "i32.const", value: isEq ? (matches ? 1 : 0) : matches ? 0 : 1 });
  return { kind: "i32" };
}

/** Static typeof fold for the built-in Math namespace's members. */
export function tryCompileMathMemberTypeof(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
): ValType | null | undefined {
  if (
    !ts.isPropertyAccessExpression(operand) ||
    !ts.isIdentifier(operand.expression) ||
    operand.expression.text !== "Math"
  ) {
    return undefined;
  }
  const constants = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);
  return compileStringLiteral(ctx, fctx, constants.has(operand.name.text) ? "number" : "function");
}
