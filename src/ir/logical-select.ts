// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The result selection of a short-circuiting `&&` / `||` (#1820): one structured if/else whose right-operand arm
// alone runs the right operand's instructions.

import ts from "typescript";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrInstr, IrValueId } from "./core/nodes.js";
import type { IrType } from "./core/types.js";

/** A literal can select an arm without introducing a union with an unreachable value. */
export function literalLogicalTruth(expr: ts.Expression): boolean | undefined {
  if (ts.isStringLiteral(expr)) return expr.text.length !== 0;
  if (ts.isNumericLiteral(expr)) return Number(expr.text) !== 0;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword || expr.kind === ts.SyntaxKind.NullKeyword) return false;
  return undefined;
}

/**
 * Select on `cond` (the left operand's truth): for `&&` the right operand when it holds, else `lhs`; for `||` the
 * reverse. The empty arm yields the already-materialized `lhs` (the lowerer records it as a cross-block use, like
 * `lowerNullish`'s else arm).
 */
export function emitLogicalSelect(
  builder: IrFunctionBuilder,
  isAnd: boolean,
  operands: { readonly cond: IrValueId; readonly lhs: IrValueId; readonly rhsBody: IrInstr[]; readonly rhs: IrValueId },
  resultType: IrType,
): IrValueId {
  const { cond, lhs, rhsBody, rhs } = operands;
  return isAnd
    ? builder.emitIfElse({ cond, then: rhsBody, thenValue: rhs, else: [], elseValue: lhs, resultType })
    : builder.emitIfElse({ cond, then: [], thenValue: lhs, else: rhsBody, elseValue: rhs, resultType });
}
