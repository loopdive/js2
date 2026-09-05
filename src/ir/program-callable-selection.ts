// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrProgramCallableUse } from "./program-callable-bindings.js";
import { ts } from "../ts-api.js";

declare module "./select.js" {
  interface IrSelectionOptions {
    /** Exact whole-program fixed-target call evidence for M1A. */
    readonly resolveProgramCallableUse?: (call: ts.CallExpression) => IrProgramCallableUse | undefined;
  }
}

export function programCallablePhase1Verdict(
  resolve: ((call: ts.CallExpression) => IrProgramCallableUse | undefined) | undefined,
  expr: ts.CallExpression,
  preambleIsBuildable: () => boolean,
  acceptArgument: (argument: ts.Expression) => boolean,
  rejectDynamicShape: () => boolean,
  rejectSpread: (spread: ts.SpreadElement) => boolean,
): boolean | undefined {
  if (!preambleIsBuildable()) return false;
  if (!resolve?.(expr)) return undefined;
  if (expr.questionDotToken || expr.typeArguments?.length) return rejectDynamicShape();
  for (const argument of expr.arguments) {
    if (ts.isSpreadElement(argument)) return rejectSpread(argument);
    if (!acceptArgument(argument)) return false;
  }
  return true;
}

export function visitProgramCallableUse(
  resolve: ((call: ts.CallExpression) => IrProgramCallableUse | undefined) | undefined,
  node: ts.CallExpression,
  visit: (node: ts.Node) => void,
  markUnsupported: () => void,
): boolean {
  if (!resolve?.(node)) return false;
  if (node.questionDotToken || node.typeArguments?.length || node.arguments.some(ts.isSpreadElement)) {
    markUnsupported();
    return true;
  }
  for (const argument of node.arguments) visit(argument);
  return true;
}
