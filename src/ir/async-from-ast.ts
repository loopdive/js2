// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irVal, type IrFuncRef, type IrType, type IrValueId } from "./nodes.js";
import { coerceIrValueToExternref } from "./value-coercion.js";

export interface PreparedAsyncPromiseAllPlan {
  readonly target: IrFuncRef;
  readonly resultType: IrType;
  /** Native projection keeps the pending Promise vector in its physical carrier. */
  readonly argumentType?: IrType;
}

/** Prepared-async evidence consumed by AST-to-IR lowering. */
export interface PreparedAsyncFromAstResolver {
  readonly preparedAsyncPromiseVectorLocal?: (declaration: ts.VariableDeclaration) => boolean;
  readonly preparedAsyncPromiseAllPlan?: (call: ts.CallExpression) => PreparedAsyncPromiseAllPlan | null;
  readonly preparedAsyncThenableResultType?: (call: ts.CallExpression) => IrType | undefined;
  readonly preparedAsyncDateNowTarget?: (call: ts.CallExpression) => IrFuncRef | null;
  readonly preparedAsyncNumberToStringTarget?: (call: ts.CallExpression) => IrFuncRef | null;
  readonly preparedAsyncConsoleTarget?: (call: ts.CallExpression) => IrFuncRef | null;
  readonly preparedAsyncConcatFiveTarget?: (expression: ts.Expression) => IrFuncRef | null;
}

/** Resume type for an awaited prepared combinator, if the exact call is owned. */
export function preparedAsyncAwaitResultType(
  expression: ts.Expression,
  resolver: PreparedAsyncFromAstResolver | undefined,
): IrType | undefined {
  if (!ts.isCallExpression(expression)) return undefined;
  return (
    resolver?.preparedAsyncPromiseAllPlan?.(expression)?.resultType ??
    resolver?.preparedAsyncThenableResultType?.(expression)
  );
}

/** Lower the exact prepared Promise.all provider boundary or decline it. */
export function tryLowerPreparedAsyncPromiseAll(input: {
  readonly expression: ts.CallExpression;
  readonly statementPosition: boolean;
  readonly resolver: PreparedAsyncFromAstResolver | undefined;
  readonly builder: IrFunctionBuilder;
  readonly functionName: string;
  readonly lowerExpression: (expression: ts.Expression, expected: IrType) => IrValueId;
}): IrValueId | undefined {
  const plan = input.resolver?.preparedAsyncPromiseAllPlan?.(input.expression);
  if (!plan) return undefined;
  if (
    input.statementPosition ||
    input.expression.arguments.length !== 1 ||
    ts.isSpreadElement(input.expression.arguments[0]!)
  ) {
    throw new Error(`ir/from-ast: prepared Promise.all call shape diverged in ${input.functionName}`);
  }

  const externref = irVal({ kind: "externref" });
  const result = (() => {
    if (plan.argumentType) {
      const iterable = input.lowerExpression(input.expression.arguments[0]!, plan.argumentType);
      return input.builder.emitCall(plan.target, [iterable], externref);
    }
    const thisArg = input.builder.emitConst({ kind: "null", ty: externref }, externref);
    const iterable = coerceIrValueToExternref(
      input.builder,
      input.lowerExpression(input.expression.arguments[0]!, externref),
    );
    const directCall = input.builder.emitConst({ kind: "i32", value: 1 }, irVal({ kind: "i32" }));
    return input.builder.emitCall(plan.target, [thisArg, iterable, directCall], externref);
  })();
  if (result === null)
    throw new Error(`ir/from-ast: prepared Promise.all provider returned void in ${input.functionName}`);
  return result;
}
