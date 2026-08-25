// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** (#1004 / #3518 Transaction A) Counted-append string-loop aggregation. */
import { ts } from "../../ts-api.js";
import { countedStringAppendPlanIsCurrent, planCountedStringAppend } from "../../ir/analysis/counted-string-append.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileStatement } from "../shared.js";

/**
 * If `stmt` has the shared checker-backed counted-append proof, emit one
 * `fragment.repeat(N)` plus one concat. The recognizer intentionally lives in
 * `src/ir/analysis`: this handler only consumes and revalidates its plan.
 */
export function tryCompileCountedStringAppend(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForStatement,
): boolean {
  const plan = planCountedStringAppend(ctx, stmt);
  if (!plan || !countedStringAppendPlanIsCurrent(ctx, plan)) return false;

  // N === 0 → loop never runs; the accumulator keeps its value (emit nothing).
  if (plan.tripCount === 0) return true;

  // N === 1 stays on the ordinary loop path; no repeat machinery is useful.
  if (plan.tripCount === 1) return false;

  // Synthesize only after the identity proof has been revalidated. Re-use the
  // real checker-typed accumulator/fragment nodes; analysis never manufactures
  // AST or compilation identities.
  const countLiteral = ts.factory.createNumericLiteral(String(plan.tripCount));
  const repeatProperty = ts.factory.createPropertyAccessExpression(plan.fragmentExpression, "repeat");
  ts.setTextRange(repeatProperty, plan.fragmentExpression);
  (repeatProperty as unknown as { parent: ts.Node }).parent = stmt;
  const repeatCall = ts.factory.createCallExpression(repeatProperty, undefined, [countLiteral]);
  ts.setTextRange(repeatCall, stmt);
  (repeatCall as unknown as { parent: ts.Node }).parent = stmt;
  (countLiteral as unknown as { parent: ts.Node }).parent = repeatCall;

  const assignment = ts.factory.createBinaryExpression(plan.accumulatorRead, ts.SyntaxKind.PlusEqualsToken, repeatCall);
  ts.setTextRange(assignment, stmt);
  (assignment as unknown as { parent: ts.Node }).parent = stmt;
  const expressionStatement = ts.factory.createExpressionStatement(assignment);
  ts.setTextRange(expressionStatement, stmt);
  (expressionStatement as unknown as { parent: ts.Node }).parent = stmt.parent;

  compileStatement(ctx, fctx, expressionStatement);
  return true;
}
