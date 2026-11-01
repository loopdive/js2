// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — lower a destructuring declaration whose source is a fresh literal,
// following the plan `binding-pattern-plan.ts` made (the same plan the
// selector admitted). No aggregate is built: each leaf binds a scalar.

import type { ts } from "../ts-api.js";
import type { BindingLeaf, LiteralLeafValue, LiteralPatternPlan } from "./binding-pattern-plan.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irVal, type IrValueId } from "./nodes.js";
import { emitThrowTypeErrorIf } from "./throw-type-error.js";

export interface LiteralPatternLoweringHost {
  readonly builder: IrFunctionBuilder;
  /** Lower a source or default expression to its value. */
  lowerValue(expression: ts.Expression): IrValueId;
  /** Bind one leaf the way its declaration binds a name. */
  bind(leaf: BindingLeaf, value: IrValueId): void;
}

/** Every evaluation in source order, then each step in pattern order. */
export function lowerLiteralPatternPlan(plan: LiteralPatternPlan, host: LiteralPatternLoweringHost): void {
  const values = plan.evaluations.map((expression) => host.lowerValue(expression));
  for (const step of plan.steps) {
    if (step.kind === "nested") lowerLiteralPatternPlan(step.plan, host);
    else if (step.kind === "throw-type-error") throwTypeError(host.builder);
    else if (step.kind === "default") host.bind(step.leaf, host.lowerValue(step.initializer));
    else host.bind(step.leaf, leafValue(step.value, values, host.builder));
  }
}

/**
 * Thrown behind a constant-true branch rather than as a terminator: the leaves
 * after it still bind, so the code the selector admitted after the
 * declaration stays well-formed.
 */
function throwTypeError(builder: IrFunctionBuilder): void {
  const always = builder.emitConst({ kind: "bool", value: true }, irVal({ kind: "i32" }));
  emitThrowTypeErrorIf(builder, always, "Cannot destructure 'null' or 'undefined'");
}

function leafValue(value: LiteralLeafValue, values: readonly IrValueId[], builder: IrFunctionBuilder): IrValueId {
  if (value.kind === "evaluated") return values[value.index]!;
  if (value.kind === "length") return builder.emitConst({ kind: "f64", value: value.value }, irVal({ kind: "f64" }));
  return builder.emitDynUndefined();
}
