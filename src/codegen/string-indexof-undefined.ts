// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression } from "./shared.js";
import { emitUndefined } from "./expressions/late-imports.js";

/**
 * #3763 — compile the legacy ES5 `indexOf(x); var x;` search value as actual
 * JavaScript `undefined`.
 *
 * TypeScript types the uninitialised hoisted binding as `any`, while the Wasm
 * externref representation otherwise collapses it to JS `null`. The proof is
 * deliberately narrow: the declaration must follow this first use, have no
 * initializer, and be a `var`. Any preceding use makes the helper decline.
 */
export function tryCompileIndexOfHoistedUndefinedSearch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
): boolean {
  let value = arg;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isTypeAssertionExpression(value)
  ) {
    value = value.expression;
  }
  if (!ts.isIdentifier(value) || value.text === "undefined") return false;

  const declaration = ctx.oracle.variableDeclarationOf(value);
  if (!declaration || declaration.initializer) return false;
  if (!ts.isVariableDeclarationList(declaration.parent)) return false;
  if ((declaration.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) return false;

  const sourceFile = arg.getSourceFile();
  const before = arg.getStart(sourceFile);
  if (declaration.getStart(sourceFile) <= before) return false;
  let hasPrecedingUse = false;
  const visit = (node: ts.Node): void => {
    if (hasPrecedingUse || node.getStart(sourceFile) >= before) return;
    if (ts.isIdentifier(node) && ctx.oracle.variableDeclarationOf(node) === declaration) {
      hasPrecedingUse = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (hasPrecedingUse) return false;

  const argResult = compileExpression(ctx, fctx, arg);
  if (argResult) fctx.body.push({ op: "drop" });
  emitUndefined(ctx, fctx);
  return true;
}
